package db

import (
	"database/sql"
	"path/filepath"
	"testing"
)

// openTemp opens a throwaway database with the full schema. The config singleton
// points the whole process at one database, so a test that needs its own shelf
// drives sql.DB directly instead of going through Open().
func openTemp(t *testing.T) *sql.DB {
	t.Helper()
	path := filepath.Join(t.TempDir(), "test.db")
	d, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { d.Close() })
	if _, err := d.Exec(schema); err != nil {
		t.Fatal(err)
	}
	return d
}

// Chapter titles were once looked up with the nav href's fragment attached, so
// a book whose nav anchors every section ("…html#filepos109") never matched a
// spine document and every chapter kept its file's <title>. For 邓小平时代 that
// was the English cover title on all 18 chapters while the nav had the Chinese
// names. The import is fixed; this checks that existing shelves are re-derived
// from the toc JSON already in the database, without a re-import.
func TestMigrateRetitlesChaptersFromTOC(t *testing.T) {
	d := openTemp(t)
	toc := `[{"href":"split_000.html#filepos109","title":"扉　页"},
	         {"href":"split_000.html#filepos97506","title":"第1章 革命者"},
	         {"href":"split_001.html#filepos183975","title":"第2章 从放逐到返京"}]`
	if _, err := d.Exec(
		`INSERT INTO books (id, title, created_at, updated_at, toc) VALUES ('b1','邓小平时代','t','t',?)`,
		toc); err != nil {
		t.Fatal(err)
	}
	const english = "Deng Xiaoping and the Transformation of China (Chinese Edition)"
	ins := `INSERT INTO chapters (id, book_id, idx, title, href, created_at, updated_at)
	        VALUES (?, 'b1', ?, ?, ?, 't', 't')`
	for i, c := range []struct{ title, href string }{
		{english, "split_000.html"},
		{english, "split_001.html"},
		{"Cover", "titlepage.xhtml"},
	} {
		if _, err := d.Exec(ins, "c"+string(rune('1'+i)), i, c.title, c.href); err != nil {
			t.Fatal(err)
		}
	}

	if err := retitleChaptersFromTOC(d); err != nil {
		t.Fatalf("retitle: %v", err)
	}

	titles := map[string]string{}
	rows, err := d.Query(`SELECT href, title FROM chapters WHERE book_id = 'b1'`)
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var href, title string
		if err := rows.Scan(&href, &title); err != nil {
			t.Fatal(err)
		}
		titles[href] = title
	}
	rows.Close()

	if got := titles["split_000.html"]; got != "扉　页" {
		t.Errorf("split_000.html titled %q, want 扉　页", got)
	}
	if got := titles["split_001.html"]; got != "第2章 从放逐到返京" {
		t.Errorf("split_001.html titled %q, want 第2章 从放逐到返京", got)
	}
	// A document the nav never names keeps the title it had.
	if got := titles["titlepage.xhtml"]; got != "Cover" {
		t.Errorf("titlepage.xhtml titled %q, want Cover", got)
	}
}

// The migration is guarded by user_version: it must not run again on every open,
// since it is a full pass over every book and a title may have been corrected
// since.
func TestRetitleRunsOnce(t *testing.T) {
	d := openTemp(t)
	if _, err := d.Exec(
		`INSERT INTO books (id, title, created_at, updated_at, toc)
		 VALUES ('b1','t','t','t','[{"href":"a.html#x","title":"第一章"}]')`); err != nil {
		t.Fatal(err)
	}
	if _, err := d.Exec(
		`INSERT INTO chapters (id, book_id, idx, title, href, created_at, updated_at)
		 VALUES ('c1','b1',0,'旧标题','a.html','t','t')`); err != nil {
		t.Fatal(err)
	}
	if err := retitleChaptersFromTOC(d); err != nil {
		t.Fatal(err)
	}
	var first string
	if err := d.QueryRow(`SELECT title FROM chapters WHERE id = 'c1'`).Scan(&first); err != nil {
		t.Fatal(err)
	}
	if first != "第一章" {
		t.Fatalf("title after the first pass = %q, want 第一章", first)
	}
	if _, err := d.Exec(`UPDATE chapters SET title = '后来改过' WHERE id = 'c1'`); err != nil {
		t.Fatal(err)
	}
	if err := retitleChaptersFromTOC(d); err != nil {
		t.Fatal(err)
	}
	var second string
	if err := d.QueryRow(`SELECT title FROM chapters WHERE id = 'c1'`).Scan(&second); err != nil {
		t.Fatal(err)
	}
	if second != "后来改过" {
		t.Errorf("title after the second pass = %q, want the migration to stay put", second)
	}
}
