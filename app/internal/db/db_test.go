package db

import (
	"database/sql"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"epubmaker-desktop/internal/config"
)

// isolateHome points the config singleton at a throwaway home for one test and
// returns the database path inside it.
//
// t.Setenv alone is not enough. config caches the first path it resolved for the
// whole test binary, so a test that runs after any other config.Get() keeps
// writing to the earlier database — and which database that is depends on which
// test asked first. An earlier version of tx_test.go used only t.Setenv and left
// six test shelves in a developer's real ~/.epubmaker library. The reload below
// is what makes the answer independent of ordering.
func isolateHome(t *testing.T) string {
	t.Helper()
	Close() // the shared handle must not keep pointing at the previous home

	prev, had := os.LookupEnv("EPUBMAKER_HOME")
	os.Setenv("EPUBMAKER_HOME", t.TempDir())
	if _, err := config.Load(true); err != nil {
		t.Fatalf("config: %v", err)
	}
	t.Cleanup(func() {
		Close()
		if had {
			os.Setenv("EPUBMAKER_HOME", prev)
		} else {
			os.Unsetenv("EPUBMAKER_HOME")
		}
		_, _ = config.Load(true)
	})
	return config.Get().Paths.DbFile
}

// The guard for the bug isolateHome exists for: coming in after the cache is
// already warm must still land in a temp directory, never in the real home.
func TestIsolateHomeOverridesACachedConfig(t *testing.T) {
	// Warm the cache the way any earlier test would: whatever this process is
	// currently pointed at, which is the real home when the suite runs unfiltered.
	before, err := config.Load(true)
	if err != nil {
		t.Fatal(err)
	}

	got := isolateHome(t)
	if got == before.Paths.DbFile {
		t.Fatalf("isolateHome kept the cached database %s", got)
	}
	home := os.Getenv("EPUBMAKER_HOME")
	if !strings.HasPrefix(got, home+string(os.PathSeparator)) {
		t.Errorf("database %s is not under the temp home %s", got, home)
	}
}

// A notebook created before scheduling existed must gain the SRS columns on the
// next open, with defaults that make every old word due immediately rather than
// silently dropping it out of the queue.
func TestMigrateAddsSchedulingToOldNotebook(t *testing.T) {
	// Build the table as it looked before `reviews` even existed, then let Open
	// run the whole ALTER chain over it.
	path := isolateHome(t)
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
	path := isolateHome(t)
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

// A database written by a build that let the bookmark drawer add the same page
// over and over must come out of the migration with one bookmark per spot: the
// copies are dropped before the unique index goes on, because creating that
// index over a table that already holds copies would fail and take the whole
// open with it.
func TestMigrateCollapsesDuplicateBookmarks(t *testing.T) {
	path := isolateHome(t)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	old, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	// The DROPs are belt and braces: isolateHome gives this test a fresh file, so
	// the tables are absent already, but starting from the shape the bug left
	// behind should not depend on that.
	if _, err := old.Exec(`
		DROP TABLE IF EXISTS bookmarks;
		DROP TABLE IF EXISTS books;
		CREATE TABLE books (
		  id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '',
		  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
		CREATE TABLE bookmarks (
		  id TEXT PRIMARY KEY,
		  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
		  chapter_id TEXT NOT NULL,
		  anchor INTEGER NOT NULL DEFAULT 0,
		  label TEXT NOT NULL DEFAULT '',
		  created_at TEXT NOT NULL);`); err != nil {
		t.Fatal(err)
	}
	if _, err := old.Exec(`INSERT INTO books (id, title, created_at, updated_at)
	                       VALUES ('dup-book','t','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')`); err != nil {
		t.Fatal(err)
	}
	// Three presses on page 120, one on page 40: the first of the three is the
	// one that should survive, because it is the one the reader saw appear.
	for _, id := range []string{"bm1", "bm2", "bm3"} {
		if _, err := old.Exec(`INSERT INTO bookmarks (id, book_id, chapter_id, anchor, created_at)
		                       VALUES (?,'dup-book','c1',120,'2026-01-02T00:00:00Z')`, id); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := old.Exec(`INSERT INTO bookmarks (id, book_id, chapter_id, anchor, created_at)
	                       VALUES ('bm4','dup-book','c1',40,'2026-01-03T00:00:00Z')`); err != nil {
		t.Fatal(err)
	}
	_ = old.Close()

	d, err := Open()
	if err != nil {
		t.Fatalf("open db with duplicate bookmarks: %v", err)
	}
	defer Close()

	var n int
	if err := d.QueryRow(`SELECT COUNT(*) FROM bookmarks WHERE book_id = 'dup-book'`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 2 {
		t.Fatalf("bookmarks after migration = %d, want 2 (one per spot)", n)
	}
	var kept string
	if err := d.QueryRow(`SELECT id FROM bookmarks WHERE book_id = 'dup-book' AND anchor = 120`).Scan(&kept); err != nil {
		t.Fatal(err)
	}
	if kept != "bm1" {
		t.Errorf("kept %q, want the first copy bm1", kept)
	}

	// And the index is really there: the same spot cannot be inserted again.
	if _, err := d.Exec(`INSERT INTO bookmarks (id, book_id, chapter_id, anchor, created_at)
	                     VALUES ('bm5','dup-book','c1',120,'2026-01-04T00:00:00Z')`); err == nil {
		t.Error("a second bookmark for the same spot was accepted")
	}
}

func TestOpenAndMigrate(t *testing.T) {
	isolateHome(t)

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
