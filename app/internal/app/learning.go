package app

import (
	"errors"
	"strings"
	"sync"

	"epubmaker-desktop/internal/config"
	"epubmaker-desktop/internal/dict"
	"epubmaker-desktop/internal/vocab"
)

// commonWordRank is the cutoff used to decide that a word is already known.
// ECDICT ranks words by frequency in a contemporary corpus (frq, 1 = most
// frequent); anything at or above this rank is treated as basic vocabulary and
// is never auto-added to the notebook. Manual adds are always honoured.
const commonWordRank = 5000

// One dictionary handle is shared by every binding; reopening a 60 MB+ SQLite
// file per keystroke would be absurd.
var (
	dictMu     sync.Mutex
	dictHandle *dict.Dict
)

func openDict() (*dict.Dict, error) {
	dictMu.Lock()
	defer dictMu.Unlock()
	if dictHandle != nil {
		return dictHandle, nil
	}
	d, err := dict.Open(config.Get().Paths.DictDB)
	if err != nil {
		return nil, err
	}
	dictHandle = d
	return d, nil
}

// closeDict releases the handle so the file can be replaced by an import.
func closeDict() {
	dictMu.Lock()
	defer dictMu.Unlock()
	if dictHandle != nil {
		_ = dictHandle.Close()
		dictHandle = nil
	}
}

/* ----------------------------- dictionary ----------------------------- */

// DictStatus describes whether a dictionary is installed.
type DictStatus struct {
	Installed bool   `json:"installed"`
	Path      string `json:"path"`
	Entries   int    `json:"entries"`
}

// DictStatus reports the installed dictionary, if any.
func (b *Backend) DictStatus() (*DictStatus, error) {
	st := &DictStatus{Path: config.Get().Paths.DictDB}
	d, err := openDict()
	if err != nil {
		if errors.Is(err, dict.ErrNotInstalled) {
			return st, nil
		}
		return nil, err
	}
	n, err := d.Count()
	if err != nil {
		return nil, err
	}
	st.Installed = true
	st.Entries = n
	return st, nil
}

// DictImportCSV builds the dictionary from a local ECDICT csv. The path comes
// from the native file dialog, so nothing is uploaded and no HTTP is involved.
//
// This call blocks for the duration of the import (tens of seconds for the
// full 770k-entry file); the UI shows a progress indicator around it.
func (b *Backend) DictImportCSV(csvPath string) (map[string]any, error) {
	if strings.TrimSpace(csvPath) == "" {
		return nil, errors.New("no dictionary file selected")
	}
	closeDict()
	if err := dict.ImportCSV(csvPath, config.Get().Paths.DictDB, nil); err != nil {
		return nil, err
	}
	d, err := openDict()
	if err != nil {
		return nil, err
	}
	n, err := d.Count()
	if err != nil {
		return nil, err
	}
	return map[string]any{"entries": n, "path": config.Get().Paths.DictDB}, nil
}

// DictLookup resolves a word without touching the notebook. Used by the review
// card and by the reader when a term is looked at but not picked up.
func (b *Backend) DictLookup(raw string) (*LookupResult, error) {
	d, err := openDict()
	if err != nil {
		return nil, err
	}
	res, err := d.Lookup(raw)
	if err != nil {
		return nil, err
	}
	return toLookupResult(res), nil
}

// WordDetail is the part of a dictionary entry the popover renders.
type WordDetail struct {
	Word        string `json:"word"`
	Phonetic    string `json:"phonetic"`
	Translation string `json:"translation"`
	Definition  string `json:"definition"`
	Pos         string `json:"pos"`
	Tag         string `json:"tag"`
	Collins     int    `json:"collins"`
	FRQ         int    `json:"frq"`
	BNC         int    `json:"bnc"`
}

func toWordDetail(e *dict.Entry) *WordDetail {
	if e == nil {
		return nil
	}
	return &WordDetail{
		Word: e.Word, Phonetic: e.Phonetic, Translation: e.Translation,
		Definition: e.Definition, Pos: e.Pos, Tag: e.Tag,
		Collins: e.Collins, FRQ: e.FRQ, BNC: e.BNC,
	}
}

// LookupResult is the flattened shape the reader renders. Vocabulary state is
// included so the popover can show "already in your notebook" without a second
// round trip.
//
// Entry is the word as it appeared (ECDICT ships inflected forms as their own
// headwords); Base is the lemma behind it, present only when it differs.
type LookupResult struct {
	Found      bool        `json:"found"`
	Query      string      `json:"query"`
	Matched    string      `json:"matched"`
	Lemmatized bool        `json:"lemmatized"`
	Entry      *WordDetail `json:"entry,omitempty"`
	Base       *WordDetail `json:"base,omitempty"`
	Common     bool        `json:"common"`
	SeenCount  int         `json:"seenCount"`
	Recorded   bool        `json:"recorded"`
	VocabID    string      `json:"vocabId"`
}

func toLookupResult(res *dict.Result) *LookupResult {
	out := &LookupResult{
		Found:      res.Found,
		Query:      res.Query,
		Matched:    res.Matched,
		Lemmatized: res.Lemmatized,
		Entry:      toWordDetail(res.Entry),
		Base:       toWordDetail(res.Base),
	}
	if res.Entry != nil {
		out.Common = isCommonWord(res.Entry)
	}
	return out
}

// isCommonWord reports whether a headword belongs to basic vocabulary. A word
// with no corpus rank at all (0) is rare or technical, so it is NOT common.
func isCommonWord(e *dict.Entry) bool {
	rank := e.FRQ
	if rank <= 0 {
		rank = e.BNC
	}
	return rank > 0 && rank <= commonWordRank
}

// LookupWord is the reader's single entry point: it resolves the selection and
// applies the recording policy.
//
// Policy:
//   - a word already in the notebook is kept and its lookup counter bumped;
//   - basic vocabulary (top 5000 by frequency) is never auto-added, so the
//     notebook does not fill up with "the" and "of";
//   - everything else enters the notebook on the SECOND lookup, because the
//     first lookup is often just curiosity.
func (b *Backend) LookupWord(bookID, chapterID string, offset int, raw, context string) (*LookupResult, error) {
	d, err := openDict()
	if err != nil {
		return nil, err
	}
	res, err := d.Lookup(raw)
	if err != nil {
		return nil, err
	}
	out := toLookupResult(res)
	if !out.Found {
		return out, nil
	}

	term := out.Entry.Word
	surface := strings.TrimSpace(raw)

	if existing, err := vocab.Get(term); err != nil {
		return nil, err
	} else if existing != nil {
		v, err := vocab.Record(term, surface, bookID, chapterID, offset, context)
		if err != nil {
			return nil, err
		}
		out.Recorded, out.VocabID = true, v.ID
		return out, nil
	}

	if out.Common {
		return out, nil
	}

	seen, err := vocab.NoteSeen(term)
	if err != nil {
		return nil, err
	}
	out.SeenCount = seen
	if seen < 2 {
		return out, nil
	}

	v, err := vocab.Record(term, surface, bookID, chapterID, offset, context)
	if err != nil {
		return nil, err
	}
	// The signal counter has done its job.
	_ = vocab.DropSeen(term)
	out.Recorded, out.VocabID = true, v.ID
	return out, nil
}

/* ----------------------------- notebook ----------------------------- */

// VocabAdd puts a word in the notebook unconditionally — this backs the manual
// "add to notebook" action, which must work even for basic vocabulary.
func (b *Backend) VocabAdd(term, surface, bookID, chapterID string, offset int, context string) (*vocab.Entry, error) {
	v, err := vocab.Record(term, surface, bookID, chapterID, offset, context)
	if err != nil {
		return nil, err
	}
	_ = vocab.DropSeen(term)
	return v, nil
}

// ListVocab returns notebook entries, newest first.
func (b *Backend) ListVocab(status, keyword string) ([]vocab.Entry, error) {
	return vocab.List(vocab.ListOpts{Status: status, Keyword: keyword})
}

// SetVocabStatus moves a word between new / learning / known / ignored.
func (b *Backend) SetVocabStatus(id, status string) error {
	return vocab.UpdateStatus(id, status)
}

// DeleteVocab removes a word from the notebook.
func (b *Backend) DeleteVocab(id string) error {
	return vocab.Delete(id)
}
