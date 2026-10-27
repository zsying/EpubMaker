// Package db is a thin SQLite adapter over modernc.org/sqlite (pure Go, no
// cgo). It mirrors server/src/db.ts: only positional "?" parameters, and
// transactions use explicit BEGIN/COMMIT. Schema matches the TS version.
package db

import (
	"database/sql"
	"os"
	"path/filepath"
	"time"

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
  deleted_at TEXT,
  toc TEXT,
  tags TEXT,
  file_hash TEXT
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
  reviews INTEGER NOT NULL DEFAULT 0,
  last_reviewed_at TEXT NOT NULL DEFAULT '',
  -- Spaced repetition state. due_at is RFC3339 in UTC at second precision and
  -- an empty string means "never scheduled" (due now), which is also what every
  -- row created before scheduling existed gets.
  interval_days REAL NOT NULL DEFAULT 0,
  ease REAL NOT NULL DEFAULT 2.5,
  due_at TEXT NOT NULL DEFAULT '',
  streak INTEGER NOT NULL DEFAULT 0,
  lapses INTEGER NOT NULL DEFAULT 0,
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

-- Lookup history: the plain log of "what have I looked up". It is deliberately
-- wider than vocab_seen — which throws a term away once it is promoted — and
-- narrower than vocab: it records only a term, when it was first and last
-- looked up, and how often. No gloss, no book, no status: those are the
-- dictionary's and the notebook's business, joined in at read time.
CREATE TABLE IF NOT EXISTS lookup_history (
  term TEXT PRIMARY KEY,
  lookups INTEGER NOT NULL DEFAULT 1,
  first_at TEXT NOT NULL,
  last_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_lookup_history_last ON lookup_history(last_at);

-- Glosses fetched from a public dictionary when the local one had nothing.
--
-- Deliberately in this database, not in dict.db: dict.db is rebuilt from an
-- ECDICT csv import (ImportCSV replaces the whole file), and the telephone
-- ships with a trimmed 150k-entry build of it. A gloss the reader had to go
-- online for must survive both of those.
CREATE TABLE IF NOT EXISTS dict_online (
  term        TEXT PRIMARY KEY,
  word        TEXT NOT NULL DEFAULT '',
  phonetic    TEXT NOT NULL DEFAULT '',
  translation TEXT NOT NULL DEFAULT '',
  definition  TEXT NOT NULL DEFAULT '',
  source      TEXT NOT NULL DEFAULT '',
  fetched_at  TEXT NOT NULL DEFAULT ''
);

-- AI answers, cached per capability + input hash. The key is composed by the
-- aicache package (kind + sha256 of the exact prompt input); response is the
-- capability's own JSON result. An empty response is a tombstone: the
-- provider answered "nothing to say", and the question is not asked again.
-- Network and HTTP failures never reach this table — only valid answers do,
-- so a flaky provider stays retryable and a changed key stays re-askable.
CREATE TABLE IF NOT EXISTS ai_cache (
  key        TEXT PRIMARY KEY,
  kind       TEXT NOT NULL DEFAULT '',
  response   TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT ''
);

-- AI conversations: one transcript per explain / parse / summarize answer,
-- plus any chat the reader started by hand. cache_key ties the transcript to
-- the ai_cache row of the call that created it, so the same question answered
-- twice records once. origin says where it came from (lookup / parse /
-- summarize / manual); the reader sees it as a badge on the list page.
CREATE TABLE IF NOT EXISTS ai_conversations (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL DEFAULT '',
  origin     TEXT NOT NULL DEFAULT 'manual',
  cache_key  TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_aichat_updated ON ai_conversations(updated_at);

-- The transcript itself: the system prompt is stored as a message too, so the
-- conversation page can show everything that actually went to the provider.
CREATE TABLE IF NOT EXISTS ai_messages (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE,
  role            TEXT NOT NULL DEFAULT 'user',
  content         TEXT NOT NULL DEFAULT '',
  created_at      TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_aimsg_conv ON ai_messages(conversation_id);

-- System prompts the reader has saved in the LLM settings page and picks from
-- when starting a hand-made conversation. The prompt a conversation actually
-- used is stored as its first message (see ai_messages), so this table is a
-- library, not a source of truth: editing or deleting a prompt never rewrites
-- an existing transcript.
CREATE TABLE IF NOT EXISTS ai_prompts (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL DEFAULT '',
  content    TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT ''
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
	// Migration: user-managed tags live on the book row as a JSON array
	// ("" for none). Appended after toc, so "SELECT *" column order stays
	// stable across fresh and migrated databases alike.
	_, _ = d.Exec(`ALTER TABLE books ADD COLUMN tags TEXT`)
	_, _ = d.Exec(`UPDATE books SET tags = '' WHERE tags IS NULL`)
	// Migration: sha256 of the imported EPUB file — the dedupe key that keeps
	// the same file from landing on the shelf twice. Appended after tags.
	// Older rows keep '' and fall back to the epub identifier on matching.
	_, _ = d.Exec(`ALTER TABLE books ADD COLUMN file_hash TEXT`)
	_, _ = d.Exec(`UPDATE books SET file_hash = '' WHERE file_hash IS NULL`)
	// Backfill existing rows so the column is never NULL (Scan into sql.NullString
	// also tolerates NULL, but an empty string keeps queries/JSON predictable).
	_, _ = d.Exec(`UPDATE books SET toc = '' WHERE toc IS NULL`)
	// Migration: older DBs recorded no review history, so "learning" had no
	// evidence behind it and the review queue could not be ordered.
	_, _ = d.Exec(`ALTER TABLE vocab ADD COLUMN reviews INTEGER NOT NULL DEFAULT 0`)
	_, _ = d.Exec(`ALTER TABLE vocab ADD COLUMN last_reviewed_at TEXT NOT NULL DEFAULT ''`)
	// Migration: the review queue was an order, not a schedule. Existing rows
	// start with due_at = '' (due now) and the default ease, so the first pass
	// over an old notebook simply schedules everything from scratch.
	_, _ = d.Exec(`ALTER TABLE vocab ADD COLUMN interval_days REAL NOT NULL DEFAULT 0`)
	_, _ = d.Exec(`ALTER TABLE vocab ADD COLUMN ease REAL NOT NULL DEFAULT 2.5`)
	_, _ = d.Exec(`ALTER TABLE vocab ADD COLUMN due_at TEXT NOT NULL DEFAULT ''`)
	_, _ = d.Exec(`ALTER TABLE vocab ADD COLUMN streak INTEGER NOT NULL DEFAULT 0`)
	_, _ = d.Exec(`ALTER TABLE vocab ADD COLUMN lapses INTEGER NOT NULL DEFAULT 0`)
	// Words already marked known were "never asked again" under the old model.
	// Left at due_at = '' they would all flood the first scheduled pass, which is
	// the opposite of what the reader said about them. Give them the same three
	// weeks a hand-marked word gets; the WHERE makes this a one-time backfill.
	// (learning/new words stay due now — they genuinely need asking.)
	_, _ = d.Exec(`UPDATE vocab SET interval_days = 21, due_at = ?
	                WHERE status = 'known' AND due_at = ''`,
		time.Now().UTC().Add(21*24*time.Hour).Format("2006-01-02T15:04:05Z"))
	// The lookup history arrived after both of those tables had been filling
	// up, so seed it from what the older bookkeeping already knows: the
	// pending-lookup counters and the notebook rows themselves. OR IGNORE makes
	// this a no-op on every later start, and a promotion that consumed a
	// vocab_seen row still leaves the term in the log where it belongs.
	_, _ = d.Exec(`INSERT OR IGNORE INTO lookup_history (term, lookups, first_at, last_at)
	                SELECT term, lookups, first_at, last_at FROM vocab_seen`)
	_, _ = d.Exec(`INSERT OR IGNORE INTO lookup_history (term, lookups, first_at, last_at)
	                SELECT term, lookups, created_at, updated_at FROM vocab`)
	// A bookmark is a spot in a chapter, so the same spot is one bookmark.
	// Builds before this one let the bookmark drawer's 添加当前页 button insert the
	// same page again on every press; keep the first copy of each spot, then put
	// a unique index in place so no caller can do that again. The copies have to
	// go first: creating the index over a database that already holds duplicates
	// fails, and the schema block above runs before this point on every open.
	_, _ = d.Exec(`DELETE FROM bookmarks WHERE rowid NOT IN (
	                 SELECT MIN(rowid) FROM bookmarks GROUP BY book_id, chapter_id, anchor)`)
	_, _ = d.Exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_bookmarks_page
	               ON bookmarks(book_id, chapter_id, anchor)`)
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
