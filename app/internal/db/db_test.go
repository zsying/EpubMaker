package db

import (
	"database/sql"
	"os"
	"path/filepath"
	"strconv"
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

// The lookup history is newer than both tables it can be derived from, so an
// existing database must not start with an empty history page: the migration
// seeds it from the pending-lookup counters and the notebook itself.
func TestMigrateSeedsLookupHistory(t *testing.T) {
	t.Setenv("EPUBMAKER_HOME", t.TempDir())

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
		  id TEXT PRIMARY KEY, term TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'new',
		  lookups INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
		CREATE TABLE vocab_seen (
		  term TEXT PRIMARY KEY, lookups INTEGER NOT NULL DEFAULT 1,
		  first_at TEXT NOT NULL, last_at TEXT NOT NULL);`); err != nil {
		t.Fatal(err)
	}
	if _, err := old.Exec(`INSERT INTO vocab (id, term, lookups, created_at, updated_at)
	                       VALUES ('v1','blorp',4,'2026-01-01T00:00:00Z','2026-01-02T00:00:00Z')`); err != nil {
		t.Fatal(err)
	}
	if _, err := old.Exec(`INSERT INTO vocab_seen (term, lookups, first_at, last_at)
	                       VALUES ('clatter',2,'2026-01-03T00:00:00Z','2026-01-04T00:00:00Z')`); err != nil {
		t.Fatal(err)
	}
	_ = old.Close()

	d, err := Open()
	if err != nil {
		t.Fatalf("open old db: %v", err)
	}
	defer Close()

	rows, err := d.Query(`SELECT term, lookups, first_at, last_at FROM lookup_history ORDER BY term`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	got := map[string][3]string{}
	for rows.Next() {
		var term, first, last string
		var lookups int
		if err := rows.Scan(&term, &lookups, &first, &last); err != nil {
			t.Fatal(err)
		}
		got[term] = [3]string{strconv.Itoa(lookups), first, last}
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 {
		t.Fatalf("history = %v, want blorp and clatter", got)
	}
	if g := got["blorp"]; g != [3]string{"4", "2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z"} {
		t.Errorf("blorp = %v, want its notebook row's counter and dates", g)
	}
	if g := got["clatter"]; g != [3]string{"2", "2026-01-03T00:00:00Z", "2026-01-04T00:00:00Z"} {
		t.Errorf("clatter = %v, want its pending counter and dates", g)
	}

	// Opening again must not double count: the seed is a one-time backfill.
	Close()
	d2, err := Open()
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	var n, lookups int
	if err := d2.QueryRow(`SELECT COUNT(*), MAX(lookups) FROM lookup_history`).Scan(&n, &lookups); err != nil {
		t.Fatal(err)
	}
	if n != 2 || lookups != 4 {
		t.Errorf("after reopen: %d rows, max lookups %d", n, lookups)
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
