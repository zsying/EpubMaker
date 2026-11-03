package library

import (
	"database/sql"
	"errors"
	"io"
	"testing"

	"epubmaker-desktop/internal/db"
)

// A locked shelf is only as hidden as its least-guarded exit. The first version
// of this feature guarded GetBook and GetChapterRow and left everything else
// open: the export, the split, the rename, the cover swap, the outline (which
// carries every chapter title), ListAssets (which carries every href) and
// AssetFilePath (which turns an href into a readable path on disk). All of those
// take a book id from the same UI that will happily hand one over.
//
// So the test is a list, not a scenario: every exported function that takes a
// book id is listed here, and each one has to answer ErrShelfLocked. Adding a
// new entry point without a guard fails this test rather than shipping quietly.
func TestLockedShelfRefusesEveryExit(t *testing.T) {
	shelfID, bookID := seedLockedShelf(t)

	type exit struct {
		name string
		call func() error
	}
	exits := []exit{
		// Content and metadata reads.
		{"GetBook", func() error { _, err := GetBook(bookID); return err }},
		{"GetBookRow", func() error { _, err := GetBookRow(bookID); return err }},
		{"GetBookTOC", func() error { _, err := GetBookTOC(bookID); return err }},
		{"ListChapters", func() error { _, err := ListChapters(bookID); return err }},
		{"GetChapterRow", func() error { _, err := GetChapterRow(bookID, "c1"); return err }},
		{"GetChapterSource", func() error { _, err := GetChapterSource(bookID, "c1"); return err }},
		{"RenderChapter", func() error { _, err := RenderChapter(bookID, "c1"); return err }},
		{"ListAssets", func() error { _, err := ListAssets(bookID); return err }},
		{"ListImages", func() error { _, err := ListImages(bookID); return err }},
		{"AssetFilePath", func() error { _, err := AssetFilePath(bookID, "chapters/c1.xhtml"); return err }},
		{"GetProgress", func() error { _, err := GetProgress(bookID); return err }},
		{"ListBookmarks", func() error { _, err := ListBookmarks(bookID); return err }},
		{"ListAnnotations", func() error { _, err := ListAnnotations(bookID); return err }},

		// Export paths: these hand the whole book to whoever asks.
		{"BuildExportInput", func() error { _, _, err := BuildExportInput(bookID); return err }},
		{"ExportBook", func() error { _, err := ExportBook(bookID, io.Discard); return err }},
		{"ExportBookFileName", func() error { _, err := ExportBookFileName(bookID); return err }},
		{"SplitBook", func() error {
			_, err := SplitBook(bookID, []SplitPart{{Title: "上", ChapterIDs: []string{"c1"}}}, false)
			return err
		}},

		// Writes: a locked shelf is not editable, and nothing may be deleted or
		// rewritten behind the password either.
		{"UpdateBook", func() error { _, err := UpdateBook(bookID, BookPatch{Title: strPtr("改名")}); return err }},
		{"SetBookCover", func() error { _, err := SetBookCover(bookID, ""); return err }},
		{"UploadCover", func() error { _, err := UploadCover(bookID, "x.png", []byte("img")); return err }},
		{"DeleteBook", func() error { _, _, err := DeleteBook(bookID); return err }},
		{"UpdateChapter", func() error {
			_, err := UpdateChapter(bookID, "c1", ChapterPatch{Title: strPtr("改名")})
			return err
		}},
		{"CreateChapter", func() error {
			_, err := CreateChapter(bookID, ChapterCreateOpts{Title: "新章"})
			return err
		}},
		{"DeleteChapter", func() error { _, err := DeleteChapter(bookID, "c1"); return err }},
		{"ReorderChapters", func() error { _, err := ReorderChapters(bookID, []string{"c1"}); return err }},
		{"MergeChapters", func() error { _, err := MergeChapters(bookID, "c1", []string{"c1"}); return err }},
		{"SaveProgress", func() error { _, err := SaveProgress(bookID, "c1", 10, 3); return err }},
		{"AddBookmark", func() error { _, err := AddBookmark(bookID, "c1", 5, ""); return err }},
		{"AddAnnotation", func() error {
			_, err := AddAnnotation(bookID, "c1", 0, 4, 0, "正文", "yellow", "")
			return err
		}},

		// Rows that are looked up by their own id carry the book id inside them:
		// deleting a bookmark is a write into a locked shelf just as much.
		{"GetAnnotation", func() error { _, err := GetAnnotation("a1"); return err }},
		{"UpdateAnnotation", func() error { _, err := UpdateAnnotation("a1", "blue", ""); return err }},
		{"DeleteAnnotation", func() error { return DeleteAnnotation("a1") }},
		{"DeleteBookmark", func() error { return DeleteBookmark("bm1") }},
	}

	for _, e := range exits {
		if err := e.call(); !errors.Is(err, ErrShelfLocked) {
			t.Errorf("%s: got %v, want ErrShelfLocked", e.name, err)
		}
	}

	// ErrShelfLocked alone is not proof. UpdateBook writes the row and only then
	// calls GetBook for its return value, so it answered with the right error
	// while having already renamed the book — indistinguishable, above, from a
	// real refusal. Check that nothing moved.
	assertShelfUntouched(t, bookID)

	// The cross-book lists are a different shape: they do not take a book id, so
	// they have to filter by shelf. Two already do (bookmarks, annotations);
	// "continue reading" used to join straight through and hand back a locked
	// book's title and percentage.
	prog, err := ListProgress()
	if err != nil {
		t.Fatalf("ListProgress: %v", err)
	}
	for _, p := range prog {
		if p.BookID == bookID {
			t.Errorf("continue-reading lists a book from the locked shelf %s", shelfID)
		}
	}

	// And the shelf really is locked, so a green run above is not a run where
	// the lock never took effect.
	if s := mustShelf(t, "日记"); !s.Locked {
		t.Fatalf("the fixture shelf is not locked: %+v", s)
	}
}

// Unlocking has to bring everything back: a guard that cannot be lifted is a
// different bug, and the shelf page has no way to tell them apart.
func TestUnlockingRestoresEveryExit(t *testing.T) {
	_, bookID := seedLockedShelf(t)

	if _, err := UnlockShelf(mustShelf(t, "日记").ID, "1234"); err != nil {
		t.Fatalf("UnlockShelf: %v", err)
	}

	if _, err := GetBook(bookID); err != nil {
		t.Errorf("GetBook after unlock: %v", err)
	}
	if _, err := ListChapters(bookID); err != nil {
		t.Errorf("ListChapters after unlock: %v", err)
	}
	if _, err := RenderChapter(bookID, "c1"); err != nil {
		t.Errorf("RenderChapter after unlock: %v", err)
	}
	if _, err := AssetFilePath(bookID, "chapters/c1.xhtml"); err != nil {
		t.Errorf("AssetFilePath after unlock: %v", err)
	}
	if bp, err := ListProgress(); err != nil {
		t.Errorf("ListProgress after unlock: %v", err)
	} else {
		found := false
		for _, p := range bp {
			if p.BookID == bookID {
				found = true
			}
		}
		if !found {
			t.Error("continue-reading does not list the book after unlock")
		}
	}
}

// seedLockedShelf builds one book with a chapter, an asset, a reading position,
// a bookmark and an annotation, all on a password-locked shelf.
// assertShelfUntouched checks the fixture still looks exactly as seeded. A guard
// that returns the right error after doing the write is not a guard.
func assertShelfUntouched(t *testing.T, bookID string) {
	t.Helper()
	d, err := db.Open()
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}

	var title string
	var deletedAt sql.NullString
	if err := d.QueryRow(`SELECT title, deleted_at FROM books WHERE id = ?`, bookID).
		Scan(&title, &deletedAt); err != nil {
		t.Fatalf("read book: %v", err)
	}
	if title != "私事" || deletedAt.Valid {
		t.Errorf("the book row moved: title=%q deleted=%v", title, deletedAt)
	}

	for _, c := range []struct {
		table string
		want  int
	}{
		{"chapters", 1}, {"assets", 1}, {"bookmarks", 1}, {"annotations", 1},
	} {
		var n int
		if err := d.QueryRow(`SELECT COUNT(*) FROM `+c.table+` WHERE book_id = ?`, bookID).Scan(&n); err != nil {
			t.Fatalf("count %s: %v", c.table, err)
		}
		if n != c.want {
			t.Errorf("%s holds %d rows, want %d", c.table, n, c.want)
		}
	}

	var offset int
	if err := d.QueryRow(`SELECT position_offset FROM reading_progress WHERE book_id = ?`, bookID).
		Scan(&offset); err != nil {
		t.Fatalf("read progress: %v", err)
	}
	if offset != 120 {
		t.Errorf("the reading position moved to %d, want 120", offset)
	}

	var color string
	if err := d.QueryRow(`SELECT color FROM annotations WHERE id = 'a1'`).Scan(&color); err != nil {
		t.Fatalf("read annotation: %v", err)
	}
	if color != "yellow" {
		t.Errorf("the annotation colour changed to %q", color)
	}
}

func seedLockedShelf(t *testing.T) (shelfID, bookID string) {
	t.Helper()
	resetShelfState(t)

	s, err := CreateShelf("日记")
	if err != nil {
		t.Fatalf("CreateShelf: %v", err)
	}
	bookID = "b1"
	insertBookOnShelf(t, bookID, "私事", s.ID)
	insertChapterRow(t, bookID, "c1", 0)

	d, err := db.Open()
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	ts := nowIso()
	if _, err := d.Exec(
		`INSERT INTO assets (id, book_id, href, media_type, size) VALUES (?,?,?,?,?)`,
		"as1", bookID, "chapters/c1.xhtml", "application/xhtml+xml", 12); err != nil {
		t.Fatalf("insert asset: %v", err)
	}
	if _, err := d.Exec(
		`INSERT INTO reading_progress (book_id, chapter_id, page_index, page_count, position_offset, updated_at)
		 VALUES (?,?,?,?,?,?)`, bookID, "c1", 0, 5, 120, ts); err != nil {
		t.Fatalf("insert progress: %v", err)
	}
	if _, err := d.Exec(
		`INSERT INTO bookmarks (id, book_id, chapter_id, anchor, label, created_at) VALUES (?,?,?,?,?,?)`,
		"bm1", bookID, "c1", 5, "", ts); err != nil {
		t.Fatalf("insert bookmark: %v", err)
	}
	if _, err := d.Exec(
		`INSERT INTO annotations (id, book_id, chapter_id, start_offset, end_offset, text, color, note, page_index, created_at, updated_at)
		 VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
		"a1", bookID, "c1", 0, 4, "正文", "yellow", "", 0, ts, ts); err != nil {
		t.Fatalf("insert annotation: %v", err)
	}

	if _, err := SetShelfLock(s.ID, "", "1234"); err != nil {
		t.Fatalf("SetShelfLock: %v", err)
	}
	if err := LockShelf(s.ID); err != nil {
		t.Fatalf("LockShelf: %v", err)
	}
	return s.ID, bookID
}
