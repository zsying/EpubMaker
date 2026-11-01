package db

import (
	"database/sql"
	"path/filepath"
	"testing"
)

// A database from before shelves existed: books, no shelf_id, no shelves table.
// Opening it must not lose a book — every row has to end up on the default
// shelf, because the shelf page shows exactly one shelf and an unattached book
// would simply not be on it.
func TestMigrateBackfillsEveryBookOntoTheDefaultShelf(t *testing.T) {
	path := filepath.Join(t.TempDir(), "old.db")
	d, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()
	if _, err := d.Exec(`
		CREATE TABLE books (
		  id TEXT PRIMARY KEY,
		  title TEXT NOT NULL DEFAULT '',
		  author TEXT NOT NULL DEFAULT '',
		  language TEXT NOT NULL DEFAULT 'zh',
		  publisher TEXT NOT NULL DEFAULT '',
		  description TEXT NOT NULL DEFAULT '',
		  identifier TEXT NOT NULL DEFAULT '',
		  cover_href TEXT,
		  source_name TEXT,
		  created_at TEXT NOT NULL,
		  updated_at TEXT NOT NULL,
		  deleted_at TEXT,
		  toc TEXT,
		  tags TEXT,
		  file_hash TEXT
		)`); err != nil {
		t.Fatal(err)
	}
	for _, q := range []string{
		`INSERT INTO books (id,title,created_at,updated_at,tags,file_hash) VALUES ('b1','一号','t','t','','h1')`,
		`INSERT INTO books (id,title,created_at,updated_at,tags,file_hash) VALUES ('b2','二号','t','t','','h2')`,
	} {
		if _, err := d.Exec(q); err != nil {
			t.Fatal(err)
		}
	}

	if err := migrate(d); err != nil {
		t.Fatalf("migrate: %v", err)
	}

	var shelves, onDefault int
	if err := d.QueryRow(`SELECT COUNT(*) FROM shelves`).Scan(&shelves); err != nil {
		t.Fatalf("count shelves: %v", err)
	}
	if shelves != 1 {
		t.Fatalf("want exactly the default shelf, got %d", shelves)
	}
	var name string
	if err := d.QueryRow(`SELECT name FROM shelves WHERE id = 'default'`).Scan(&name); err != nil {
		t.Fatalf("default shelf: %v", err)
	}
	if name != "书架" {
		t.Fatalf("default shelf name: %q", name)
	}
	if err := d.QueryRow(`SELECT COUNT(*) FROM books WHERE shelf_id = 'default'`).Scan(&onDefault); err != nil {
		t.Fatalf("count books on default: %v", err)
	}
	if onDefault != 2 {
		t.Fatalf("both books should be on the default shelf, got %d", onDefault)
	}

	// Idempotent: a second open must not duplicate the shelf or move anything.
	if err := migrate(d); err != nil {
		t.Fatalf("second migrate: %v", err)
	}
	if err := d.QueryRow(`SELECT COUNT(*) FROM shelves`).Scan(&shelves); err != nil {
		t.Fatal(err)
	}
	if shelves != 1 {
		t.Fatalf("migration is not idempotent: %d shelves", shelves)
	}
}
