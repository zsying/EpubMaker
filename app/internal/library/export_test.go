package library

import (
	"archive/zip"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"epubmaker-desktop/internal/storage"
)

// seedExportableBook makes a one-chapter book whose chapter file exists on disk,
// which is what BuildExportInput reads.
func seedExportableBook(t *testing.T) {
	t.Helper()
	resetShelfState(t)
	insertBookOnShelf(t, "b1", "书名", DefaultShelfID)
	insertChapterRow(t, "b1", "c1", 0)
	if err := storage.WriteContent("b1", "chc1.xhtml",
		[]byte(`<html><body><h1>第一章</h1><p>正文</p></body></html>`)); err != nil {
		t.Fatalf("write chapter: %v", err)
	}
}

// The export used to be assembled in memory and base64'd back through the
// WebView: a 300-page book is tens of megabytes of Go heap plus a third more as
// a string, and the desktop had nowhere to put the result except the browser's
// download. Writing straight to the destination is what makes 另存为 possible.
func TestExportBookToFileWritesARealEpub(t *testing.T) {
	seedExportableBook(t)

	dst := filepath.Join(t.TempDir(), "out.epub")
	if err := ExportBookToFile("b1", dst); err != nil {
		t.Fatalf("ExportBookToFile: %v", err)
	}

	zr, err := zip.OpenReader(dst)
	if err != nil {
		t.Fatalf("the exported file is not a zip: %v", err)
	}
	defer zr.Close()
	// A complete EPUB needs its container and package document; a truncated one
	// (the failure this path is supposed to make impossible) has neither.
	seen := map[string]bool{}
	for _, f := range zr.File {
		seen[f.Name] = true
	}
	for _, want := range []string{"mimetype", "META-INF/container.xml"} {
		if !seen[want] {
			t.Errorf("the archive has no %s: %v", want, seen)
		}
	}
}

// Exporting over an existing file is the normal case: the reader picks the same
// name twice, or re-exports after an edit.
func TestExportBookToFileOverwrites(t *testing.T) {
	seedExportableBook(t)

	dst := filepath.Join(t.TempDir(), "same.epub")
	if err := os.WriteFile(dst, []byte("an older export"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := ExportBookToFile("b1", dst); err != nil {
		t.Fatalf("ExportBookToFile over an existing file: %v", err)
	}
	zr, err := zip.OpenReader(dst)
	if err != nil {
		t.Fatalf("the old contents survived: %v", err)
	}
	zr.Close()
}

// A failed build must leave nothing behind — not at the destination, and not as
// a stray temp file next to it. Half an .epub that opens in a reader is worse
// than no file at all.
func TestFailedExportLeavesNoFileBehind(t *testing.T) {
	seedExportableBook(t)

	dir := t.TempDir()
	dst := filepath.Join(dir, "missing.epub")
	if err := ExportBookToFile("nope", dst); err == nil {
		t.Fatal("exporting a book that does not exist must fail")
	}
	if _, err := os.Stat(dst); !os.IsNotExist(err) {
		t.Errorf("a failed export left a file at %s", dst)
	}
	left, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range left {
		if strings.HasPrefix(e.Name(), ".export-") {
			t.Errorf("temp file left behind: %s", e.Name())
		}
	}
}

// A locked shelf's export goes through GetBookRow, so it is refused before any
// bytes are written.
func TestExportToFileRefusesALockedShelf(t *testing.T) {
	seedLockedShelf(t)

	dst := filepath.Join(t.TempDir(), "locked.epub")
	if err := ExportBookToFile("b1", dst); err == nil {
		t.Fatal("a locked shelf's book must not be exportable")
	}
	if _, err := os.Stat(dst); !os.IsNotExist(err) {
		t.Error("the refused export still produced a file")
	}
}
