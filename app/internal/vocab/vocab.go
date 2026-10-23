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
	// Reviews counts the times the word was put in front of the reader during
	// a review pass; LastReviewedAt is empty until the first one. Without these
	// two, `learning` would be a label with no memory behind it.
	Reviews        int    `json:"reviews"`
	LastReviewedAt string `json:"lastReviewedAt"`
	CreatedAt      string `json:"createdAt"`
	UpdatedAt      string `json:"updatedAt"`
}

// ListOpts filters List. Zero values mean "no filter".
type ListOpts struct {
	Status  string
	Keyword string
	Limit   int
}

const columns = `id, term, surface, book_id, chapter_id, start_offset, context, status,
                 lookups, reviews, last_reviewed_at, created_at, updated_at`

func scan(row interface{ Scan(...any) error }) (*Entry, error) {
	e := &Entry{}
	err := row.Scan(&e.ID, &e.Term, &e.Surface, &e.BookID, &e.ChapterID,
		&e.Offset, &e.Context, &e.Status, &e.Lookups, &e.Reviews, &e.LastReviewedAt,
		&e.CreatedAt, &e.UpdatedAt)
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

// ListItem is a notebook entry enriched with the titles of where the word was
// met, so the notebook page can show "why do I have this word" without a second
// lookup per row. BookTitle is empty when that book has since been deleted: the
// word is the user's asset and stays, but the trail back to the text may not.
type ListItem struct {
	Entry
	BookTitle    string `json:"bookTitle"`
	ChapterTitle string `json:"chapterTitle"`
}

// listSelect is shared by every "give me rows with their provenance" query.
// The LEFT JOIN carries the deleted filter instead of a WHERE clause — a WHERE
// would drop the word along with the book it came from.
const listSelect = `SELECT v.id, v.term, v.surface, v.book_id, v.chapter_id, v.start_offset,
	             v.context, v.status, v.lookups, v.reviews, v.last_reviewed_at,
	             v.created_at, v.updated_at,
	             COALESCE(b.title, ''), COALESCE(c.title, '')
	      FROM vocab v
	      LEFT JOIN books b ON b.id = v.book_id AND b.deleted_at IS NULL
	      LEFT JOIN chapters c ON c.id = v.chapter_id`

func queryList(where []string, args []any, order string, limit int) ([]ListItem, error) {
	d, err := db.Open()
	if err != nil {
		return nil, err
	}
	q := listSelect
	if len(where) > 0 {
		q += ` WHERE ` + strings.Join(where, ` AND `)
	}
	q += ` ORDER BY ` + order
	if limit > 0 {
		q += ` LIMIT ?`
		args = append(args, limit)
	}
	rows, err := d.Query(q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ListItem{}
	for rows.Next() {
		var it ListItem
		if err := rows.Scan(&it.ID, &it.Term, &it.Surface, &it.BookID, &it.ChapterID,
			&it.Offset, &it.Context, &it.Status, &it.Lookups, &it.Reviews, &it.LastReviewedAt,
			&it.CreatedAt, &it.UpdatedAt, &it.BookTitle, &it.ChapterTitle); err != nil {
			return nil, err
		}
		out = append(out, it)
	}
	return out, rows.Err()
}

// List returns notebook entries, newest first.
func List(o ListOpts) ([]ListItem, error) {
	var where []string
	var args []any
	if o.Status != "" {
		where = append(where, `v.status = ?`)
		args = append(args, o.Status)
	}
	if kw := strings.TrimSpace(o.Keyword); kw != "" {
		where = append(where, `(v.term LIKE ? OR v.context LIKE ?)`)
		like := "%" + kw + "%"
		args = append(args, like, like)
	}
	return queryList(where, args, `v.updated_at DESC`, o.Limit)
}

// Queue is the next review session: everything not yet mastered, words nobody
// has asked about yet first, then the ones seen longest ago. `limit` keeps a
// session finite — a pass that can never be finished is one the reader stops
// starting.
func Queue(limit int) ([]ListItem, error) {
	return queryList(
		[]string{`v.status IN (?, ?)`},
		[]any{StatusNew, StatusLearning},
		// Empty last_reviewed_at sorts first: never reviewed beats overdue.
		`(v.last_reviewed_at = '') DESC, v.last_reviewed_at ASC, v.updated_at ASC`,
		limit,
	)
}

// Stats counts notebook entries by status, for the header of the notebook page.
type Stats struct {
	Total    int `json:"total"`
	New      int `json:"new"`
	Learning int `json:"learning"`
	Known    int `json:"known"`
	Ignored  int `json:"ignored"`
}

// CountByStatus aggregates the notebook in a single pass.
func CountByStatus() (*Stats, error) {
	d, err := db.Open()
	if err != nil {
		return nil, err
	}
	rows, err := d.Query(`SELECT status, COUNT(*) FROM vocab GROUP BY status`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	st := &Stats{}
	for rows.Next() {
		var status string
		var n int
		if err := rows.Scan(&status, &n); err != nil {
			return nil, err
		}
		st.Total += n
		switch status {
		case StatusNew:
			st.New = n
		case StatusLearning:
			st.Learning = n
		case StatusKnown:
			st.Known = n
		case StatusIgnored:
			st.Ignored = n
		}
	}
	return st, rows.Err()
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

// Grade records one review outcome. A hit masters the word; a miss puts it in
// `learning`, which is the only thing that does — a word the reader has not
// been asked about yet is still `new`. Every grade is counted, so the notebook
// can show "reviewed 3 times, last on ..." instead of pretending.
func Grade(id string, known bool) (*Entry, error) {
	status := StatusLearning
	if known {
		status = StatusKnown
	}
	now := nowIso()
	d, err := db.Open()
	if err != nil {
		return nil, err
	}
	res, err := d.Exec(`
		UPDATE vocab
		   SET status = ?, reviews = reviews + 1, last_reviewed_at = ?, updated_at = ?
		 WHERE id = ?`, status, now, now, id)
	if err != nil {
		return nil, err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return nil, err
	}
	if n == 0 {
		return nil, sql.ErrNoRows
	}
	return GetByID(id)
}

// GetByID returns the entry with this id, or nil when it does not exist.
func GetByID(id string) (*Entry, error) {
	d, err := db.Open()
	if err != nil {
		return nil, err
	}
	return scan(d.QueryRow(`SELECT `+columns+` FROM vocab WHERE id = ?`, id))
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
