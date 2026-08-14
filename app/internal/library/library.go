// Package library is the book/chapter/trash/asset business logic, ported from
// server/src/services/library.ts. EPUB-engine functions that need the parser
// or builder (importEpub, exportBook, splitBook, renderChapter, uploadCover)
// are intentionally out of scope here and remain served by the Express proxy
// until their phases land.
package library

import (
	"crypto/rand"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"epubmaker-desktop/internal/db"
	"epubmaker-desktop/internal/epub"
	"epubmaker-desktop/internal/html"
	"epubmaker-desktop/internal/mime"
	"epubmaker-desktop/internal/storage"
)

/* ----------------------------- types ----------------------------- */

type BookDTO struct {
	ID           string  `json:"id"`
	Title        string  `json:"title"`
	Author       string  `json:"author"`
	Language     string  `json:"language"`
	Publisher    string  `json:"publisher"`
	Description  string  `json:"description"`
	Identifier   string  `json:"identifier"`
	CoverHref    *string `json:"coverHref"`
	CoverURL     *string `json:"coverUrl"`
	SourceName   *string `json:"sourceName"`
	ChapterCount int     `json:"chapterCount"`
	DeletedAt    *string `json:"deletedAt"`
	CreatedAt    string  `json:"createdAt"`
	UpdatedAt    string  `json:"updatedAt"`
}

type ChapterDTO struct {
	ID        string `json:"id"`
	BookID    string `json:"bookId"`
	Index     int    `json:"index"`
	Title     string `json:"title"`
	Href      string `json:"href"`
	UpdatedAt string `json:"updatedAt"`
}

type BookRow struct {
	ID          string
	Title       string
	Author      string
	Language    string
	Publisher   string
	Description string
	Identifier  string
	CoverHref   sql.NullString
	SourceName  sql.NullString
	DeletedAt   sql.NullString
	CreatedAt   string
	UpdatedAt   string
	// TOC is the hierarchical table-of-contents tree serialized as JSON.
	// Empty for books imported before hierarchical TOC support.
	TOC string
}

type ChapterRow struct {
	ID        string
	BookID    string
	Idx       int
	Title     string
	Href      string
	CreatedAt string
	UpdatedAt string
}

type AssetRow struct {
	ID        string
	BookID    string
	Href      string
	MediaType string
	Size      int64
}

type TrashItem struct {
	ID          string  `json:"id"`
	Title       string  `json:"title"`
	Author      string  `json:"author"`
	CoverURL    *string `json:"coverUrl"`
	DeletedAt   *string `json:"deletedAt"`
	Recoverable bool    `json:"recoverable"`
	DirName     string  `json:"dirName"`
}

type ImageAsset struct {
	Href string `json:"href"`
	Size int64  `json:"size"`
	URL  string `json:"url"`
}

type ChapterSource struct {
	Title string `json:"title"`
	HTML  string `json:"html"`
}

// BookPatch / ChapterPatch / ChapterCreateOpts map the JSON request bodies.
type BookPatch struct {
	Title       *string `json:"title"`
	Author      *string `json:"author"`
	Language    *string `json:"language"`
	Publisher   *string `json:"publisher"`
	Description *string `json:"description"`
	Identifier  *string `json:"identifier"`
	CoverHref   *string `json:"coverHref"`
}

type ChapterPatch struct {
	Title *string `json:"title"`
	HTML  *string `json:"html"`
}

type ChapterCreateOpts struct {
	Title          string `json:"title"`
	HTML           string `json:"html"`
	AfterChapterID string `json:"afterChapterId"`
}

/* ----------------------------- helpers ----------------------------- */

var uuidRe = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}`)

func uid() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

func nowIso() string { return time.Now().UTC().Format(time.RFC3339) }

func nullStr(ns sql.NullString) *string {
	if !ns.Valid {
		return nil
	}
	return &ns.String
}

func orDefault(s, def string) string {
	if s == "" {
		return def
	}
	return s
}

func contains(s []string, v string) bool {
	for _, x := range s {
		if x == v {
			return true
		}
	}
	return false
}

func dirExists(p string) bool {
	info, err := os.Stat(p)
	return err == nil && info.IsDir()
}

type scanner interface{ Scan(dest ...any) error }

func scanBook(s scanner) (BookRow, error) {
	var b BookRow
	err := s.Scan(&b.ID, &b.Title, &b.Author, &b.Language, &b.Publisher,
		&b.Description, &b.Identifier, &b.CoverHref, &b.SourceName,
		&b.CreatedAt, &b.UpdatedAt, &b.DeletedAt, &b.TOC)
	return b, err
}

func scanChapter(s scanner) (ChapterRow, error) {
	var c ChapterRow
	err := s.Scan(&c.ID, &c.BookID, &c.Idx, &c.Title, &c.Href, &c.CreatedAt, &c.UpdatedAt)
	return c, err
}

func scanAsset(s scanner) (AssetRow, error) {
	var a AssetRow
	err := s.Scan(&a.ID, &a.BookID, &a.Href, &a.MediaType, &a.Size)
	return a, err
}

// DataURL builds an inline data: URL for binary content (cover images,
// chapter assets). With Wails bindings there is no asset HTTP server, so every
// binary the frontend needs must be embedded directly in the JSON payload.
func DataURL(mediaType string, data []byte) string {
	if mediaType == "" {
		mediaType = "application/octet-stream"
	}
	return "data:" + mediaType + ";base64," + base64.StdEncoding.EncodeToString(data)
}

func toBookDTO(r BookRow, chapterCount int) BookDTO {
	var coverURL *string
	if r.CoverHref.Valid && r.CoverHref.String != "" {
		if buf, err := storage.ReadContent(r.ID, r.CoverHref.String); err == nil {
			u := DataURL(mime.GuessMediaType(r.CoverHref.String), buf)
			coverURL = &u
		}
	}
	return BookDTO{
		ID:           r.ID,
		Title:        r.Title,
		Author:       r.Author,
		Language:     r.Language,
		Publisher:    r.Publisher,
		Description:  r.Description,
		Identifier:   r.Identifier,
		CoverHref:    nullStr(r.CoverHref),
		CoverURL:     coverURL,
		SourceName:   nullStr(r.SourceName),
		ChapterCount: chapterCount,
		DeletedAt:    nullStr(r.DeletedAt),
		CreatedAt:    r.CreatedAt,
		UpdatedAt:    r.UpdatedAt,
	}
}

func toChapterDTO(c ChapterRow) ChapterDTO {
	return ChapterDTO{
		ID:        c.ID,
		BookID:    c.BookID,
		Index:     c.Idx,
		Title:     c.Title,
		Href:      c.Href,
		UpdatedAt: c.UpdatedAt,
	}
}

/* ----------------------------- queries ----------------------------- */

func GetBookRow(id string) (*BookRow, error) {
	d, err := db.Open()
	if err != nil {
		return nil, err
	}
	row := d.QueryRow(`SELECT * FROM books WHERE id = ?`, id)
	b, err := scanBook(row)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &b, nil
}

func ListBooks(keyword string) ([]BookDTO, error) {
	d, err := db.Open()
	if err != nil {
		return nil, err
	}
	var rows *sql.Rows
	if keyword != "" {
		kw := "%" + keyword + "%"
		rows, err = d.Query(
			`SELECT b.* FROM books b
			 LEFT JOIN reading_progress r ON r.book_id = b.id
			 WHERE b.deleted_at IS NULL AND (b.title LIKE ? OR b.author LIKE ?)
			 ORDER BY COALESCE(r.updated_at, b.updated_at) DESC`,
			kw, kw)
	} else {
		rows, err = d.Query(
			`SELECT b.* FROM books b
			 LEFT JOIN reading_progress r ON r.book_id = b.id
			 WHERE b.deleted_at IS NULL
			 ORDER BY COALESCE(r.updated_at, b.updated_at) DESC`)
	}
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	books := []BookRow{}
	for rows.Next() {
		b, e := scanBook(rows)
		if e != nil {
			return nil, e
		}
		books = append(books, b)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	counts := map[string]int{}
	crows, err := d.Query(`SELECT book_id, COUNT(*) AS n FROM chapters GROUP BY book_id`)
	if err != nil {
		return nil, err
	}
	defer crows.Close()
	for crows.Next() {
		var bid string
		var n int
		if err := crows.Scan(&bid, &n); err != nil {
			return nil, err
		}
		counts[bid] = n
	}

	out := make([]BookDTO, 0, len(books))
	for _, b := range books {
		out = append(out, toBookDTO(b, counts[b.ID]))
	}
	return out, nil
}

func GetBook(id string) (*BookDTO, error) {
	row, err := GetBookRow(id)
	if err != nil {
		return nil, err
	}
	if row == nil || row.DeletedAt.Valid {
		return nil, nil
	}
	d, err := db.Open()
	if err != nil {
		return nil, err
	}
	var n int
	if err := d.QueryRow(`SELECT COUNT(*) AS n FROM chapters WHERE book_id = ?`, id).Scan(&n); err != nil {
		return nil, err
	}
	dto := toBookDTO(*row, n)
	return &dto, nil
}

// GetBookTOC returns the hierarchical table-of-contents tree for a book.
// Books imported before hierarchical TOC support (empty toc) yield an empty
// slice, never nil, so the frontend can always iterate safely.
func GetBookTOC(bookID string) ([]epub.TOCEntry, error) {
	row, err := GetBookRow(bookID)
	if err != nil {
		return nil, err
	}
	if row == nil {
		return nil, nil
	}
	if strings.TrimSpace(row.TOC) == "" {
		return []epub.TOCEntry{}, nil
	}
	var toc []epub.TOCEntry
	if err := json.Unmarshal([]byte(row.TOC), &toc); err != nil {
		return []epub.TOCEntry{}, nil
	}
	return toc, nil
}

func ListChapters(bookID string) ([]ChapterDTO, error) {
	d, err := db.Open()
	if err != nil {
		return nil, err
	}
	rows, err := d.Query(`SELECT * FROM chapters WHERE book_id = ? ORDER BY idx ASC`, bookID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ChapterDTO{}
	for rows.Next() {
		c, e := scanChapter(rows)
		if e != nil {
			return nil, e
		}
		out = append(out, toChapterDTO(c))
	}
	return out, rows.Err()
}

func GetChapterRow(bookID, chapterID string) (*ChapterRow, error) {
	d, err := db.Open()
	if err != nil {
		return nil, err
	}
	row := d.QueryRow(`SELECT * FROM chapters WHERE book_id = ? AND id = ?`, bookID, chapterID)
	c, err := scanChapter(row)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &c, nil
}

func ListAssets(bookID string) ([]AssetRow, error) {
	d, err := db.Open()
	if err != nil {
		return nil, err
	}
	rows, err := d.Query(`SELECT * FROM assets WHERE book_id = ? ORDER BY href`, bookID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []AssetRow{}
	for rows.Next() {
		a, e := scanAsset(rows)
		if e != nil {
			return nil, e
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

func ListImages(bookID string) ([]ImageAsset, error) {
	assets, err := ListAssets(bookID)
	if err != nil {
		return nil, err
	}
	out := []ImageAsset{}
	for _, a := range assets {
		if !strings.HasPrefix(a.MediaType, "image/") {
			continue
		}
		url := ""
		if buf, err := storage.ReadContent(bookID, a.Href); err == nil {
			url = DataURL(a.MediaType, buf)
		}
		out = append(out, ImageAsset{
			Href: a.Href,
			Size: a.Size,
			URL:  url,
		})
	}
	return out, nil
}

/* ----------------------------- books ----------------------------- */

func UpdateBook(id string, patch BookPatch) (*BookDTO, error) {
	row, err := GetBookRow(id)
	if err != nil {
		return nil, err
	}
	if row == nil {
		return nil, nil
	}
	next := BookRow{
		ID:          row.ID,
		Title:       row.Title,
		Author:      row.Author,
		Language:    row.Language,
		Publisher:   row.Publisher,
		Description: row.Description,
		Identifier:  row.Identifier,
		CoverHref:   row.CoverHref,
		SourceName:  row.SourceName,
		CreatedAt:   row.CreatedAt,
		UpdatedAt:   nowIso(),
	}
	if patch.Title != nil {
		next.Title = *patch.Title
	}
	if patch.Author != nil {
		next.Author = *patch.Author
	}
	if patch.Language != nil {
		next.Language = *patch.Language
	}
	if patch.Publisher != nil {
		next.Publisher = *patch.Publisher
	}
	if patch.Description != nil {
		next.Description = *patch.Description
	}
	if patch.Identifier != nil {
		next.Identifier = *patch.Identifier
	}
	if patch.CoverHref != nil {
		if *patch.CoverHref == "" {
			next.CoverHref = sql.NullString{}
		} else {
			next.CoverHref = sql.NullString{String: *patch.CoverHref, Valid: true}
		}
	}
	d, err := db.Open()
	if err != nil {
		return nil, err
	}
	if _, err = d.Exec(
		`UPDATE books SET title=?,author=?,language=?,publisher=?,description=?,identifier=?,cover_href=?,updated_at=? WHERE id=?`,
		next.Title, next.Author, next.Language, next.Publisher, next.Description,
		next.Identifier, next.CoverHref, next.UpdatedAt, id); err != nil {
		return nil, err
	}
	return GetBook(id)
}

// DeleteBook soft-deletes: moves the directory into trash and marks deleted_at.
func DeleteBook(id string) (deleted bool, movedToTrash bool, err error) {
	row, err := GetBookRow(id)
	if err != nil {
		return false, false, err
	}
	if row == nil {
		return false, false, nil
	}
	if row.DeletedAt.Valid {
		return true, true, nil
	}
	moved := storage.MoveBookDirToTrash(id)
	ts := nowIso()
	if e := db.Tx(func() error {
		d, _ := db.Open()
		_, e := d.Exec(`UPDATE books SET deleted_at = ?, updated_at = ? WHERE id = ?`, ts, ts, id)
		return e
	}); e != nil {
		return false, false, e
	}
	return true, moved, nil
}

/* ----------------------------- trash ----------------------------- */

func ListTrash() ([]TrashItem, error) {
	root := storage.TrashRoot()
	entries, err := os.ReadDir(root)
	if err != nil {
		// Trash not created yet -> empty list, matching the TS behaviour.
		return []TrashItem{}, nil
	}
	items := []TrashItem{}
	for _, e := range entries {
		if !e.IsDir() || e.Name() == "_purged" {
			continue
		}
		id := uuidRe.FindString(e.Name())
		if id == "" {
			id = e.Name()
		}
		row, err := GetBookRow(id)
		if err != nil {
			return nil, err
		}
		if row != nil {
			items = append(items, TrashItem{
				ID:          id,
				Title:       orDefault(row.Title, "（未命名书籍）"),
				Author:      row.Author,
				CoverURL:    nil,
				DeletedAt:   nullStr(row.DeletedAt),
				Recoverable: row.DeletedAt.Valid,
				DirName:     e.Name(),
			})
		} else {
			items = append(items, TrashItem{
				ID:          id,
				Title:       "（原记录已删除）",
				Author:      "",
				CoverURL:    nil,
				DeletedAt:   nil,
				Recoverable: false,
				DirName:     e.Name(),
			})
		}
	}
	sort.Slice(items, func(i, j int) bool {
		ai, bi := items[i].DeletedAt, items[j].DeletedAt
		as, bs := "", ""
		if ai != nil {
			as = *ai
		}
		if bi != nil {
			bs = *bi
		}
		return bs < as
	})
	return items, nil
}

func RestoreBook(id string) (*BookDTO, error) {
	row, err := GetBookRow(id)
	if err != nil {
		return nil, err
	}
	if row == nil || !row.DeletedAt.Valid {
		return nil, nil
	}
	trashDir := storage.FindTrashDir(id)
	if trashDir != "" {
		dest := storage.BookDir(id)
		if _, err := os.Stat(dest); err == nil {
			return nil, fmt.Errorf("目标目录已存在，无法恢复")
		}
		if err := os.Rename(trashDir, dest); err != nil {
			return nil, err
		}
	}
	if e := db.Tx(func() error {
		d, _ := db.Open()
		_, e := d.Exec(`UPDATE books SET deleted_at = NULL, updated_at = ? WHERE id = ?`, nowIso(), id)
		return e
	}); e != nil {
		return nil, e
	}
	return GetBook(id)
}

func PurgeBook(id string) (purged bool, dataKept bool, err error) {
	row, err := GetBookRow(id)
	if err != nil {
		return false, false, err
	}
	if row == nil {
		return false, false, nil
	}
	trashDir := storage.FindTrashDir(id)
	dataKept = false
	if trashDir != "" {
		purgedDir := filepath.Join(storage.TrashRoot(), "_purged", filepath.Base(trashDir))
		storage.RemoveBookDir(id)
		dataKept = dirExists(trashDir) || dirExists(purgedDir)
	} else {
		storage.RemoveBookDir(id)
	}
	if e := db.Tx(func() error {
		d, _ := db.Open()
		if _, e := d.Exec(`DELETE FROM chapters WHERE book_id = ?`, id); e != nil {
			return e
		}
		if _, e := d.Exec(`DELETE FROM assets WHERE book_id = ?`, id); e != nil {
			return e
		}
		_, e := d.Exec(`DELETE FROM books WHERE id = ?`, id)
		return e
	}); e != nil {
		return false, false, e
	}
	return true, dataKept, nil
}

/* ----------------------------- chapters ----------------------------- */

func touchBook(bookID string) error {
	d, err := db.Open()
	if err != nil {
		return err
	}
	_, err = d.Exec(`UPDATE books SET updated_at = ? WHERE id = ?`, nowIso(), bookID)
	return err
}

func GetChapterSource(bookID, chapterID string) (*ChapterSource, error) {
	ch, err := GetChapterRow(bookID, chapterID)
	if err != nil {
		return nil, err
	}
	if ch == nil {
		return nil, nil
	}
	raw, err := storage.ReadContentText(bookID, ch.Href)
	if err != nil {
		raw = ""
	}
	return &ChapterSource{Title: ch.Title, HTML: strings.TrimSpace(html.ExtractBody(raw))}, nil
}

func UpdateChapter(bookID, chapterID string, patch ChapterPatch) (*ChapterDTO, error) {
	ch, err := GetChapterRow(bookID, chapterID)
	if err != nil {
		return nil, err
	}
	if ch == nil {
		return nil, nil
	}
	ts := nowIso()
	if patch.HTML != nil {
		original, rerr := storage.ReadContentText(bookID, ch.Href)
		if rerr != nil {
			original = ""
		}
		var next string
		if original != "" {
			next = html.ReplaceBody(original, *patch.HTML)
		} else {
			title := ch.Title
			if patch.Title != nil {
				title = *patch.Title
			}
			next = html.WrapDocument(title, *patch.HTML)
		}
		if e := storage.WriteContent(bookID, ch.Href, []byte(next)); e != nil {
			return nil, e
		}
	}
	title := ch.Title
	if patch.Title != nil {
		title = *patch.Title
	}
	d, err := db.Open()
	if err != nil {
		return nil, err
	}
	if _, err := d.Exec(`UPDATE chapters SET title = ?, updated_at = ? WHERE id = ?`, title, ts, chapterID); err != nil {
		return nil, err
	}
	if err := touchBook(bookID); err != nil {
		return nil, err
	}
	chapters, err := ListChapters(bookID)
	if err != nil {
		return nil, err
	}
	for _, c := range chapters {
		if c.ID == chapterID {
			return &c, nil
		}
	}
	return nil, nil
}

func CreateChapter(bookID string, opts ChapterCreateOpts) (*ChapterDTO, error) {
	row, err := GetBookRow(bookID)
	if err != nil {
		return nil, err
	}
	if row == nil {
		return nil, nil
	}
	chapters, err := ListChapters(bookID)
	if err != nil {
		return nil, err
	}
	insertAt := len(chapters)
	if opts.AfterChapterID != "" {
		for i, c := range chapters {
			if c.ID == opts.AfterChapterID {
				insertAt = i + 1
				break
			}
		}
	}
	id := uid()
	ts := nowIso()
	title := strings.TrimSpace(opts.Title)
	if title == "" {
		title = "新章节"
	}
	href := fmt.Sprintf("epubmaker/text/%s.xhtml", id)
	body := opts.HTML
	if body == "" {
		body = fmt.Sprintf("<h2>%s</h2>\n<p></p>", title)
	}
	if err := storage.WriteContent(bookID, href, []byte(html.WrapDocument(title, body))); err != nil {
		return nil, err
	}
	if e := db.Tx(func() error {
		d, _ := db.Open()
		if _, e := d.Exec(`UPDATE chapters SET idx = idx + 1 WHERE book_id = ? AND idx >= ?`, bookID, insertAt); e != nil {
			return e
		}
		_, e := d.Exec(
			`INSERT INTO chapters (id,book_id,idx,title,href,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`,
			id, bookID, insertAt, title, href, ts, ts)
		return e
	}); e != nil {
		return nil, e
	}
	if err := touchBook(bookID); err != nil {
		return nil, err
	}
	chapters, err = ListChapters(bookID)
	if err != nil {
		return nil, err
	}
	for _, c := range chapters {
		if c.ID == id {
			return &c, nil
		}
	}
	return nil, nil
}

func DeleteChapter(bookID, chapterID string) (bool, error) {
	ch, err := GetChapterRow(bookID, chapterID)
	if err != nil {
		return false, err
	}
	if ch == nil {
		return false, nil
	}
	if e := db.Tx(func() error {
		d, _ := db.Open()
		if _, e := d.Exec(`DELETE FROM chapters WHERE id = ?`, chapterID); e != nil {
			return e
		}
		rest, e := d.Query(`SELECT id FROM chapters WHERE book_id = ? ORDER BY idx ASC`, bookID)
		if e != nil {
			return e
		}
		defer rest.Close()
		ids := []string{}
		for rest.Next() {
			var rid string
			if e := rest.Scan(&rid); e != nil {
				return e
			}
			ids = append(ids, rid)
		}
		st, e := d.Prepare(`UPDATE chapters SET idx = ? WHERE id = ?`)
		if e != nil {
			return e
		}
		defer st.Close()
		for i, rid := range ids {
			if _, e := st.Exec(i, rid); e != nil {
				return e
			}
		}
		return nil
	}); e != nil {
		return false, e
	}
	_ = touchBook(bookID)
	// Body file stays on disk (may be referenced elsewhere); only removed from TOC.
	return true, nil
}

func ReorderChapters(bookID string, orderedIDs []string) ([]ChapterDTO, error) {
	existing, err := ListChapters(bookID)
	if err != nil {
		return nil, err
	}
	known := map[string]bool{}
	for _, c := range existing {
		known[c.ID] = true
	}
	ordered := []string{}
	for _, id := range orderedIDs {
		if known[id] {
			ordered = append(ordered, id)
		}
	}
	for _, c := range existing {
		if !contains(ordered, c.ID) {
			ordered = append(ordered, c.ID)
		}
	}
	if e := db.Tx(func() error {
		d, _ := db.Open()
		st, e := d.Prepare(`UPDATE chapters SET idx = ? WHERE id = ? AND book_id = ?`)
		if e != nil {
			return e
		}
		defer st.Close()
		for i, id := range ordered {
			if _, e := st.Exec(i, id, bookID); e != nil {
				return e
			}
		}
		return nil
	}); e != nil {
		return nil, e
	}
	_ = touchBook(bookID)
	return ListChapters(bookID)
}

func MergeChapters(bookID, targetID string, sourceIDs []string) ([]ChapterDTO, error) {
	target, err := GetChapterRow(bookID, targetID)
	if err != nil {
		return nil, err
	}
	if target == nil {
		return nil, nil
	}
	chapters, err := ListChapters(bookID)
	if err != nil {
		return nil, err
	}
	sources := []ChapterDTO{}
	for _, c := range chapters {
		if contains(sourceIDs, c.ID) && c.ID != targetID {
			sources = append(sources, c)
		}
	}
	if len(sources) == 0 {
		return chapters, nil
	}
	merged := ""
	if t, err := GetChapterSource(bookID, targetID); err == nil && t != nil {
		merged = t.HTML
	}
	for _, s := range sources {
		if part, err := GetChapterSource(bookID, s.ID); err == nil && part != nil {
			merged += "\n<hr class=\"epubmaker-merge\"/>\n" + part.HTML
		}
	}
	if _, err := UpdateChapter(bookID, targetID, ChapterPatch{HTML: &merged}); err != nil {
		return nil, err
	}
	for _, s := range sources {
		if _, err := DeleteChapter(bookID, s.ID); err != nil {
			return nil, err
		}
	}
	return ListChapters(bookID)
}

/* ----------------------------- assets ----------------------------- */

// AssetFilePath returns the absolute disk path for a content href.
func AssetFilePath(bookID, href string) (string, error) {
	return storage.ContentPath(bookID, href)
}

// SetBookCover sets (or clears, when href is empty) the book's cover href.
func SetBookCover(bookID, href string) (*BookDTO, error) {
	row, err := GetBookRow(bookID)
	if err != nil {
		return nil, err
	}
	if row == nil {
		return nil, nil
	}
	var cov sql.NullString
	if href != "" {
		cov = sql.NullString{String: href, Valid: true}
	}
	d, err := db.Open()
	if err != nil {
		return nil, err
	}
	if _, err := d.Exec(`UPDATE books SET cover_href = ?, updated_at = ? WHERE id = ?`, cov, nowIso(), bookID); err != nil {
		return nil, err
	}
	return GetBook(bookID)
}
