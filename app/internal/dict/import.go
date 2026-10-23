package dict

import (
	"bufio"
	"database/sql"
	"encoding/csv"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// importSchema is the on-disk shape of a dictionary database. `key` is the
// lowercased headword used for matching; `word` keeps the original casing for
// display (acronyms, proper nouns).
const importSchema = `
CREATE TABLE entries (
  key         TEXT PRIMARY KEY,
  word        TEXT NOT NULL,
  phonetic    TEXT NOT NULL DEFAULT '',
  definition  TEXT NOT NULL DEFAULT '',
  translation TEXT NOT NULL DEFAULT '',
  pos         TEXT NOT NULL DEFAULT '',
  collins     INTEGER NOT NULL DEFAULT 0,
  oxford      INTEGER NOT NULL DEFAULT 0,
  tag         TEXT NOT NULL DEFAULT '',
  bnc         INTEGER NOT NULL DEFAULT 0,
  frq         INTEGER NOT NULL DEFAULT 0,
  exchange    TEXT NOT NULL DEFAULT '',
  audio       TEXT NOT NULL DEFAULT ''
);
CREATE TABLE lemmas (
  form TEXT PRIMARY KEY,
  base TEXT NOT NULL
);
`

// keyOf is the matching form of a headword: trimmed, whitespace collapsed,
// lowercased. It deliberately does NOT strip possessives or punctuation —
// those normalizations belong to query input, not to dictionary keys.
func keyOf(s string) string {
	return strings.ToLower(spaceRun.ReplaceAllString(strings.TrimSpace(s), " "))
}

// ImportCSV builds a dictionary database from an ECDICT-format CSV at dbPath.
// An existing database is replaced atomically (via a .tmp file + rename), so a
// failed import never leaves a half-written dictionary behind.
//
// The caller must close any open Dict on dbPath before importing. progress may
// be nil and is called periodically with total = -1 (unknown until EOF).
func ImportCSV(csvPath, dbPath string, progress func(done, total int)) error {
	if _, err := os.Stat(csvPath); err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(dbPath), 0o755); err != nil {
		return err
	}

	tmp := dbPath + ".tmp"
	for _, suffix := range []string{"", "-wal", "-shm"} {
		_ = os.Remove(tmp + suffix)
	}
	if err := importInto(csvPath, tmp, progress); err != nil {
		for _, suffix := range []string{"", "-wal", "-shm"} {
			_ = os.Remove(tmp + suffix)
		}
		return err
	}

	// Drop the previous dictionary (single-file deletes only; the sandbox
	// rejects bulk removal).
	for _, suffix := range []string{"-wal", "-shm", ""} {
		_ = os.Remove(dbPath + suffix)
	}
	return os.Rename(tmp, dbPath)
}

func importInto(csvPath, dbPath string, progress func(done, total int)) error {
	f, err := os.Open(csvPath)
	if err != nil {
		return err
	}
	defer f.Close()

	r := csv.NewReader(bufio.NewReaderSize(f, 1<<20))
	r.FieldsPerRecord = -1 // tolerate ragged rows in third-party exports
	r.LazyQuotes = true

	header, err := r.Read()
	if err != nil {
		return fmt.Errorf("read csv header: %w", err)
	}
	col := make(map[string]int, len(header))
	for i, h := range header {
		h = strings.ToLower(strings.TrimSpace(strings.TrimPrefix(h, "\ufeff")))
		col[h] = i
	}
	if _, ok := col["word"]; !ok {
		return fmt.Errorf("csv has no 'word' column (not an ECDICT export?)")
	}

	sdb, err := sql.Open("sqlite", dbPath)
	if err != nil {
		return err
	}
	defer sdb.Close()
	sdb.SetMaxOpenConns(1)
	for _, pragma := range []string{"PRAGMA journal_mode=OFF", "PRAGMA synchronous=OFF"} {
		if _, err := sdb.Exec(pragma); err != nil {
			return err
		}
	}
	if _, err := sdb.Exec(importSchema); err != nil {
		return err
	}

	tx, err := sdb.Begin()
	if err != nil {
		return err
	}
	insEntry, err := tx.Prepare(`INSERT OR REPLACE INTO entries
		(key, word, phonetic, definition, translation, pos, collins, oxford, tag, bnc, frq, exchange, audio)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
	if err != nil {
		_ = tx.Rollback()
		return err
	}
	defer insEntry.Close()
	insLemma, err := tx.Prepare(`INSERT OR IGNORE INTO lemmas (form, base) VALUES (?, ?)`)
	if err != nil {
		_ = tx.Rollback()
		return err
	}
	defer insLemma.Close()

	n := 0
	for {
		rec, err := r.Read()
		if err == io.EOF {
			break
		}
		if err != nil {
			_ = tx.Rollback()
			return fmt.Errorf("read csv row %d: %w", n+2, err)
		}
		get := func(name string) string {
			i, ok := col[name]
			if !ok || i >= len(rec) {
				return ""
			}
			return strings.TrimSpace(rec[i])
		}
		atoi := func(name string) int {
			v, _ := strconv.Atoi(get(name))
			return v
		}

		word := get("word")
		if word == "" {
			continue
		}
		exchange := get("exchange")
		if _, err := insEntry.Exec(
			keyOf(word), word, get("phonetic"), unescape(get("definition")), unescape(get("translation")),
			get("pos"), atoi("collins"), atoi("oxford"), get("tag"),
			atoi("bnc"), atoi("frq"), exchange, get("audio"),
		); err != nil {
			_ = tx.Rollback()
			return err
		}
		for _, p := range lemmaPairs(word, exchange) {
			if _, err := insLemma.Exec(keyOf(p[0]), keyOf(p[1])); err != nil {
				_ = tx.Rollback()
				return err
			}
		}

		n++
		if progress != nil && n%5000 == 0 {
			progress(n, -1)
		}
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	if progress != nil {
		progress(n, n)
	}
	return nil
}

// unescape converts the literal "\n" sequences ECDICT uses to pack multi-line
// definition/translation cells into real newlines.
func unescape(s string) string {
	if !strings.Contains(s, `\n`) {
		return s
	}
	return strings.ReplaceAll(s, `\n`, "\n")
}

// lemmaPairs derives (inflected form -> base) pairs from an ECDICT `exchange`
// payload such as "d:perceived/p:perceived/3:perceives/i:perceiving" or
// "0:perceive" (this word's own lemma). Self-mappings are dropped.
func lemmaPairs(word, exchange string) [][2]string {
	if exchange == "" {
		return nil
	}
	var out [][2]string
	for _, part := range strings.Split(exchange, "/") {
		code, form, ok := strings.Cut(strings.TrimSpace(part), ":")
		if !ok {
			continue
		}
		form = strings.TrimSpace(form)
		if form == "" {
			continue
		}
		switch code {
		case "0": // this headword is an inflected form of `form`
			if p := pair(form, word); p != nil {
				out = append(out, *p)
			}
		case "p", "d", "i", "3", "r", "t", "s": // `form` inflects this headword
			if p := pair(word, form); p != nil {
				out = append(out, *p)
			}
		}
	}
	return out
}

func pair(base, form string) *[2]string {
	if form == "" || base == "" || keyOf(form) == keyOf(base) {
		return nil
	}
	return &[2]string{form, base}
}
