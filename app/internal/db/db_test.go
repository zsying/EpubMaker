package db

import (
	"database/sql"
	"os"
	"path/filepath"
	"testing"

	"epubmaker-desktop/internal/config"
)

// A notebook created before scheduling existed must gain the SRS columns on the
// next open, with defaults that make every old word due immediately rather than
// silently dropping it out of the queue.
func TestMigrateAddsSchedulingToOldNotebook(t *testing.T) {
	t.Setenv("EPUBMAKER_HOME", t.TempDir())

	// Build the table as it looked before `reviews` even existed, then let Open
	// run the whole ALTER chain over it.
	path := config.Get().Paths.DbFile
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	old, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := old.Exec(`
		CREATE TABLE vocab (
		  id TEXT PRIMARY KEY, term TEXT NOT NULL, surface TEXT NOT NULL DEFAULT '',
		  book_id TEXT NOT NULL DEFAULT '', chapter_id TEXT NOT NULL DEFAULT '',
		  start_offset INTEGER NOT NULL DEFAULT 0, context TEXT NOT NULL DEFAULT '',
		  status TEXT NOT NULL DEFAULT 'new', lookups INTEGER NOT NULL DEFAULT 1,
		  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);`); err != nil {
		t.Fatal(err)
	}
	if _, err := old.Exec(`INSERT INTO vocab (id, term, created_at, updated_at) VALUES ('v1','blorp','t','t')`); err != nil {
		t.Fatal(err)
	}
	_ = old.Close()

	d, err := Open()
	if err != nil {
		t.Fatalf("open old db: %v", err)
	}
	defer Close()

	var interval, ease float64
	var dueAt string
	var streak, lapses, reviews int
	if err := d.QueryRow(
		`SELECT interval_days, ease, due_at, streak, lapses, reviews FROM vocab WHERE id = 'v1'`,
	).Scan(&interval, &ease, &dueAt, &streak, &lapses, &reviews); err != nil {
		t.Fatalf("old row did not survive the migration: %v", err)
	}
	if interval != 0 || dueAt != "" {
		t.Errorf("old word should be due now: interval=%v due=%q", interval, dueAt)
	}
	if ease != 2.5 {
		t.Errorf("ease = %v, want the SM-2 default 2.5", ease)
	}
	if streak != 0 || lapses != 0 || reviews != 0 {
		t.Errorf("streak/lapses/reviews = %d/%d/%d, want zeros", streak, lapses, reviews)
	}
}

func TestOpenAndMigrate(t *testing.T) {
	t.Setenv("EPUBMAKER_HOME", t.TempDir())

	d, err := Open()
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer Close()

	var n int
	if err := d.QueryRow("SELECT count(*) FROM books").Scan(&n); err != nil {
		t.Fatalf("query books: %v", err)
	}

	// Positional "?" params + Tx helper.
	if err := Tx(func() error {
		_, e := d.Exec(
			"INSERT INTO books(id,title,created_at,updated_at) VALUES(?,?,?,?)",
			"b1", "t", "now", "now",
		)
		return e
	}); err != nil {
		t.Fatalf("tx insert: %v", err)
	}

	var cnt int
	if err := d.QueryRow("SELECT count(*) FROM books WHERE id=?", "b1").Scan(&cnt); err != nil {
		t.Fatalf("count: %v", err)
	}
	if cnt != 1 {
		t.Fatalf("expected 1 book, got %d", cnt)
	}
}
