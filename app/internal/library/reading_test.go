package library

import (
	"testing"

	"epubmaker-desktop/internal/db"
)

// Marking a page is something the reader can do twice without meaning it: the
// bookmark drawer's button used to add a new bookmark on every press, so one
// page could accumulate a column of identical rows. Adding a spot that is
// already marked now returns the row that is there instead of a twin of it,
// which makes the operation safe to repeat and leaves the list one row per
// place in the book.
func TestAddBookmarkIsIdempotentPerSpot(t *testing.T) {
	resetLibraryTables(t)
	d, err := db.Open()
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	if _, err := d.Exec(`DELETE FROM bookmarks`); err != nil {
		t.Fatalf("reset bookmarks: %v", err)
	}
	insertBookRow(t, "b1", "Book")
	insertChapterRow(t, "b1", "c1", 0)

	first, err := AddBookmark("b1", "c1", 1200, "")
	if err != nil {
		t.Fatalf("first add: %v", err)
	}
	if first.ID == "" {
		t.Fatal("first add returned no id")
	}

	again, err := AddBookmark("b1", "c1", 1200, "")
	if err != nil {
		t.Fatalf("second add of the same spot should not fail: %v", err)
	}
	if again.ID != first.ID {
		t.Errorf("second add created %q, want the existing %q", again.ID, first.ID)
	}
	if again.CreatedAt != first.CreatedAt {
		t.Errorf("second add rewrote created_at: %q -> %q", first.CreatedAt, again.CreatedAt)
	}

	// A different spot is a different bookmark — the rule is per page, not per
	// chapter.
	other, err := AddBookmark("b1", "c1", 2400, "")
	if err != nil {
		t.Fatalf("add at another spot: %v", err)
	}
	if other.ID == first.ID {
		t.Error("a bookmark at another spot reused the first one")
	}

	list, err := ListBookmarks("b1")
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(list) != 2 {
		t.Fatalf("bookmarks = %d, want 2 (1200 and 2400)", len(list))
	}
}
