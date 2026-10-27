package library

import (
	"database/sql"

	"epubmaker-desktop/internal/db"
)

/* ----------------------------- types ----------------------------- */

// ReadingProgress is the persisted last position for a book in paged mode.
// PositionOffset is the layout-independent anchor (source character offset
// within the chapter); PageIndex is retained only for quick display.
type ReadingProgress struct {
	BookID         string `json:"bookId"`
	ChapterID      string `json:"chapterId"`
	PageIndex      int    `json:"pageIndex"`
	PageCount      int    `json:"pageCount"`
	PositionOffset int    `json:"positionOffset"`
	UpdatedAt      string `json:"updatedAt"`
}

// Bookmark is a saved position inside a chapter (anchor = page index).
type Bookmark struct {
	ID        string `json:"id"`
	BookID    string `json:"bookId"`
	ChapterID string `json:"chapterId"`
	Anchor    int    `json:"anchor"`
	Label     string `json:"label"`
	CreatedAt string `json:"createdAt"`
}

// Annotation is a highlight (with optional note) over a character range of a
// chapter's rendered text content.
type Annotation struct {
	ID          string `json:"id"`
	BookID      string `json:"bookId"`
	ChapterID   string `json:"chapterId"`
	StartOffset int    `json:"startOffset"`
	EndOffset   int    `json:"endOffset"`
	Text        string `json:"text"`
	Color       string `json:"color"`
	Note        string `json:"note"`
	PageIndex   int    `json:"pageIndex"`
	CreatedAt   string `json:"createdAt"`
	UpdatedAt   string `json:"updatedAt"`
}

/* ----------------------------- progress ----------------------------- */

// BookProgress is the shelf-level reading progress of one book: the saved
// chapter position folded into a 0..1 fraction of the whole book. Books that
// were never opened (or whose saved chapter no longer exists) are simply
// absent from the list.
type BookProgress struct {
	BookID    string  `json:"bookId"`
	Percent   float64 `json:"percent"`
	UpdatedAt string  `json:"updatedAt"`
}

// ListProgress joins every saved reading position with its chapter index and
// the book's chapter count. The fraction is idx/count: a reader parked on the
// second chapter of ten shows exactly the 10% the shelf displays.
func ListProgress() ([]BookProgress, error) {
	d, err := db.Open()
	if err != nil {
		return nil, err
	}
	rows, err := d.Query(`
		SELECT rp.book_id, c.idx,
		       (SELECT COUNT(*) FROM chapters c2 WHERE c2.book_id = rp.book_id),
		       rp.updated_at
		FROM reading_progress rp
		JOIN chapters c ON c.id = rp.chapter_id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []BookProgress{}
	for rows.Next() {
		var bookID, updatedAt string
		var idx, total int
		if err := rows.Scan(&bookID, &idx, &total, &updatedAt); err != nil {
			return nil, err
		}
		if total <= 0 {
			continue
		}
		pct := float64(idx) / float64(total)
		if pct < 0 {
			pct = 0
		} else if pct > 1 {
			pct = 1
		}
		out = append(out, BookProgress{BookID: bookID, Percent: pct, UpdatedAt: updatedAt})
	}
	return out, rows.Err()
}

func GetProgress(bookID string) (*ReadingProgress, error) {
	d, err := db.Open()
	if err != nil {
		return nil, err
	}
	p := &ReadingProgress{}
	row := d.QueryRow(
		`SELECT book_id, chapter_id, page_index, page_count, position_offset, updated_at
		 FROM reading_progress WHERE book_id = ?`, bookID)
	if err := row.Scan(&p.BookID, &p.ChapterID, &p.PageIndex, &p.PageCount, &p.PositionOffset, &p.UpdatedAt); err != nil {
		if err == sql.ErrNoRows {
			return nil, nil
		}
		return nil, err
	}
	return p, nil
}

func SaveProgress(bookID, chapterID string, positionOffset, pageCount int) (*ReadingProgress, error) {
	if positionOffset < 0 {
		positionOffset = 0
	}
	if pageCount < 0 {
		pageCount = 0
	}
	now := nowIso()
	d, err := db.Open()
	if err != nil {
		return nil, err
	}
	if _, err := d.Exec(
		`INSERT INTO reading_progress (book_id, chapter_id, page_index, page_count, position_offset, updated_at)
		 VALUES (?, ?, 0, ?, ?, ?)
		 ON CONFLICT(book_id) DO UPDATE SET
		   chapter_id=excluded.chapter_id, position_offset=excluded.position_offset,
		   page_count=excluded.page_count, updated_at=excluded.updated_at`,
		bookID, chapterID, pageCount, positionOffset, now); err != nil {
		return nil, err
	}
	return &ReadingProgress{
		BookID: bookID, ChapterID: chapterID, PageIndex: 0,
		PageCount: pageCount, PositionOffset: positionOffset, UpdatedAt: now,
	}, nil
}

/* ----------------------------- bookmarks ----------------------------- */

func ListBookmarks(bookID string) ([]Bookmark, error) {
	d, err := db.Open()
	if err != nil {
		return nil, err
	}
	rows, err := d.Query(
		`SELECT id, book_id, chapter_id, anchor, label, created_at
		 FROM bookmarks WHERE book_id = ? ORDER BY created_at ASC`, bookID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Bookmark{}
	for rows.Next() {
		var b Bookmark
		if err := rows.Scan(&b.ID, &b.BookID, &b.ChapterID, &b.Anchor, &b.Label, &b.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, b)
	}
	return out, rows.Err()
}

// AddBookmark marks a spot in a chapter. A spot is identified by its chapter
// and anchor, so marking it again cannot create a second bookmark: the insert
// yields to the row already there and hands that back instead. Every caller
// (the star in the reader's top bar, the bookmark drawer's button, a retry
// after a request the frontend lost track of) is therefore idempotent without
// having to ask first, and without a check-then-insert window between them.
func AddBookmark(bookID, chapterID string, anchor int, label string) (*Bookmark, error) {
	d, err := db.Open()
	if err != nil {
		return nil, err
	}
	b := &Bookmark{
		ID: uid(), BookID: bookID, ChapterID: chapterID,
		Anchor: anchor, Label: orDefault(label, ""), CreatedAt: nowIso(),
	}
	res, err := d.Exec(
		`INSERT INTO bookmarks (id, book_id, chapter_id, anchor, label, created_at)
		 VALUES (?, ?, ?, ?, ?, ?)
		 ON CONFLICT(book_id, chapter_id, anchor) DO NOTHING`,
		b.ID, b.BookID, b.ChapterID, b.Anchor, b.Label, b.CreatedAt)
	if err != nil {
		return nil, err
	}
	if n, err := res.RowsAffected(); err == nil && n == 0 {
		return bookmarkAt(d, bookID, chapterID, anchor)
	}
	return b, nil
}

// bookmarkAt reads the bookmark standing for one spot, for the insert above to
// return when it lost to the unique index.
func bookmarkAt(d *sql.DB, bookID, chapterID string, anchor int) (*Bookmark, error) {
	var b Bookmark
	if err := d.QueryRow(
		`SELECT id, book_id, chapter_id, anchor, label, created_at
		 FROM bookmarks WHERE book_id = ? AND chapter_id = ? AND anchor = ?`,
		bookID, chapterID, anchor,
	).Scan(&b.ID, &b.BookID, &b.ChapterID, &b.Anchor, &b.Label, &b.CreatedAt); err != nil {
		return nil, err
	}
	return &b, nil
}

func DeleteBookmark(id string) error {
	d, err := db.Open()
	if err != nil {
		return err
	}
	_, err = d.Exec(`DELETE FROM bookmarks WHERE id = ?`, id)
	return err
}

/* ----------------------------- annotations ----------------------------- */

func ListAnnotations(bookID string) ([]Annotation, error) {
	d, err := db.Open()
	if err != nil {
		return nil, err
	}
	rows, err := d.Query(
		`SELECT id, book_id, chapter_id, start_offset, end_offset, text, color, note, page_index, created_at, updated_at
		 FROM annotations WHERE book_id = ? ORDER BY start_offset ASC`, bookID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Annotation{}
	for rows.Next() {
		var a Annotation
		if err := rows.Scan(&a.ID, &a.BookID, &a.ChapterID, &a.StartOffset, &a.EndOffset,
			&a.Text, &a.Color, &a.Note, &a.PageIndex, &a.CreatedAt, &a.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

func AddAnnotation(bookID, chapterID string, startOffset, endOffset, pageIndex int, text, color, note string) (*Annotation, error) {
	d, err := db.Open()
	if err != nil {
		return nil, err
	}
	if color == "" {
		color = "yellow"
	}
	if startOffset > endOffset {
		startOffset, endOffset = endOffset, startOffset
	}
	if pageIndex < 0 {
		pageIndex = 0
	}
	a := &Annotation{
		ID: uid(), BookID: bookID, ChapterID: chapterID,
		StartOffset: startOffset, EndOffset: endOffset, Text: text,
		Color: color, Note: note, PageIndex: pageIndex, CreatedAt: nowIso(), UpdatedAt: nowIso(),
	}
	if _, err := d.Exec(
		`INSERT INTO annotations
		   (id, book_id, chapter_id, start_offset, end_offset, text, color, note, page_index, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		a.ID, a.BookID, a.ChapterID, a.StartOffset, a.EndOffset,
		a.Text, a.Color, a.Note, a.PageIndex, a.CreatedAt, a.UpdatedAt); err != nil {
		return nil, err
	}
	return a, nil
}

func GetAnnotation(id string) (*Annotation, error) {
	d, err := db.Open()
	if err != nil {
		return nil, err
	}
	var a Annotation
	row := d.QueryRow(
		`SELECT id, book_id, chapter_id, start_offset, end_offset, text, color, note, page_index, created_at, updated_at
		 FROM annotations WHERE id = ?`, id)
	if err := row.Scan(&a.ID, &a.BookID, &a.ChapterID, &a.StartOffset, &a.EndOffset,
		&a.Text, &a.Color, &a.Note, &a.PageIndex, &a.CreatedAt, &a.UpdatedAt); err != nil {
		return nil, err
	}
	return &a, nil
}

func UpdateAnnotation(id, color, note string) (*Annotation, error) {
	if color == "" {
		color = "yellow"
	}
	now := nowIso()
	d, err := db.Open()
	if err != nil {
		return nil, err
	}
	if _, err := d.Exec(
		`UPDATE annotations SET color = ?, note = ?, updated_at = ? WHERE id = ?`,
		color, note, now, id); err != nil {
		return nil, err
	}
	return GetAnnotation(id)
}

func DeleteAnnotation(id string) error {
	d, err := db.Open()
	if err != nil {
		return err
	}
	_, err = d.Exec(`DELETE FROM annotations WHERE id = ?`, id)
	return err
}

/* ----------------------------- global lists ----------------------------- */

// BookmarkListItem is a bookmark enriched with book/chapter titles for the
// global bookmarks page.
type BookmarkListItem struct {
	ID           string `json:"id"`
	BookID       string `json:"bookId"`
	BookTitle    string `json:"bookTitle"`
	ChapterID    string `json:"chapterId"`
	ChapterTitle string `json:"chapterTitle"`
	Anchor       int    `json:"anchor"`
	Label        string `json:"label"`
	CreatedAt    string `json:"createdAt"`
}

// ListAllBookmarks returns every bookmark across non-deleted books, ordered
// from newest to oldest.
func ListAllBookmarks() ([]BookmarkListItem, error) {
	d, err := db.Open()
	if err != nil {
		return nil, err
	}
	rows, err := d.Query(
		`SELECT bm.id, bm.book_id, b.title, bm.chapter_id, COALESCE(c.title, ''), bm.anchor, bm.label, bm.created_at
		 FROM bookmarks bm
		 JOIN books b ON b.id = bm.book_id
		 LEFT JOIN chapters c ON c.id = bm.chapter_id
		 WHERE b.deleted_at IS NULL
		 ORDER BY bm.created_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []BookmarkListItem{}
	for rows.Next() {
		var it BookmarkListItem
		if err := rows.Scan(&it.ID, &it.BookID, &it.BookTitle, &it.ChapterID, &it.ChapterTitle, &it.Anchor, &it.Label, &it.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, it)
	}
	return out, rows.Err()
}

// AnnotationListItem is an annotation enriched with book/chapter titles for
// the global annotations page.
type AnnotationListItem struct {
	ID           string `json:"id"`
	BookID       string `json:"bookId"`
	BookTitle    string `json:"bookTitle"`
	ChapterID    string `json:"chapterId"`
	ChapterTitle string `json:"chapterTitle"`
	StartOffset  int    `json:"startOffset"`
	EndOffset    int    `json:"endOffset"`
	Text         string `json:"text"`
	Color        string `json:"color"`
	Note         string `json:"note"`
	PageIndex    int    `json:"pageIndex"`
	CreatedAt    string `json:"createdAt"`
	UpdatedAt    string `json:"updatedAt"`
}

// ListAllAnnotations returns every annotation across non-deleted books, ordered
// by most recently updated first.
func ListAllAnnotations() ([]AnnotationListItem, error) {
	d, err := db.Open()
	if err != nil {
		return nil, err
	}
	rows, err := d.Query(
		`SELECT a.id, a.book_id, b.title, a.chapter_id, COALESCE(c.title, ''),
		        a.start_offset, a.end_offset, a.text, a.color, a.note, a.page_index, a.created_at, a.updated_at
		 FROM annotations a
		 JOIN books b ON b.id = a.book_id
		 LEFT JOIN chapters c ON c.id = a.chapter_id
		 WHERE b.deleted_at IS NULL
		 ORDER BY a.updated_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []AnnotationListItem{}
	for rows.Next() {
		var it AnnotationListItem
		if err := rows.Scan(&it.ID, &it.BookID, &it.BookTitle, &it.ChapterID, &it.ChapterTitle,
			&it.StartOffset, &it.EndOffset, &it.Text, &it.Color, &it.Note, &it.PageIndex, &it.CreatedAt, &it.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, it)
	}
	return out, rows.Err()
}
