// Package dictcache stores the glosses that had to be fetched online.
//
// It sits in the library database rather than in dict.db for two reasons: a
// dictionary import replaces dict.db wholesale, and the Android build ships a
// trimmed dictionary that answers far less than the desktop one. A word the
// reader paid a network round-trip for should not have to be paid for twice.
package dictcache

import (
	"database/sql"
	"errors"
	"strings"
	"time"

	"epubmaker-desktop/internal/db"
)

// Entry is one cached gloss. Term is the look-up key (already normalized by the
// caller); Word keeps the casing the source used.
type Entry struct {
	Term        string `json:"term"`
	Word        string `json:"word"`
	Phonetic    string `json:"phonetic"`
	Translation string `json:"translation"`
	Definition  string `json:"definition"`
	Source      string `json:"source"`
	FetchedAt   string `json:"fetchedAt"`
}

// Get returns the cached gloss for term, or nil when there is none.
func Get(term string) (*Entry, error) {
	d, err := db.Open()
	if err != nil {
		return nil, err
	}
	var e Entry
	err = d.QueryRow(`SELECT term, word, phonetic, translation, definition, source, fetched_at
	                  FROM dict_online WHERE term = ?`, strings.TrimSpace(term)).
		Scan(&e.Term, &e.Word, &e.Phonetic, &e.Translation, &e.Definition, &e.Source, &e.FetchedAt)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	return &e, nil
}

// Put stores (or replaces) a gloss. Replacing is deliberate: a source that
// answered with nothing useful last time is free to answer better now.
func Put(e Entry) error {
	term := strings.TrimSpace(e.Term)
	if term == "" {
		return nil
	}
	d, err := db.Open()
	if err != nil {
		return err
	}
	if e.FetchedAt == "" {
		e.FetchedAt = time.Now().UTC().Format("2006-01-02T15:04:05Z")
	}
	_, err = d.Exec(`INSERT INTO dict_online
		(term, word, phonetic, translation, definition, source, fetched_at)
		VALUES (?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(term) DO UPDATE SET
			word = excluded.word, phonetic = excluded.phonetic,
			translation = excluded.translation, definition = excluded.definition,
			source = excluded.source, fetched_at = excluded.fetched_at`,
		term, e.Word, e.Phonetic, e.Translation, e.Definition, e.Source, e.FetchedAt)
	return err
}
