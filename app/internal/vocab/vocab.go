// Package vocab is the vocabulary notebook: every word the reader looked up
// while reading, with the sentence it came from and a pointer back to that
// spot in the book.
//
// A word is stored once, globally — not per book. The notebook is the user's
// own asset: deleting or finishing a book must not remove the words learned
// from it, so book_id/chapter_id are plain columns with no foreign key.
package vocab

import (
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"strings"
	"time"

	"epubmaker-desktop/internal/db"
)

// Entry status. `known` and `ignored` both stop the word from being surfaced,
// but `ignored` also means "never record this again".
const (
	StatusNew      = "new"
	StatusLearning = "learning"
	StatusKnown    = "known"
	StatusIgnored  = "ignored"
)

var validStatus = map[string]bool{
	StatusNew: true, StatusLearning: true, StatusKnown: true, StatusIgnored: true,
}

// Entry is one notebook row.
type Entry struct {
	ID        string `json:"id"`
	Term      string `json:"term"`
	Surface   string `json:"surface"`
	BookID    string `json:"bookId"`
	ChapterID string `json:"chapterId"`
	Offset    int    `json:"offset"`
	Context   string `json:"context"`
	Status    string `json:"status"`
	Lookups   int    `json:"lookups"`
	CreatedAt string `json:"createdAt"`
	UpdatedAt string `json:"updatedAt"`
}

// ListOpts filters List. Zero values mean "no filter".
type ListOpts struct {
	Status  string
	Keyword string
	Limit   int
}

const columns = `id, term, surface, book_id, chapter_id, start_offset, context, status, lookups, created_at, updated_at`

func scan(row interface{ Scan(...any) error }) (*Entry, error) {
	e := &Entry{}
	err := row.Scan(&e.ID, &e.Term, &e.Surface, &e.BookID, &e.ChapterID,
		&e.Offset, &e.Context, &e.Status, &e.Lookups, &e.CreatedAt, &e.UpdatedAt)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	return e, nil
}

// normalizeTerm lowercases and trims a headword. It deliberately does not do
// morphological reduction — the caller passes the dictionary base form.
func normalizeTerm(s string) string {
	return strings.ToLower(strings.TrimSpace(s))
}

// Record adds a word to the notebook, or bumps its lookup counter when it is
// already there. Once a context/provenance is stored it is never overwritten:
// a good example sentence is more useful than the most recent one.
//
// Note that promotion happens on the SECOND lookup (see NoteSeen), so the
// context stored here is the occurrence that triggered promotion — the earlier
// one was only counted, never persisted.
func Record(term, surface, bookID, chapterID string, offset int, context string) (*Entry, error) {
	term = normalizeTerm(term)
	if term == "" {
		return nil, errors.New("vocab: empty term")
	}
	if offset < 0 {
		offset = 0
	}
	now := nowIso()
	d, err := db.Open()
	if err != nil {
		return nil, err
	}
	if _, err := d.Exec(`
		INSERT INTO vocab (id, term, surface, book_id, chapter_id, start_offset, context, status, lookups, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
		ON CONFLICT(term) DO UPDATE SET
		  lookups    = vocab.lookups + 1,
		  updated_at = excluded.updated_at,
		  surface    = CASE WHEN vocab.surface = ''   THEN excluded.surface    ELSE vocab.surface    END,
		  context    = CASE WHEN vocab.context = ''   THEN excluded.context    ELSE vocab.context    END,
		  book_id    = CASE WHEN vocab.book_id = ''   THEN excluded.book_id    ELSE vocab.book_id    END,
		  chapter_id = CASE WHEN vocab.chapter_id = '' THEN excluded.chapter_id ELSE vocab.chapter_id END,
		  start_offset = CASE WHEN vocab.context = '' THEN excluded.start_offset ELSE vocab.start_offset END`,
		uid(), term, surface, bookID, chapterID, offset, context, StatusNew, now, now); err != nil {
		return nil, err
	}
	return Get(term)
}

// Get returns the entry for a term, or nil when it is not in the notebook.
func Get(term string) (*Entry, error) {
	term = normalizeTerm(term)
	if term == "" {
		return nil, nil
	}
	d, err := db.Open()
	if err != nil {
		return nil, err
	}
	return scan(d.QueryRow(`SELECT `+columns+` FROM vocab WHERE term = ?`, term))
}

// List returns notebook entries, newest first.
func List(o ListOpts) ([]Entry, error) {
	d, err := db.Open()
	if err != nil {
		return nil, err
	}
	q := `SELECT ` + columns + ` FROM vocab`
	var where []string
	var args []any
	if o.Status != "" {
		where = append(where, `status = ?`)
		args = append(args, o.Status)
	}
	if kw := strings.TrimSpace(o.Keyword); kw != "" {
		where = append(where, `(term LIKE ? OR context LIKE ?)`)
		like := "%" + kw + "%"
		args = append(args, like, like)
	}
	if len(where) > 0 {
		q += ` WHERE ` + strings.Join(where, ` AND `)
	}
	q += ` ORDER BY updated_at DESC`
	if o.Limit > 0 {
		q += ` LIMIT ?`
		args = append(args, o.Limit)
	}

	rows, err := d.Query(q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Entry{}
	for rows.Next() {
		e, err := scan(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *e)
	}
	return out, rows.Err()
}

// UpdateStatus moves an entry between new / learning / known / ignored.
func UpdateStatus(id, status string) error {
	if !validStatus[status] {
		return errors.New("vocab: invalid status " + status)
	}
	d, err := db.Open()
	if err != nil {
		return err
	}
	res, err := d.Exec(`UPDATE vocab SET status = ?, updated_at = ? WHERE id = ?`, status, nowIso(), id)
	if err != nil {
		return err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if n == 0 {
		return sql.ErrNoRows
	}
	return nil
}

// Delete removes an entry from the notebook.
func Delete(id string) error {
	d, err := db.Open()
	if err != nil {
		return err
	}
	_, err = d.Exec(`DELETE FROM vocab WHERE id = ?`, id)
	return err
}

/* ----------------------------- lookup signals ----------------------------- */

// NoteSeen counts one lookup of a term and returns the running total. This is
// the signal that decides whether a word is worth keeping: words looked up
// once are usually curiosities, words looked up twice are genuinely unknown.
// It never touches the notebook itself.
func NoteSeen(term string) (int, error) {
	term = normalizeTerm(term)
	if term == "" {
		return 0, errors.New("vocab: empty term")
	}
	d, err := db.Open()
	if err != nil {
		return 0, err
	}
	now := nowIso()
	if _, err := d.Exec(`
		INSERT INTO vocab_seen (term, lookups, first_at, last_at)
		VALUES (?, 1, ?, ?)
		ON CONFLICT(term) DO UPDATE SET
		  lookups = vocab_seen.lookups + 1,
		  last_at = excluded.last_at`, term, now, now); err != nil {
		return 0, err
	}
	return SeenCount(term)
}

// SeenCount returns how many times a term has been looked up (0 if never).
func SeenCount(term string) (int, error) {
	term = normalizeTerm(term)
	if term == "" {
		return 0, nil
	}
	d, err := db.Open()
	if err != nil {
		return 0, err
	}
	var n int
	err = d.QueryRow(`SELECT lookups FROM vocab_seen WHERE term = ?`, term).Scan(&n)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return 0, nil
		}
		return 0, err
	}
	return n, nil
}

// DropSeen forgets the lookup counter for a term — used once the word has
// entered the notebook (the counter has served its purpose) or when the user
// marks it as known.
func DropSeen(term string) error {
	term = normalizeTerm(term)
	if term == "" {
		return nil
	}
	d, err := db.Open()
	if err != nil {
		return err
	}
	_, err = d.Exec(`DELETE FROM vocab_seen WHERE term = ?`, term)
	return err
}

func uid() string {
	b := make([]byte, 12)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func nowIso() string {
	return time.Now().UTC().Format(time.RFC3339Nano)
}
