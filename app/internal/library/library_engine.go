package library

import (
	"database/sql"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"epubmaker-desktop/internal/config"
	"epubmaker-desktop/internal/db"
	"epubmaker-desktop/internal/epub"
	"epubmaker-desktop/internal/html"
	"epubmaker-desktop/internal/mime"
	"epubmaker-desktop/internal/storage"
)

/* ----------------------------- render ----------------------------- */

// ChapterRender is the rendered (resource-rewritten) chapter HTML for reading.
type ChapterRender struct {
	Title string `json:"title"`
	HTML  string `json:"html"`
}

// RenderChapter returns the chapter body with internal resource links rewritten
// to served URLs; missing resources keep their original (broken) link.
func RenderChapter(bookID, chapterID string) (*ChapterRender, error) {
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
	body := html.ExtractBody(raw)
	out := html.RewriteResourceUrls(body, ch.Href, func(target string) string {
		if !storage.ContentExists(bookID, target) {
			return ""
		}
		return fmt.Sprintf("/api/books/%s/assets/%s", bookID, html.EncodeHrefForURL(target))
	})
	return &ChapterRender{Title: ch.Title, HTML: out}, nil
}

/* ----------------------------- import ----------------------------- */

// ImportEpub parses an EPUB file on disk, stores its resources, and registers
// the book (and its chapters/assets) in the database.
func ImportEpub(filePath, originalName string) (*BookDTO, error) {
	data, err := os.ReadFile(filePath)
	if err != nil {
		return nil, err
	}
	parsed, err := epub.ParseEpub(data)
	if err != nil {
		return nil, err
	}

	bookID := uid()
	ts := nowIso()

	sizes := map[string]int64{}
	for href, entry := range parsed.Entries {
		buf, e := epub.ReadEntry(entry)
		if e != nil {
			continue
		}
		if e := storage.WriteContent(bookID, href, buf); e != nil {
			continue
		}
		sizes[href] = int64(len(buf))
	}
	// Parsed entries are no longer needed; drop the handle map to free memory.
	parsed.Entries = nil

	if config.Get().KeepOriginalEpub {
		dest := filepath.Join(storage.BookDir(bookID), "original.epub")
		_ = os.MkdirAll(filepath.Dir(dest), 0o755)
		_ = copyFile(filePath, dest)
	}

	title := parsed.Metadata.Title
	if title == "" || title == "未命名书籍" {
		title = strings.TrimSuffix(filepath.Base(originalName), filepath.Ext(originalName))
	}
	if title == "" {
		title = "未命名书籍"
	}

	chapterTitles := make([]string, len(parsed.Spine))
	for i, item := range parsed.Spine {
		t := parsed.TOC[item.Href]
		if t == "" {
			if b, e := storage.ReadContentText(bookID, item.Href); e == nil {
				t = html.ExtractTitle(b)
			}
		}
		if t == "" {
			t = fmt.Sprintf("第 %d 节", i+1)
		}
		chapterTitles[i] = t
	}

	var cover sql.NullString
	if parsed.CoverHref != "" {
		cover = sql.NullString{String: parsed.CoverHref, Valid: true}
	}

	if err := db.Tx(func() error {
		d, e := db.Open()
		if e != nil {
			return e
		}
		if e := insertBookStmt(d, bookID, title, parsed.Metadata.Author, parsed.Metadata.Language,
			parsed.Metadata.Publisher, parsed.Metadata.Description, parsed.Metadata.Identifier, cover, originalName, ts); e != nil {
			return e
		}
		chStmt, e := d.Prepare(`INSERT INTO chapters (id,book_id,idx,title,href,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`)
		if e != nil {
			return e
		}
		defer chStmt.Close()
		for i, item := range parsed.Spine {
			if _, e := chStmt.Exec(uid(), bookID, i, chapterTitles[i], item.Href, ts, ts); e != nil {
				return e
			}
		}
		asStmt, e := d.Prepare(`INSERT INTO assets (id,book_id,href,media_type,size) VALUES (?,?,?,?,?)`)
		if e != nil {
			return e
		}
		defer asStmt.Close()
		for _, res := range parsed.Resources {
			size, ok := sizes[res.Href]
			if !ok {
				continue
			}
			mt := res.MediaType
			if mt == "" {
				mt = mime.GuessMediaType(res.Href)
			}
			if _, e := asStmt.Exec(uid(), bookID, res.Href, mt, size); e != nil {
				return e
			}
		}
		return nil
	}); err != nil {
		return nil, err
	}

	return GetBook(bookID)
}

func insertBookStmt(d *sql.DB, id, title, author, language, publisher, description, identifier string, cover sql.NullString, sourceName, ts string) error {
	_, err := d.Exec(
		`INSERT INTO books (id,title,author,language,publisher,description,identifier,cover_href,source_name,created_at,updated_at)
		 VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
		id, title, author, language, publisher, description, identifier, cover, sourceName, ts, ts)
	return err
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.Create(dst)
	if err != nil {
		return err
	}
	defer out.Close()
	_, err = io.Copy(out, in)
	return err
}

/* ----------------------------- export ----------------------------- */

// BuildExportInput prepares the EPUB build input and the download filename for
// a book. The caller streams the built bytes to its destination.
func BuildExportInput(bookID string) (epub.BuildInput, string, error) {
	row, err := GetBookRow(bookID)
	if err != nil {
		return epub.BuildInput{}, "", err
	}
	if row == nil {
		return epub.BuildInput{}, "", errors.New("书籍不存在")
	}
	chapters, err := ListChapters(bookID)
	if err != nil {
		return epub.BuildInput{}, "", err
	}
	if len(chapters) == 0 {
		return epub.BuildInput{}, "", errors.New("书籍没有任何章节，无法导出")
	}

	bChapters := make([]epub.BuildChapter, 0, len(chapters))
	for _, c := range chapters {
		content, e := storage.ReadContent(bookID, c.Href)
		if e != nil {
			content = []byte(html.WrapDocument(c.Title, fmt.Sprintf("<h2>%s</h2>", html.EscapeXml(html.StripTags(c.Title)))))
		}
		bChapters = append(bChapters, epub.BuildChapter{Title: c.Title, Href: c.Href, Content: content})
	}

	assets, err := ListAssets(bookID)
	if err != nil {
		return epub.BuildInput{}, "", err
	}
	var cover sql.NullString
	if row.CoverHref.Valid {
		cover = row.CoverHref
	}
	coverHref := cover.String

	bAssets := []epub.BuildAsset{}
	seen := map[string]bool{}
	for _, c := range chapters {
		seen[c.Href] = true
	}
	for _, a := range assets {
		if seen[a.Href] {
			continue
		}
		if !storage.ContentExists(bookID, a.Href) {
			continue
		}
		p, e := storage.ContentPath(bookID, a.Href)
		if e != nil {
			continue
		}
		f, e := os.Open(p)
		if e != nil {
			continue
		}
		bAssets = append(bAssets, epub.BuildAsset{Href: a.Href, MediaType: a.MediaType, Content: f})
		seen[a.Href] = true
	}
	if coverHref != "" && !seen[coverHref] && storage.ContentExists(bookID, coverHref) {
		if p, e := storage.ContentPath(bookID, coverHref); e == nil {
			if f, e := os.Open(p); e == nil {
				bAssets = append(bAssets, epub.BuildAsset{Href: coverHref, MediaType: mime.GuessMediaType(coverHref), Content: f})
			}
		}
	}

	fileName := storage.SanitizeFileName(row.Title) + ".epub"
	input := epub.BuildInput{
		Title:       row.Title,
		Author:      row.Author,
		Language:    row.Language,
		Publisher:   row.Publisher,
		Description: row.Description,
		Identifier:  row.Identifier,
		CoverHref:   coverHref,
		Chapters:    bChapters,
		Assets:      bAssets,
	}
	return input, fileName, nil
}

// ExportBook builds the book's EPUB and writes it to dst (e.g. the HTTP
// response or a file). It returns the suggested download filename.
func ExportBook(bookID string, dst io.Writer) (string, error) {
	input, fileName, err := BuildExportInput(bookID)
	if err != nil {
		return "", err
	}
	if err := epub.BuildEpub(input, dst); err != nil {
		return "", err
	}
	return fileName, nil
}

// ExportBookFileName returns the suggested download filename for a book without
// building it — used to set response headers before streaming the bytes.
func ExportBookFileName(bookID string) (string, error) {
	row, err := GetBookRow(bookID)
	if err != nil {
		return "", err
	}
	if row == nil {
		return "", errors.New("书籍不存在")
	}
	return storage.SanitizeFileName(row.Title) + ".epub", nil
}

/* ----------------------------- cover ----------------------------- */

// UploadedCover is the result of storing a new cover image.
type UploadedCover struct {
	Href      string `json:"href"`
	URL       string `json:"url"`
	MediaType string `json:"mediaType"`
}

// UploadCover stores a cover image into the book's resource directory and
// registers it as an image asset.
func UploadCover(bookID, name string, buf []byte) (*UploadedCover, error) {
	if _, err := GetBookRow(bookID); err != nil {
		return nil, err
	}
	ext := strings.ToLower(filepath.Ext(name))
	if ext == "" {
		ext = ".png"
	}
	mt := mime.GuessMediaType("cover" + ext)
	if !mime.IsImage(mt) {
		return nil, errors.New("封面仅支持图片文件")
	}
	href := fmt.Sprintf("epubmaker/covers/%s%s", uid(), ext)
	if err := storage.WriteContent(bookID, href, buf); err != nil {
		return nil, err
	}
	d, err := db.Open()
	if err != nil {
		return nil, err
	}
	if _, err := d.Exec(`INSERT INTO assets (id,book_id,href,media_type,size) VALUES (?,?,?,?,?)`,
		uid(), bookID, href, mt, int64(len(buf))); err != nil {
		return nil, err
	}
	return &UploadedCover{
		Href:      href,
		URL:       fmt.Sprintf("/api/books/%s/assets/%s", bookID, html.EncodeHrefForURL(href)),
		MediaType: mt,
	}, nil
}

/* ----------------------------- split ----------------------------- */

// SplitPart describes one output volume of a split operation.
type SplitPart struct {
	Title      string   `json:"title"`
	Author     string   `json:"author"`
	ChapterIDs []string `json:"chapterIds"`
	// CoverHref: nil -> inherit the source book's cover; "" -> no cover;
	// non-empty -> a specific image href.
	CoverHref *string `json:"coverHref"`
}

// SplitBook creates one new book per part, copying each part's chapters and the
// resources they reference. Optionally deletes the source book afterwards.
func SplitBook(bookID string, parts []SplitPart, deleteSource bool) ([]*BookDTO, error) {
	row, err := GetBookRow(bookID)
	if err != nil {
		return nil, err
	}
	if row == nil {
		return nil, errors.New("书籍不存在")
	}
	chapters, err := ListChapters(bookID)
	if err != nil {
		return nil, err
	}
	byID := map[string]ChapterDTO{}
	for _, c := range chapters {
		byID[c.ID] = c
	}

	created := []string{}
	for _, part := range parts {
		picked := []ChapterDTO{}
		for _, id := range part.ChapterIDs {
			if c, ok := byID[id]; ok {
				picked = append(picked, c)
			}
		}
		if len(picked) == 0 {
			continue
		}

		newID := uid()
		ts := nowIso()
		var effectiveCover string
		if part.CoverHref != nil {
			effectiveCover = *part.CoverHref
		} else if row.CoverHref.Valid {
			effectiveCover = row.CoverHref.String
		}
		needed := collectNeededAssets(bookID, chapterHrefsOf(picked), effectiveCover)

		for _, c := range picked {
			content, e := storage.ReadContent(bookID, c.Href)
			if e != nil {
				content = []byte(html.WrapDocument(c.Title, ""))
			}
			_ = storage.WriteContent(newID, c.Href, content)
		}
		assetRows, _ := ListAssets(bookID)
		kept := []AssetRow{}
		for _, a := range assetRows {
			if needed[a.Href] {
				kept = append(kept, a)
				if content, e := storage.ReadContent(bookID, a.Href); e == nil {
					_ = storage.WriteContent(newID, a.Href, content)
				}
			}
		}

		var cov sql.NullString
		if effectiveCover != "" && needed[effectiveCover] {
			cov = sql.NullString{String: effectiveCover, Valid: true}
		}
		title := strings.TrimSpace(part.Title)
		if title == "" {
			title = row.Title + " - 分卷"
		}
		author := part.Author
		if author == "" {
			author = row.Author
		}
		if err := db.Tx(func() error {
			d, e := db.Open()
			if e != nil {
				return e
			}
			if e := insertBookStmt(d, newID, title, author, row.Language, row.Publisher,
				row.Description, "", cov, row.SourceName.String, ts); e != nil {
				return e
			}
			chStmt, e := d.Prepare(`INSERT INTO chapters (id,book_id,idx,title,href,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`)
			if e != nil {
				return e
			}
			defer chStmt.Close()
			for i, c := range picked {
				if _, e := chStmt.Exec(uid(), newID, i, c.Title, c.Href, ts, ts); e != nil {
					return e
				}
			}
			asStmt, e := d.Prepare(`INSERT INTO assets (id,book_id,href,media_type,size) VALUES (?,?,?,?,?)`)
			if e != nil {
				return e
			}
			defer asStmt.Close()
			for _, a := range kept {
				if _, e := asStmt.Exec(uid(), newID, a.Href, a.MediaType, storage.ContentSize(newID, a.Href)); e != nil {
					return e
				}
			}
			return nil
		}); err != nil {
			return nil, err
		}
		created = append(created, newID)
	}

	if deleteSource && len(created) > 0 {
		if _, _, err := DeleteBook(bookID); err != nil {
			return nil, err
		}
	}

	out := []*BookDTO{}
	for _, id := range created {
		if b, e := GetBook(id); e == nil && b != nil {
			out = append(out, b)
		}
	}
	return out, nil
}

func chapterHrefsOf(chs []ChapterDTO) []string {
	out := make([]string, 0, len(chs))
	for _, c := range chs {
		out = append(out, c.Href)
	}
	return out
}

// collectNeededAssets computes the set of resource hrefs a set of chapters needs
// (direct references + CSS @import/url transitively + all stylesheets + cover).
func collectNeededAssets(bookID string, chapterHrefs []string, coverHref string) map[string]bool {
	assets, _ := ListAssets(bookID)
	byHref := map[string]AssetRow{}
	for _, a := range assets {
		byHref[a.Href] = a
	}
	needed := map[string]bool{}
	var queue []string
	add := func(href string) {
		h := html.NormalizeHref(href)
		if _, ok := byHref[h]; !ok || needed[h] {
			return
		}
		needed[h] = true
		queue = append(queue, h)
	}

	for _, href := range chapterHrefs {
		htmlContent, e := storage.ReadContentText(bookID, href)
		if e != nil {
			continue
		}
		for _, r := range html.CollectReferences(htmlContent, href) {
			add(r)
		}
	}
	for _, a := range assets {
		if a.MediaType == "text/css" {
			add(a.Href)
		}
	}
	if coverHref != "" {
		add(coverHref)
	}
	for len(queue) > 0 {
		href := queue[0]
		queue = queue[1:]
		if !strings.HasSuffix(strings.ToLower(href), ".css") {
			continue
		}
		css, e := storage.ReadContentText(bookID, href)
		if e != nil {
			continue
		}
		for _, r := range html.CollectCssReferences(css, href) {
			add(r)
		}
	}
	return needed
}
