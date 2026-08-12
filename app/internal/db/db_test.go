package db

import (
	"testing"
)

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
