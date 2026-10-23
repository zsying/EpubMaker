// Package dict is a local ECDICT-backed dictionary: it resolves a word picked
// out of a chapter to a headword (with morphological fallback) and returns the
// phonetic / Chinese translation / frequency metadata.
//
// The dictionary lives in its own SQLite file (default ~/.epubmaker/dict/
// dict.db) so it can be rebuilt or removed without touching the library db.
// Data source: ECDICT (word/phonetic/definition/translation/pos/collins/
// oxford/tag/bnc/frq/exchange/audio columns).
package dict

import (
	"database/sql"
	"errors"
	"os"
	"regexp"
	"strings"

	_ "modernc.org/sqlite"
)

// ErrNotInstalled is returned by Open when no dictionary file exists yet. The
// caller is expected to surface "import a dictionary first" instead of an I/O
// error.
var ErrNotInstalled = errors.New("dictionary not installed")

// Entry is one dictionary record.
type Entry struct {
	Word        string `json:"word"`
	Phonetic    string `json:"phonetic"`
	Definition  string `json:"definition"`
	Translation string `json:"translation"`
	Pos         string `json:"pos"`
	Collins     int    `json:"collins"`
	Oxford      int    `json:"oxford"`
	Tag         string `json:"tag"`
	BNC         int    `json:"bnc"`
	FRQ         int    `json:"frq"`
	Exchange    string `json:"exchange"`
	Audio       string `json:"audio"`
}

// Result is a lookup outcome. Query echoes the normalized input so the UI can
// show "you looked up climbed -> climb".
//
// Base carries the headword's own lemma when the matched entry is an inflected
// form. ECDICT ships every inflection as its own row, and those rows often
// define nothing but "past tense of climb" — so the reader needs both: the form
// it actually met, and the word it came from. (Some inflections are genuine
// words in their own right, e.g. "running" the noun, so Base is additive and
// never replaces Entry.)
type Result struct {
	Query      string `json:"query"`
	Matched    string `json:"matched"`
	Lemmatized bool   `json:"lemmatized"`
	Found      bool   `json:"found"`
	Entry      *Entry `json:"entry,omitempty"`
	Base       *Entry `json:"base,omitempty"`
}

// Dict is a read-only handle on a dictionary database.
type Dict struct {
	db *sql.DB
	// count is cached after the first successful Count call; the reader hits
	// Lookup far more often than Count, so this is just convenience.
	count int
}

/* ----------------------------- normalization ----------------------------- */

var (
	edgeJunk = regexp.MustCompile(`^[^A-Za-z]+|[^A-Za-z]+$`)
	spaceRun = regexp.MustCompile(`\s+`)
)

// Normalize turns a raw text selection into a lookup key: quotes are unified
// and trimmed, surrounding punctuation is dropped, whitespace collapses, the
// string is lowercased, and a trailing possessive is removed.
func Normalize(s string) string {
	s = strings.NewReplacer(
		"\u2018", "'", "\u2019", "'",
		"\u201c", "\"", "\u201d", "\"",
		"\u00a0", " ",
	).Replace(s)
	s = strings.TrimSpace(s)
	s = edgeJunk.ReplaceAllString(s, "")
	s = spaceRun.ReplaceAllString(s, " ")
	s = strings.ToLower(s)
	s = strings.TrimSuffix(s, "'s")
	s = strings.TrimSuffix(s, "'")
	return strings.TrimSpace(s)
}

/* ----------------------------- open / close ----------------------------- */

// Open opens an existing dictionary. Returns ErrNotInstalled when the file is
// missing.
func Open(dbPath string) (*Dict, error) {
	if _, err := os.Stat(dbPath); err != nil {
		if os.IsNotExist(err) {
			return nil, ErrNotInstalled
		}
		return nil, err
	}
	d, err := sql.Open("sqlite", dbPath)
	if err != nil {
		return nil, err
	}
	d.SetMaxOpenConns(1)
	if _, err := d.Exec("PRAGMA query_only=ON; PRAGMA busy_timeout=3000;"); err != nil {
		_ = d.Close()
		return nil, err
	}
	return &Dict{db: d}, nil
}

// Close releases the underlying connection.
func (d *Dict) Close() error {
	if d == nil || d.db == nil {
		return nil
	}
	return d.db.Close()
}

// Count returns the number of headwords.
func (d *Dict) Count() (int, error) {
	if d.count > 0 {
		return d.count, nil
	}
	var n int
	if err := d.db.QueryRow(`SELECT COUNT(1) FROM entries`).Scan(&n); err != nil {
		return 0, err
	}
	d.count = n
	return n, nil
}

/* ----------------------------- lookup ----------------------------- */

const entryColumns = `word, phonetic, definition, translation, pos, collins, oxford, tag, bnc, frq, exchange, audio`

func scanEntry(row *sql.Row) (*Entry, error) {
	e := &Entry{}
	err := row.Scan(&e.Word, &e.Phonetic, &e.Definition, &e.Translation, &e.Pos,
		&e.Collins, &e.Oxford, &e.Tag, &e.BNC, &e.FRQ, &e.Exchange, &e.Audio)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	return e, nil
}

func (d *Dict) exact(word string) (*Entry, error) {
	return scanEntry(d.db.QueryRow(`SELECT `+entryColumns+` FROM entries WHERE key = ?`, word))
}

func (d *Dict) lemmaOf(form string) (string, error) {
	var base string
	err := d.db.QueryRow(`SELECT base FROM lemmas WHERE form = ?`, form).Scan(&base)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return "", nil
		}
		return "", err
	}
	return base, nil
}

// Lookup resolves a raw selection and, when the matched entry is an inflected
// form, attaches the base-form entry it points at.
func (d *Dict) Lookup(raw string) (*Result, error) {
	res, err := d.lookup(raw)
	if err != nil || res == nil || !res.Found || res.Entry == nil {
		return res, err
	}
	if base := lemmaTarget(res.Entry.Exchange); base != "" && base != keyOf(res.Entry.Word) {
		e, err := d.exact(base)
		if err != nil {
			return nil, err
		}
		if e != nil && keyOf(e.Word) != keyOf(res.Entry.Word) {
			res.Base = e
		}
	}
	return res, nil
}

// lemmaTarget returns the base form an inflected entry declares via "0:climb".
func lemmaTarget(exchange string) string {
	for _, part := range strings.Split(exchange, "/") {
		code, form, ok := strings.Cut(strings.TrimSpace(part), ":")
		if ok && code == "0" {
			return strings.ToLower(strings.TrimSpace(form))
		}
	}
	return ""
}

// lookup is the resolution pipeline behind Lookup.
func (d *Dict) lookup(raw string) (*Result, error) {
	norm := Normalize(raw)
	keys := queryKeys(raw, norm)
	res := &Result{Query: norm}
	if len(keys) == 0 {
		return res, nil
	}

	for _, k := range keys {
		e, err := d.exact(k)
		if err != nil {
			return nil, err
		}
		if e != nil {
			res.Found, res.Matched, res.Entry = true, e.Word, e
			return res, nil
		}
	}
	for _, k := range keys {
		base, err := d.lemmaOf(k)
		if err != nil {
			return nil, err
		}
		if base == "" || base == k {
			continue
		}
		if e, err := d.exact(base); err != nil {
			return nil, err
		} else if e != nil {
			res.Found, res.Matched, res.Lemmatized, res.Entry = true, e.Word, true, e
			return res, nil
		}
	}
	for _, cand := range suffixCandidates(norm) {
		e, err := d.exact(cand)
		if err != nil {
			return nil, err
		}
		if e != nil {
			res.Found, res.Matched, res.Lemmatized, res.Entry = true, e.Word, true, e
			return res, nil
		}
	}
	return res, nil
}

// queryKeys returns the dictionary keys to try, most faithful first.
func queryKeys(raw, norm string) []string {
	out := make([]string, 0, 2)
	add := func(s string) {
		if s == "" {
			return
		}
		for _, existing := range out {
			if existing == s {
				return
			}
		}
		out = append(out, s)
	}
	add(keyOf(raw))
	add(norm)
	return out
}

/* ----------------------------- suffix rules ----------------------------- */

func isVowel(b byte) bool {
	switch b {
	case 'a', 'e', 'i', 'o', 'u':
		return true
	}
	return false
}

// undouble strips one of a trailing doubled consonant ("runn" -> "run").
func undouble(stem string) string {
	if len(stem) < 2 {
		return stem
	}
	last, prev := stem[len(stem)-1], stem[len(stem)-2]
	if last == prev && !isVowel(last) {
		return stem[:len(stem)-1]
	}
	return stem
}

// suffixCandidates returns plausible base forms for an inflected word, most
// specific suffix first. Callers must still verify each candidate exists.
func suffixCandidates(w string) []string {
	out := make([]string, 0, 8)
	seen := map[string]bool{w: true}
	add := func(s string) {
		if s == "" || seen[s] {
			return
		}
		seen[s] = true
		out = append(out, s)
	}

	switch {
	case strings.HasSuffix(w, "ies") && len(w) > 4:
		add(strings.TrimSuffix(w, "ies") + "y")
	case strings.HasSuffix(w, "es") && len(w) > 3:
		stem := strings.TrimSuffix(w, "es")
		add(stem)
		add(stem + "e")
	case strings.HasSuffix(w, "s") && !strings.HasSuffix(w, "ss") && len(w) > 2:
		add(strings.TrimSuffix(w, "s"))
	}

	if strings.HasSuffix(w, "ied") && len(w) > 4 {
		add(strings.TrimSuffix(w, "ied") + "y")
	}
	if strings.HasSuffix(w, "ed") && len(w) > 3 {
		stem := strings.TrimSuffix(w, "ed")
		add(stem)
		add(stem + "e")
		add(undouble(stem))
	}
	if strings.HasSuffix(w, "ing") && len(w) > 4 {
		stem := strings.TrimSuffix(w, "ing")
		add(stem)
		add(stem + "e")
		add(undouble(stem))
	}
	if strings.HasSuffix(w, "est") && len(w) > 4 {
		stem := strings.TrimSuffix(w, "est")
		add(stem)
		add(stem + "e")
		add(undouble(stem))
		add(strings.TrimSuffix(w, "est") + "y")
	}
	if strings.HasSuffix(w, "er") && len(w) > 3 {
		stem := strings.TrimSuffix(w, "er")
		add(stem)
		add(stem + "e")
		add(undouble(stem))
		add(stem + "y")
	}
	if strings.HasSuffix(w, "ly") && len(w) > 3 {
		add(strings.TrimSuffix(w, "ly"))
		add(strings.TrimSuffix(w, "ily") + "y")
	}
	return out
}
