package library

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"epubmaker-desktop/internal/db"
	"epubmaker-desktop/internal/epub"
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

// buildEpubFile writes a real one-chapter EPUB to a temp file and returns its
// path (and the parsed bytes' identity is irrelevant — the hash is what counts).
func buildEpubFile(t *testing.T, title, identifier string) string {
	t.Helper()
	var buf bytes.Buffer
	err := epub.BuildEpub(epub.BuildInput{
		Title:      title,
		Author:     "作者A",
		Language:   "zh",
		Identifier: identifier,
		Chapters: []epub.BuildChapter{
			{Title: "第一章", Href: "OEBPS/ch1.xhtml", Content: []byte(`<html xmlns="http://www.w3.org/1999/xhtml"><body><p>正文</p></body></html>`)},
		},
	}, &buf)
	if err != nil {
		t.Fatalf("build epub: %v", err)
	}
	path := filepath.Join(t.TempDir(), strings.ReplaceAll(title, " ", "_")+".epub")
	if err := os.WriteFile(path, buf.Bytes(), 0o644); err != nil {
		t.Fatalf("write epub: %v", err)
	}
	return path
}

// Importing the same file twice must not create a second shelf entry: the
// second import is a skip (ErrDuplicate), and the shelf still has one book.
// A book sitting in the trash does not block a fresh import.
func TestImportEpubDuplicate(t *testing.T) {
	resetLibraryTables(t)

	path := buildEpubFile(t, "Duplicate Target", "urn:uuid:test-dup-1")

	first, err := ImportEpub(path, filepath.Base(path))
	if err != nil {
		t.Fatalf("first import: %v", err)
	}
	if first == nil {
		t.Fatal("first import returned nil")
	}

	_, err = ImportEpub(path, filepath.Base(path))
	if !errors.Is(err, ErrDuplicate) {
		t.Fatalf("second import should be ErrDuplicate, got %v", err)
	}

	books, err := ListBooks("")
	if err != nil {
		t.Fatalf("ListBooks: %v", err)
	}
	if len(books) != 1 {
		t.Fatalf("shelf should hold exactly 1 book, got %d", len(books))
	}

	// Trash the copy: the identifier/hash must no longer block a re-import.
	d, err := db.Open()
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	if _, err := d.Exec(`UPDATE books SET deleted_at = ? WHERE id = ?`,
		time.Now().UTC().Format(time.RFC3339), first.ID); err != nil {
		t.Fatalf("trash book: %v", err)
	}
	re, err := ImportEpub(path, filepath.Base(path))
	if err != nil {
		t.Fatalf("re-import after trash should succeed, got %v", err)
	}
	if re == nil || re.ID == first.ID {
		t.Fatalf("re-import should create a new book, got %#v", re)
	}
}

// Books imported before hashing existed carry no file_hash; their epub
// identifier is the fallback dedupe key — but only with a matching title:
// z-library epubs reuse identifiers across unrelated books, and the bare
// identifier once refused a Kissinger set because a 150-book erotica bundle
// happened to carry the same urn:uuid.
func TestFindDuplicateByIdentifier(t *testing.T) {
	resetLibraryTables(t)
	insertBookRow(t, "bk-legacy", "Legacy Book")
	d, err := db.Open()
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	if _, err := d.Exec(`UPDATE books SET identifier = ? WHERE id = ?`, "urn:uuid:legacy-1", "bk-legacy"); err != nil {
		t.Fatalf("set identifier: %v", err)
	}

	title, found, err := findDuplicate("deadbeef", "urn:uuid:legacy-1", "Legacy Book")
	if err != nil || !found || title != "Legacy Book" {
		t.Fatalf("identifier match failed: title=%q found=%v err=%v", title, found, err)
	}

	// Case and whitespace noise between rips of the same book still match.
	if _, found, err := findDuplicate("deadbeef", "urn:uuid:legacy-1", "  legacy   BOOK "); err != nil || !found {
		t.Fatalf("loose title match failed: found=%v err=%v", found, err)
	}

	// An empty identifier must never match (every legacy row has one).
	if _, found, err := findDuplicate("deadbeef", "", "Legacy Book"); err != nil || found {
		t.Fatalf("empty identifier must not match, found=%v err=%v", found, err)
	}
}

// The z-library collision: same identifier, different book. The identifier
// alone must not veto the import — only a title match may.
func TestFindDuplicateIdentifierCollision(t *testing.T) {
	resetLibraryTables(t)
	insertBookRow(t, "bk-other", "TABOO: MEGA Bundle 150 BOOKS")
	d, err := db.Open()
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	if _, err := d.Exec(`UPDATE books SET identifier = ? WHERE id = ?`, "urn:uuid:shared-1", "bk-other"); err != nil {
		t.Fatalf("set identifier: %v", err)
	}

	if _, found, err := findDuplicate("deadbeef", "urn:uuid:shared-1", "基辛格作品：论中国+世界秩序（套装共2册）"); err != nil || found {
		t.Fatalf("identifier collision with a different title must not match: found=%v err=%v", found, err)
	}
}
