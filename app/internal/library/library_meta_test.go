package library

import (
	"os"
	"testing"
	"time"

	"epubmaker-desktop/internal/db"
)

// TestMain pins EPUBMAKER_HOME at a temp dir so db.Open() builds a throwaway
// database. Tests that need isolation DELETE their tables themselves (the
// connection is a package-level singleton and shared across the run).
func TestMain(m *testing.M) {
	dir, err := os.MkdirTemp("", "epubmaker-library-test")
	if err != nil {
		panic(err)
	}
	os.Setenv("EPUBMAKER_HOME", dir)
	code := m.Run()
	_ = db.Close()
	_ = os.RemoveAll(dir)
	os.Exit(code)
}

func resetLibraryTables(t *testing.T) {
	t.Helper()
	d, err := db.Open()
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	for _, table := range []string{"reading_progress", "chapters", "assets", "books"} {
		if _, err := d.Exec(`DELETE FROM ` + table); err != nil {
			t.Fatalf("reset %s: %v", table, err)
		}
	}
}

func insertBookRow(t *testing.T, id, title string) {
	t.Helper()
	d, err := db.Open()
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	now := time.Now().UTC().Format(time.RFC3339)
	_, err = d.Exec(
		`INSERT INTO books (id, title, author, language, created_at, updated_at) VALUES (?,?,?,?,?,?)`,
		id, title, "Author", "zh", now, now)
	if err != nil {
		t.Fatalf("insert book %s: %v", id, err)
	}
}

func insertChapterRow(t *testing.T, bookID, chapterID string, idx int) {
	t.Helper()
	d, err := db.Open()
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	now := time.Now().UTC().Format(time.RFC3339)
	_, err = d.Exec(
		`INSERT INTO chapters (id, book_id, idx, title, href, created_at, updated_at) VALUES (?,?,?,?,?,?,?)`,
		chapterID, bookID, idx, "Chapter", "ch"+chapterID+".xhtml", now, now)
	if err != nil {
		t.Fatalf("insert chapter %s: %v", chapterID, err)
	}
}

func insertProgressRow(t *testing.T, bookID, chapterID string, pageIndex int) {
	t.Helper()
	d, err := db.Open()
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	_, err = d.Exec(
		`INSERT INTO reading_progress (book_id, chapter_id, page_index, page_count, position_offset, updated_at)
		 VALUES (?,?,?,?,?,?)`,
		bookID, chapterID, pageIndex, 10, 0, time.Now().UTC().Format(time.RFC3339))
	if err != nil {
		t.Fatalf("insert progress %s: %v", bookID, err)
	}
}

func tagsPtr(tags []string) *[]string { return &tags }

func strPtr(s string) *string { return &s }

// A book's tags must round-trip: saved through BookPatch, read back through
// GetBook/ListBooks, and an empty patch must yield an empty slice (never null)
// so the frontend can map over it safely.
func TestUpdateBookTags(t *testing.T) {
	resetLibraryTables(t)
	insertBookRow(t, "bk-tags", "Tagged Book")

	book, err := UpdateBook("bk-tags", BookPatch{Tags: tagsPtr([]string{"小说", "历史"})})
	if err != nil {
		t.Fatalf("UpdateBook: %v", err)
	}
	if book == nil {
		t.Fatal("UpdateBook returned nil")
	}
	if len(book.Tags) != 2 || book.Tags[0] != "小说" || book.Tags[1] != "历史" {
		t.Fatalf("saved tags lost: %#v", book.Tags)
	}

	book, err = GetBook("bk-tags")
	if err != nil {
		t.Fatalf("GetBook: %v", err)
	}
	if len(book.Tags) != 2 || book.Tags[0] != "小说" {
		t.Fatalf("GetBook tags: %#v", book.Tags)
	}

	// A fresh book without any tag row reads back as an empty slice.
	insertBookRow(t, "bk-plain", "Plain Book")
	plain, err := GetBook("bk-plain")
	if err != nil {
		t.Fatalf("GetBook plain: %v", err)
	}
	if plain.Tags == nil || len(plain.Tags) != 0 {
		t.Fatalf("untagged book should read back as [], got %#v", plain.Tags)
	}

	// Clearing the tags must persist as well.
	book, err = UpdateBook("bk-tags", BookPatch{Tags: tagsPtr([]string{})})
	if err != nil {
		t.Fatalf("UpdateBook clear: %v", err)
	}
	if len(book.Tags) != 0 {
		t.Fatalf("cleared tags should be empty, got %#v", book.Tags)
	}

	// A nil Tags patch must not touch the stored tags.
	if _, err := UpdateBook("bk-tags", BookPatch{Title: strPtr("Renamed")}); err != nil {
		t.Fatalf("UpdateBook title: %v", err)
	}
	book, err = GetBook("bk-tags")
	if err != nil {
		t.Fatalf("GetBook after rename: %v", err)
	}
	if len(book.Tags) != 0 {
		t.Fatalf("nil patch must not resurrect tags, got %#v", book.Tags)
	}
}

// ListProgress turns each book's saved position into a 0..1 shelf progress:
// chapter index over chapter count. Books without progress are absent; the
// fixture book with 10 chapters and the reader parked on chapter 2 (idx 1)
// is exactly the 10% the shelf shows.
func TestListProgressPercent(t *testing.T) {
	resetLibraryTables(t)

	insertBookRow(t, "bk-10ch", "Ten Chapters")
	for i := 0; i < 10; i++ {
		insertChapterRow(t, "bk-10ch", "c"+string(rune('a'+i)), i)
	}
	insertProgressRow(t, "bk-10ch", "cb", 1) // second chapter -> 10%

	insertBookRow(t, "bk-half", "Half Book")
	for i := 0; i < 4; i++ {
		insertChapterRow(t, "bk-half", "h"+string(rune('a'+i)), i)
	}
	insertProgressRow(t, "bk-half", "hc", 2) // third of four -> 50%

	// A book with progress pointing at a chapter that no longer exists must
	// not break the listing (the JOIN simply drops it).
	insertBookRow(t, "bk-stale", "Stale Progress")
	insertChapterRow(t, "bk-stale", "s-a", 0)
	insertProgressRow(t, "bk-stale", "gone", 0)

	// A book that was never opened has no row at all.
	insertBookRow(t, "bk-fresh", "Never Opened")

	got, err := ListProgress()
	if err != nil {
		t.Fatalf("ListProgress: %v", err)
	}
	byBook := map[string]float64{}
	for _, p := range got {
		byBook[p.BookID] = p.Percent
	}
	if byBook["bk-10ch"] < 0.099 || byBook["bk-10ch"] > 0.101 {
		t.Fatalf("bk-10ch percent = %v, want 0.1", byBook["bk-10ch"])
	}
	if byBook["bk-half"] < 0.49 || byBook["bk-half"] > 0.51 {
		t.Fatalf("bk-half percent = %v, want 0.5", byBook["bk-half"])
	}
	if _, ok := byBook["bk-stale"]; ok {
		t.Fatalf("stale progress should be dropped, got %v", byBook["bk-stale"])
	}
	if _, ok := byBook["bk-fresh"]; ok {
		t.Fatalf("unopened book should be absent, got %v", byBook["bk-fresh"])
	}
}
