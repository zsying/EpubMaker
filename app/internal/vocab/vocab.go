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
	"math"
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

	// Spaced-repetition state (SM-2 in days).
	//
	// IntervalDays is how long the current gap is; 0 means "never scheduled",
	// which for a brand-new word means "due now". Ease is the SM-2 easiness
	// factor: it starts at 2.5, grows 0.1 per successful review and drops 0.32
	// per miss, so a word that keeps being forgotten comes back faster and
	// faster instead of marching on a fixed calendar.
	IntervalDays float64 `json:"intervalDays"`
	Ease         float64 `json:"ease"`
	// DueAt is RFC3339 UTC ("2026-11-02T09:00:00Z"); empty means due now.
	DueAt string `json:"dueAt"`
	// Streak counts consecutive successful reviews, Lapses the total misses.
	// Streak decides the SM-2 step (1 day, 6 days, then interval × ease).
	Streak int `json:"streak"`
	Lapses int `json:"lapses"`

	CreatedAt string `json:"createdAt"`
	UpdatedAt string `json:"updatedAt"`
}

// ListOpts filters List. Zero values mean "no filter".
type ListOpts struct {
	Status  string
	Keyword string
	Limit   int
}

const columns = `id, term, surface, book_id, chapter_id, start_offset, context, status,
                 lookups, reviews, last_reviewed_at,
                 interval_days, ease, due_at, streak, lapses,
                 created_at, updated_at`

func scan(row interface{ Scan(...any) error }) (*Entry, error) {
	e := &Entry{}
	err := row.Scan(&e.ID, &e.Term, &e.Surface, &e.BookID, &e.ChapterID,
		&e.Offset, &e.Context, &e.Status, &e.Lookups, &e.Reviews, &e.LastReviewedAt,
		&e.IntervalDays, &e.Ease, &e.DueAt, &e.Streak, &e.Lapses,
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
	             v.interval_days, v.ease, v.due_at, v.streak, v.lapses,
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
			&it.IntervalDays, &it.Ease, &it.DueAt, &it.Streak, &it.Lapses,
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

// Queue is the next review session: every word that has come due. Nothing is
// included merely because it is unmastered — a word scheduled for next week is
// not a word you should be asked about today.
//
// Words that were never scheduled (due_at empty, i.e. every word at import)
// come first: they are the ones the reader has never managed to answer. After
// that the most overdue comes first. `limit` keeps a pass finite — a session
// that can never be finished is one the reader stops starting.
func Queue(limit int) ([]ListItem, error) {
	return queryList(
		[]string{`v.status <> ?`, `(v.due_at = '' OR v.due_at <= ?)`},
		[]any{StatusIgnored, dueIso(time.Now())},
		`(v.due_at = '') DESC, v.due_at ASC, v.updated_at ASC`,
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
	// Due is what the review button should offer: words whose schedule has come
	// up, not simply every word not yet mastered.
	Due int `json:"due"`
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
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := d.QueryRow(
		`SELECT COUNT(*) FROM vocab WHERE status <> ? AND (due_at = '' OR due_at <= ?)`,
		StatusIgnored, dueIso(time.Now()),
	).Scan(&st.Due); err != nil {
		return nil, err
	}
	return st, nil
}

// UpdateStatus moves an entry between new / learning / known / ignored.
//
// Marking a word known by hand is a claim, not a review: it does not touch the
// review counters, but it does put the word on the schedule three weeks out
// rather than hiding it, because a claim is exactly what the schedule is there
// to check later. `ignored` is the real exit from the queue — those words never
// come back.
func UpdateStatus(id, status string) error {
	if !validStatus[status] {
		return errors.New("vocab: invalid status " + status)
	}
	now := nowIso()
	d, err := db.Open()
	if err != nil {
		return err
	}
	var res sql.Result
	if status == StatusKnown {
		res, err = d.Exec(`
			UPDATE vocab
			   SET status = ?, updated_at = ?,
			       interval_days = MAX(interval_days, ?),
			       due_at = CASE WHEN due_at = '' OR due_at < ? THEN ? ELSE due_at END
			 WHERE id = ?`,
			status, now, manualKnownDays, dueIso(time.Now().Add(manualKnownDays*day)),
			dueIso(time.Now().Add(manualKnownDays*day)), id)
	} else {
		res, err = d.Exec(`UPDATE vocab SET status = ?, updated_at = ? WHERE id = ?`, status, now, id)
	}
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

/* --------------------------- spaced repetition ---------------------------- */

// The scheduler is SM-2 (Wozniak, 1987), reduced to the two grades the card
// actually offers. Keeping the real formula matters because the alternative —
// "ask everything that is not mastered, forever" — is not spaced repetition at
// all, it is the same list every day in a different order.
const (
	startEase = 2.5
	minEase   = 1.3
	maxEase   = 2.8

	// A miss sends the word to a short relearning step instead of a full day:
	// the point is to meet it again in the same sitting, while the miss is
	// fresh, not tomorrow.
	relearnStep = 10 * time.Minute

	// A word counts as mastered on evidence, not on a click: once its interval
	// reaches three weeks — 1 → 6 → 16 → 45 days, four clean passes.
	masterIntervalDays = 21

	// A hand-marked "已掌握" schedules the next check this far out.
	manualKnownDays = 21
)

const day = 24 * time.Hour

// dueIso formats a schedule time so that string comparison in SQL is also
// chronological order: fixed width, UTC, second precision. (RFC3339Nano is not
// orderable as text — "…:00.5Z" sorts before "…:00Z".)
func dueIso(t time.Time) string {
	return t.UTC().Format("2006-01-02T15:04:05Z")
}

// Grade records one review outcome and schedules the next one. A hit walks the
// SM-2 ladder (1 day, 6 days, then interval × ease) and nudges ease up; a miss
// drops back to the ten-minute step and pulls ease down, so a word that keeps
// being forgotten keeps coming back sooner.
//
// Every grade is counted, so the notebook can show "reviewed 3 times, last on
// ..." instead of pretending.
func Grade(id string, known bool) (*Entry, error) {
	cur, err := GetByID(id)
	if err != nil {
		return nil, err
	}
	if cur == nil {
		return nil, sql.ErrNoRows
	}

	now := time.Now().UTC()
	ease := cur.Ease
	if ease <= 0 {
		ease = startEase
	}

	status := StatusLearning
	streak := cur.Streak
	lapses := cur.Lapses
	var interval float64

	if known {
		switch {
		case cur.IntervalDays <= 0:
			// Never scheduled: first clean pass is worth a day.
			interval = 1
		case cur.IntervalDays < 1:
			// Back from a relearning step: earn the day before stretching out.
			interval = 1
		case cur.IntervalDays < 6:
			interval = 6
		default:
			interval = math.Round(cur.IntervalDays * ease)
			if interval < 1 {
				interval = 1
			}
		}
		ease = math.Min(maxEase, ease+0.1)
		streak++
		if interval >= masterIntervalDays {
			status = StatusKnown
		}
	} else {
		interval = relearnStep.Hours() / 24
		ease = math.Max(minEase, ease-0.32)
		streak = 0
		lapses++
	}

	due := now.Add(time.Duration(interval * float64(day)))
	d, err := db.Open()
	if err != nil {
		return nil, err
	}
	res, err := d.Exec(`
		UPDATE vocab
		   SET status = ?, reviews = reviews + 1, last_reviewed_at = ?, updated_at = ?,
		       interval_days = ?, ease = ?, due_at = ?, streak = ?, lapses = ?
		 WHERE id = ?`,
		status, nowIso(), nowIso(), interval, ease, dueIso(due), streak, lapses, id)
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
