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
		if errors.Is(err, dict.ErrNotInstalled) {
			// No dictionary on this device (the phone ships without one).
			// Return a clean miss so the lookup card can say so — an error
			// here is swallowed by the frontend and the tap looks dead.
			return &LookupResult{Found: false, Query: raw}, nil
		}
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
		if errors.Is(err, dict.ErrNotInstalled) {
			// Same graceful miss as DictLookup: the card must open and say
			// "no dictionary" instead of the tap doing nothing at all.
			return &LookupResult{Found: false, Query: raw}, nil
		}
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

	// The history records the lookup itself, before any policy runs: "what did
	// I tap on" is a fact about the reader, not about the notebook. Recording
	// it here is also what keeps basic vocabulary (never promoted) and words
	// already in the notebook visible in the history page.
	if err := vocab.RecordLookup(term); err != nil {
		return nil, err
	}

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

// The word lists — the notebook and the lookup history — are unbounded: the
// history records every tap, and the notebook keeps every word that survived
// the frequency rule. Fetching either whole makes opening the page slower and
// slower as the reader uses the app, and each row costs a dictionary lookup on
// top of the query. So they are read one screenful at a time.
//
// listPageSize is also the latency budget: 40 rows is a few milliseconds, while
// 2000 rows is a visible pause before anything appears.
const (
	listPageSize    = 40
	listPageMaxSize = 200
)

// clampPage normalises a paging request. A zero limit asks for the default
// screenful rather than "everything" — that is the whole point of the split.
func clampPage(offset, limit int) (int, int) {
	if offset < 0 {
		offset = 0
	}
	if limit <= 0 {
		limit = listPageSize
	}
	if limit > listPageMaxSize {
		limit = listPageMaxSize
	}
	return offset, limit
}

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

// VocabItem is one notebook row as the notebook page renders it: the stored
// word plus the dictionary gloss, so the list is readable without opening each
// word.
type VocabItem struct {
	vocab.ListItem
	Phonetic    string `json:"phonetic"`
	Translation string `json:"translation"`
}

// VocabPage is one screenful of the notebook. Total counts the same filter, so
// the page can say how big the notebook is without having downloaded it, and
// HasMore says whether asking for the next screenful will return anything.
type VocabPage struct {
	Items   []VocabItem `json:"items"`
	Total   int         `json:"total"`
	HasMore bool        `json:"hasMore"`
}

// ListVocab returns one screenful of notebook entries, newest first, enriched
// with their meaning. A missing dictionary is not an error — the notebook stays
// usable, the rows just have no gloss.
func (b *Backend) ListVocab(status, keyword string, offset, limit int) (*VocabPage, error) {
	offset, limit = clampPage(offset, limit)
	opts := vocab.ListOpts{Status: status, Keyword: keyword, Limit: limit, Offset: offset}
	rows, err := vocab.List(opts)
	if err != nil {
		return nil, err
	}
	total, err := vocab.Count(opts)
	if err != nil {
		return nil, err
	}
	items := enrich(rows)
	return &VocabPage{Items: items, Total: total, HasMore: offset+len(items) < total}, nil
}

// VocabQueue returns the next review session: not-yet-mastered words, still
// unseen ones first. `limit` keeps a pass finishable.
func (b *Backend) VocabQueue(limit int) ([]VocabItem, error) {
	rows, err := vocab.Queue(limit)
	if err != nil {
		return nil, err
	}
	return enrich(rows), nil
}

// enrich attaches the dictionary gloss to each row. One lookup per row is cheap
// (indexed) and keeps the notebook page from opening a card per word.
func enrich(rows []vocab.ListItem) []VocabItem {
	d, dictErr := openDict()
	out := make([]VocabItem, 0, len(rows))
	for _, row := range rows {
		item := VocabItem{ListItem: row}
		if dictErr == nil {
			if res, err := d.Lookup(row.Term); err == nil && res.Found && res.Entry != nil {
				item.Phonetic = res.Entry.Phonetic
				item.Translation = res.Entry.Translation
				if item.Translation == "" {
					item.Translation = res.Entry.Definition
				}
			}
		}
		out = append(out, item)
	}
	return out
}

// VocabStats counts the notebook by status for the page header.
func (b *Backend) VocabStats() (*vocab.Stats, error) {
	return vocab.CountByStatus()
}

// LookupHit is one row of the lookup history as the page renders it: the log
// row plus the dictionary gloss, so the list reads without opening a card per
// word — the same shape ListVocab gives the notebook.
type LookupHit struct {
	vocab.Lookup
	Phonetic    string `json:"phonetic"`
	Translation string `json:"translation"`
}

// LookupPage is one screenful of the lookup history, with the same shape and
// the same reason as VocabPage: this is the longest list in the app.
type LookupPage struct {
	Items   []LookupHit `json:"items"`
	Total   int         `json:"total"`
	HasMore bool        `json:"hasMore"`
}

// ListLookupHistory returns one screenful of the words the reader has looked
// up, newest first. `keyword` filters on the word itself; a missing dictionary
// only costs the glosses.
func (b *Backend) ListLookupHistory(keyword string, offset, limit int) (*LookupPage, error) {
	offset, limit = clampPage(offset, limit)
	rows, err := vocab.ListLookups(keyword, limit, offset)
	if err != nil {
		return nil, err
	}
	total, err := vocab.CountLookups(keyword)
	if err != nil {
		return nil, err
	}
	d, dictErr := openDict()
	out := make([]LookupHit, 0, len(rows))
	for _, row := range rows {
		hit := LookupHit{Lookup: row}
		if dictErr == nil {
			if res, err := d.Lookup(row.Term); err == nil && res.Found && res.Entry != nil {
				hit.Phonetic = res.Entry.Phonetic
				hit.Translation = res.Entry.Translation
				if hit.Translation == "" {
					hit.Translation = res.Entry.Definition
				}
			}
		}
		out = append(out, hit)
	}
	return &LookupPage{Items: out, Total: total, HasMore: offset+len(out) < total}, nil
}

// SetVocabStatus moves a word between new / learning / known / ignored.
func (b *Backend) SetVocabStatus(id, status string) error {
	return vocab.UpdateStatus(id, status)
}

// SetVocabContext rewrites the example sentence kept with a word. The notebook
// page calls it when a stored context turns out to be a fragment — a word that
// sat at a source line wrap used to be cut out of its own sentence.
func (b *Backend) SetVocabContext(id, context string) error {
	return vocab.SetContext(id, context)
}

// GradeVocab records one review outcome and returns the updated row, so the
// review card can move on without refetching the whole notebook.
func (b *Backend) GradeVocab(id string, known bool) (*vocab.Entry, error) {
	return vocab.Grade(id, known)
}
