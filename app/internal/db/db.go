// Package db is a thin SQLite adapter over modernc.org/sqlite (pure Go, no
// cgo). It mirrors server/src/db.ts: only positional "?" parameters, and
// transactions use explicit BEGIN/COMMIT. Schema matches the TS version.
package db

import (
	"database/sql"
	"os"
	"path/filepath"

	_ "modernc.org/sqlite"

	"epubmaker-desktop/internal/config"
)

var inst *sql.DB

// Open returns the shared *sql.DB, opening and migrating on first call.
func Open() (*sql.DB, error) {
	if inst != nil {
		return inst, nil
	}
	c := config.Get()
	if err := os.MkdirAll(filepath.Dir(c.Paths.DbFile), 0o755); err != nil {
		return nil, err
	}
	d, err := sql.Open("sqlite", c.Paths.DbFile)
	if err != nil {
		return nil, err
	}
	// Single-user local app: one writer avoids lock contention.
	d.SetMaxOpenConns(1)
	if _, err := d.Exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;"); err != nil {
		return nil, err
	}
	if err := migrate(d); err != nil {
		return nil, err
	}
	inst = d
	return d, nil
}

const schema = `
CREATE TABLE IF NOT EXISTS books (
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
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS chapters (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  href TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chapters_book ON chapters(book_id, idx);

CREATE TABLE IF NOT EXISTS assets (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  href TEXT NOT NULL,
  media_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  size INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_assets_book ON assets(book_id);

-- Reading progress: one row per book, the last paged position.
-- position_offset is the layout-independent anchor (source character offset);
-- page_index is kept only for backwards compatibility / quick display.
CREATE TABLE IF NOT EXISTS reading_progress (
  book_id TEXT PRIMARY KEY REFERENCES books(id) ON DELETE CASCADE,
  chapter_id TEXT NOT NULL,
  page_index INTEGER NOT NULL DEFAULT 0,
  page_count INTEGER NOT NULL DEFAULT 0,
  position_offset INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

-- Bookmarks: a saved position (page index within a chapter) with an optional label.
CREATE TABLE IF NOT EXISTS bookmarks (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  chapter_id TEXT NOT NULL,
  anchor INTEGER NOT NULL DEFAULT 0,
  label TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bookmarks_book ON bookmarks(book_id, created_at);

-- Annotations: highlights (with optional note) over a character range of a chapter.
CREATE TABLE IF NOT EXISTS annotations (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  chapter_id TEXT NOT NULL,
  start_offset INTEGER NOT NULL DEFAULT 0,
  end_offset INTEGER NOT NULL DEFAULT 0,
  text TEXT NOT NULL DEFAULT '',
  color TEXT NOT NULL DEFAULT 'yellow',
  note TEXT NOT NULL DEFAULT '',
  page_index INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_annotations_book ON annotations(book_id, chapter_id);

-- Vocabulary notebook: one row per word, independent of any single book.
-- book_id/chapter_id are a plain pointer back to where the word was first met
-- (no foreign key: the notebook must outlive the book).
CREATE TABLE IF NOT EXISTS vocab (
  id TEXT PRIMARY KEY,
  term TEXT NOT NULL,
  surface TEXT NOT NULL DEFAULT '',
  book_id TEXT NOT NULL DEFAULT '',
  chapter_id TEXT NOT NULL DEFAULT '',
  start_offset INTEGER NOT NULL DEFAULT 0,
  context TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'new',
  lookups INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_vocab_term ON vocab(term);

-- Lookup signals: every word the reader looked up, with a counter, whether or
-- not it entered the notebook. A term is promoted into the vocab table only
-- after it has been looked up twice, so one-off curiosities don't pollute it.
CREATE TABLE IF NOT EXISTS vocab_seen (
  term TEXT PRIMARY KEY,
  lookups INTEGER NOT NULL DEFAULT 1,
  first_at TEXT NOT NULL,
  last_at TEXT NOT NULL
);
`

func migrate(d *sql.DB) error {
	if _, err := d.Exec(schema); err != nil {
		return err
	}
	// Migration: older DBs may lack the soft-delete column.
	_, _ = d.Exec(`ALTER TABLE books ADD COLUMN deleted_at TEXT`)
	// Migration: older DBs may lack the annotation page index.
	_, _ = d.Exec(`ALTER TABLE annotations ADD COLUMN page_index INTEGER NOT NULL DEFAULT 0`)
	// Migration: older DBs may lack the layout-independent progress anchor.
	_, _ = d.Exec(`ALTER TABLE reading_progress ADD COLUMN position_offset INTEGER NOT NULL DEFAULT 0`)
	// Migration: older DBs may lack the hierarchical TOC column.
	_, _ = d.Exec(`ALTER TABLE books ADD COLUMN toc TEXT`)
	// Backfill existing rows so the column is never NULL (Scan into sql.NullString
	// also tolerates NULL, but an empty string keeps queries/JSON predictable).
	_, _ = d.Exec(`UPDATE books SET toc = '' WHERE toc IS NULL`)
	return nil
}

// Close closes the shared database connection. Safe to call multiple times.
func Close() error {
	if inst == nil {
		return nil
	}
	err := inst.Close()
	inst = nil
	return err
}

// Tx runs fn inside a BEGIN/COMMIT transaction, rolling back on error.
func Tx(fn func() error) error {
	d, err := Open()
	if err != nil {
		return err
	}
	if _, err := d.Exec("BEGIN"); err != nil {
		return err
	}
	if err := fn(); err != nil {
		_, _ = d.Exec("ROLLBACK")
		return err
	}
	_, err = d.Exec("COMMIT")
	return err
}
