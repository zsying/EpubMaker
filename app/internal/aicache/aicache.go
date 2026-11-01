// Package aicache stores AI answers in the library database, keyed by
// capability + input hash.
//
// The same question is asked by the same reader over and over — a word
// looked up in three chapters, a sentence re-parsed after a mis-tap — and
// every ask costs a network round-trip and, with BYOK, the user's money. The
// cache exists to pay once.
//
// The empty response is a tombstone: the provider answered, and the answer
// was "nothing to say". Storing it stops the same dead question from being
// asked again. Failures (network down, timeout, non-2xx) never reach this
// package — the app layer only calls Put for a completed exchange, so a
// flaky provider stays retryable.
package aicache

import (
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"strings"
	"time"

	"epubmaker-desktop/internal/db"
)

// Entry is one cached answer. Key is composed by Key(); Kind is stored
// alongside so a cached row can be traced back to the capability that wrote
// it. Response is the capability's own JSON payload — this package treats it
// as an opaque string.
type Entry struct {
	Key       string `json:"key"`
	Kind      string `json:"kind"`
	Response  string `json:"response"`
	CreatedAt string `json:"createdAt"`
}

// Key composes the cache key for one capability + input pair. The input is
// hashed, not stored: keys stay a fixed, indexable size and the cache never
// keeps the raw prompt text (which for the chapter summary would be the
// whole chapter).
func Key(kind, input string) string {
	sum := sha256.Sum256([]byte(input))
	return kind + ":" + hex.EncodeToString(sum[:])
}

// Get returns the cached entry for key, or nil when there is none. A stored
// tombstone is returned as an entry with an empty Response — that is a hit,
// not a miss.
func Get(key string) (*Entry, error) {
	key = strings.TrimSpace(key)
	if key == "" {
		return nil, nil
	}
	d, err := db.Open()
	if err != nil {
		return nil, err
	}
	var e Entry
	err = d.QueryRow(`SELECT key, kind, response, created_at
	                  FROM ai_cache WHERE key = ?`, key).
		Scan(&e.Key, &e.Kind, &e.Response, &e.CreatedAt)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	return &e, nil
}

// Put stores (or replaces) an answer. Replacing is deliberate, same as in
// dictcache: a provider that answers better on a second try, or a user who
// switched model, should see the new answer without a manual cache clear.
func Put(e Entry) error {
	key := strings.TrimSpace(e.Key)
	if key == "" {
		return nil
	}
	d, err := db.Open()
	if err != nil {
		return err
	}
	if e.CreatedAt == "" {
		e.CreatedAt = time.Now().UTC().Format("2006-01-02T15:04:05Z")
	}
	_, err = d.Exec(`INSERT INTO ai_cache (key, kind, response, created_at)
		VALUES (?, ?, ?, ?)
		ON CONFLICT(key) DO UPDATE SET
			kind = excluded.kind, response = excluded.response,
			created_at = excluded.created_at`,
		key, e.Kind, e.Response, e.CreatedAt)
	return err
}
