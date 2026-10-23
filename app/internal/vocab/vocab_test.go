package vocab

import (
	"os"
	"testing"

	"epubmaker-desktop/internal/db"
)

func TestMain(m *testing.M) {
	dir, err := os.MkdirTemp("", "epubmaker-vocab-test")
	if err != nil {
		panic(err)
	}
	os.Setenv("EPUBMAKER_HOME", dir)
	code := m.Run()
	_ = db.Close()
	_ = os.RemoveAll(dir)
	os.Exit(code)
}

func reset(t *testing.T) {
	t.Helper()
	d, err := db.Open()
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	if _, err := d.Exec(`DELETE FROM vocab`); err != nil {
		t.Fatalf("reset vocab: %v", err)
	}
	if _, err := d.Exec(`DELETE FROM vocab_seen`); err != nil {
		t.Fatalf("reset vocab_seen: %v", err)
	}
}

func TestRecordCreatesNewEntry(t *testing.T) {
	reset(t)
	v, err := Record("climb", "climbed", "b1", "c1", 120, "he climbed the hill")
	if err != nil {
		t.Fatalf("Record: %v", err)
	}
	if v.ID == "" {
		t.Error("ID should be assigned")
	}
	if v.Status != StatusNew {
		t.Errorf("status = %q, want %q", v.Status, StatusNew)
	}
	if v.Lookups != 1 {
		t.Errorf("lookups = %d, want 1", v.Lookups)
	}
	if v.Context != "he climbed the hill" {
		t.Errorf("context = %q", v.Context)
	}
	if v.BookID != "b1" || v.ChapterID != "c1" || v.Offset != 120 {
		t.Errorf("provenance not stored: %+v", v)
	}
}

// Looking the same word up again must not create a second row, must keep the
// first context (a good example sentence is worth more than the latest one),
// and must count the repeat so reading difficulty can be inferred later.
func TestRecordAgainBumpsLookupsAndKeepsFirstContext(t *testing.T) {
	reset(t)
	first, err := Record("climb", "climbed", "b1", "c1", 120, "he climbed the hill")
	if err != nil {
		t.Fatal(err)
	}
	second, err := Record("climb", "climbing", "b2", "c9", 40, "climbing is hard")
	if err != nil {
		t.Fatal(err)
	}
	if second.ID != first.ID {
		t.Errorf("expected the same row, got %s and %s", first.ID, second.ID)
	}
	if second.Lookups != 2 {
		t.Errorf("lookups = %d, want 2", second.Lookups)
	}
	if second.Context != "he climbed the hill" {
		t.Errorf("context = %q, want the first one preserved", second.Context)
	}
	if second.BookID != "b1" || second.ChapterID != "c1" {
		t.Errorf("provenance should stay on the first occurrence: %+v", second)
	}
}

func TestRecordNormalizesTerm(t *testing.T) {
	reset(t)
	v, err := Record("  Climb ", "", "", "", 0, "")
	if err != nil {
		t.Fatal(err)
	}
	if v.Term != "climb" {
		t.Errorf("term = %q, want lowercased/trimmed", v.Term)
	}
	if _, err := Record("", "x", "", "", 0, ""); err == nil {
		t.Error("empty term should be rejected")
	}
}

// A vocabulary entry outlives the book it came from: the user still wants to
// review the word after deleting the book, so there is no foreign key.
func TestRecordSurvivesDeletedBook(t *testing.T) {
	reset(t)
	if _, err := Record("climb", "climbed", "gone-book", "gone-chapter", 10, "ctx"); err != nil {
		t.Fatalf("Record with unknown book id should succeed, got %v", err)
	}
	v, err := Get("climb")
	if err != nil {
		t.Fatal(err)
	}
	if v == nil || v.BookID != "gone-book" {
		t.Fatalf("entry lost its provenance: %+v", v)
	}
}

func TestGetMissingReturnsNil(t *testing.T) {
	reset(t)
	v, err := Get("nothing")
	if err != nil {
		t.Fatal(err)
	}
	if v != nil {
		t.Fatalf("want nil, got %+v", v)
	}
}

func TestListFiltersByStatusAndKeyword(t *testing.T) {
	reset(t)
	if _, err := Record("climb", "", "", "", 0, ""); err != nil {
		t.Fatal(err)
	}
	b, err := Record("blorp", "", "", "", 0, "")
	if err != nil {
		t.Fatal(err)
	}
	if err := UpdateStatus(b.ID, StatusKnown); err != nil {
		t.Fatal(err)
	}

	known, err := List(ListOpts{Status: StatusKnown})
	if err != nil {
		t.Fatal(err)
	}
	if len(known) != 1 || known[0].Term != "blorp" {
		t.Fatalf("status filter failed: %+v", known)
	}

	all, err := List(ListOpts{})
	if err != nil {
		t.Fatal(err)
	}
	if len(all) != 2 {
		t.Fatalf("expected 2 entries, got %d", len(all))
	}

	kw, err := List(ListOpts{Keyword: "cli"})
	if err != nil {
		t.Fatal(err)
	}
	if len(kw) != 1 || kw[0].Term != "climb" {
		t.Fatalf("keyword filter failed: %+v", kw)
	}
}

func TestUpdateStatusValidates(t *testing.T) {
	reset(t)
	v, err := Record("climb", "", "", "", 0, "")
	if err != nil {
		t.Fatal(err)
	}
	if err := UpdateStatus(v.ID, StatusLearning); err != nil {
		t.Fatal(err)
	}
	got, err := Get("climb")
	if err != nil {
		t.Fatal(err)
	}
	if got.Status != StatusLearning {
		t.Errorf("status = %q", got.Status)
	}
	if err := UpdateStatus(v.ID, "bogus"); err == nil {
		t.Error("invalid status should be rejected")
	}
}

func TestDelete(t *testing.T) {
	reset(t)
	v, err := Record("climb", "", "", "", 0, "")
	if err != nil {
		t.Fatal(err)
	}
	if err := Delete(v.ID); err != nil {
		t.Fatal(err)
	}
	got, err := Get("climb")
	if err != nil {
		t.Fatal(err)
	}
	if got != nil {
		t.Fatalf("entry survived delete: %+v", got)
	}
}

/* ----------------------------- lookup signals ----------------------------- */

func TestNoteSeenCountsAndDoesNotRecord(t *testing.T) {
	reset(t)
	for i := 1; i <= 3; i++ {
		n, err := NoteSeen("  Blorp ")
		if err != nil {
			t.Fatalf("NoteSeen #%d: %v", i, err)
		}
		if n != i {
			t.Errorf("NoteSeen #%d returned %d", i, n)
		}
	}
	if v, err := Get("blorp"); err != nil {
		t.Fatal(err)
	} else if v != nil {
		t.Fatalf("NoteSeen must not add to the notebook, got %+v", v)
	}
	if n, err := SeenCount("blorp"); err != nil || n != 3 {
		t.Errorf("SeenCount = %d, %v; want 3", n, err)
	}
}

func TestSeenCountUnknownTerm(t *testing.T) {
	reset(t)
	n, err := SeenCount("nothing")
	if err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Errorf("SeenCount = %d, want 0", n)
	}
}

// A word that already entered the notebook does not need its signal counter
// any more; dropping it keeps the table from growing forever.
func TestDropSeen(t *testing.T) {
	reset(t)
	if _, err := NoteSeen("blorp"); err != nil {
		t.Fatal(err)
	}
	if err := DropSeen("blorp"); err != nil {
		t.Fatal(err)
	}
	if n, err := SeenCount("blorp"); err != nil || n != 0 {
		t.Fatalf("SeenCount = %d, %v; want 0 after DropSeen", n, err)
	}
}
