package app

import (
	"context"
	"errors"
	"strings"
	"sync"
	"time"

	"epubmaker-desktop/internal/config"
	"epubmaker-desktop/internal/dict"
	"epubmaker-desktop/internal/dictcache"
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
	return resolveWord(raw)
}

/* ------------------------------- glosses ------------------------------- */

// gloss is what the app can say about one word.
type gloss struct {
	Phonetic    string
	Translation string
	// TriedOnline records that a previous run asked a public dictionary and
	// came back empty-handed. The word is still unexplained, but it is no
	// longer a gap — asking again every time the notebook opens would be
	// nothing but traffic for an answer that does not exist.
	TriedOnline bool
}

// glossOf resolves a word for the list rows: the local dictionary first, then a
// gloss fetched online earlier.
func glossOf(d *dict.Dict, term string) gloss {
	g := gloss{}
	if d != nil {
		if res, err := d.Lookup(term); err == nil && res != nil {
			g = glossFrom(res.Entry, res.Base)
		}
	}
	if g.Translation != "" {
		return g
	}
	if e, err := dictcache.Get(term); err == nil && e != nil {
		g.TriedOnline = true
		if g.Phonetic == "" {
			g.Phonetic = e.Phonetic
		}
		g.Translation = firstNonEmpty(e.Translation, e.Definition)
	}
	return g
}

// glossFrom reads the meaning off a dictionary entry and, when that entry
// explains nothing, off its base form.
//
// This is the whole reason a word like "disrupts" used to render as
// 「（词库无释义）」: ECDICT ships inflected forms as their own rows, and those
// rows carry `exchange = 0:disrupt` plus an empty translation. The answer was
// one row away the entire time.
//
// A Chinese translation always wins over an English definition, wherever it
// comes from: the notebook is written in Chinese.
func glossFrom(entry, base *dict.Entry) gloss {
	g := gloss{}
	if entry != nil {
		g.Phonetic = entry.Phonetic
		g.Translation = entry.Translation
	}
	if base != nil {
		if g.Phonetic == "" {
			g.Phonetic = base.Phonetic
		}
		if g.Translation == "" {
			g.Translation = base.Translation
		}
	}
	if g.Translation == "" && entry != nil {
		g.Translation = entry.Definition
	}
	if g.Translation == "" && base != nil {
		g.Translation = base.Definition
	}
	return g
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}

// cachedLookup answers from the glosses fetched online earlier. It is consulted
// only after the local dictionary has missed: a cached gloss must never
// override a real entry.
func cachedLookup(raw string) *LookupResult {
	term := dict.Normalize(raw)
	if term == "" {
		return nil
	}
	e, err := dictcache.Get(term)
	if err != nil || e == nil {
		return nil
	}
	translation := firstNonEmpty(e.Translation, e.Definition)
	if translation == "" {
		return nil // a tombstone: we asked, nobody knew
	}
	return &LookupResult{
		Found:   true,
		Query:   term,
		Matched: firstNonEmpty(e.Word, term),
		Entry: &WordDetail{
			Word:        firstNonEmpty(e.Word, term),
			Phonetic:    e.Phonetic,
			Translation: e.Translation,
			Definition:  e.Definition,
			Source:      e.Source,
		},
	}
}

// resolveWord runs the full chain for one word: local dictionary, then the
// online cache, then a miss. A missing dictionary is not an error here — the
// telephone ships with a trimmed one, and a cached gloss still answers.
func resolveWord(raw string) (*LookupResult, error) {
	d, err := openDict()
	if err != nil && !errors.Is(err, dict.ErrNotInstalled) {
		return nil, err
	}
	if err == nil {
		res, err := d.Lookup(raw)
		if err != nil {
			return nil, err
		}
		if res.Found {
			return toLookupResult(res), nil
		}
	}
	if hit := cachedLookup(raw); hit != nil {
		return hit, nil
	}
	return &LookupResult{Found: false, Query: dict.Normalize(raw)}, nil
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
	// Source is set only for glosses that came from the online cache, so the
	// card can say where an otherwise unexplained word came from.
	Source string `json:"source,omitempty"`
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
	// The card must open and say "not found" instead of the tap doing nothing,
	// so a missing dictionary is a miss rather than an error.
	out, err := resolveWord(raw)
	if err != nil {
		return nil, err
	}
	if !out.Found || out.Entry == nil {
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
	d, _ := openDict() // nil on a device with no dictionary; glossOf copes
	out := make([]VocabItem, 0, len(rows))
	for _, row := range rows {
		item := VocabItem{ListItem: row}
		g := glossOf(d, row.Term)
		item.Phonetic, item.Translation = g.Phonetic, g.Translation
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
	d, _ := openDict()
	out := make([]LookupHit, 0, len(rows))
	for _, row := range rows {
		hit := LookupHit{Lookup: row}
		g := glossOf(d, row.Term)
		hit.Phonetic, hit.Translation = g.Phonetic, g.Translation
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

/* ----------------------------- online glosses ----------------------------- */

// The notebook's remaining blind spot is the word no local dictionary has and
// no earlier fetch explained: proper nouns, coinages, and whatever the trimmed
// Android dictionary left out. Filling those in is a deliberate,
// reader-initiated action — it is the one place in the app that sends a word to
// a server, and it should never happen behind their back.
//
// A filled gloss goes into the library database (see dictcache), and from then
// on answers like any other entry: in the notebook, in the review card, and in
// the reader's popover.

const (
	// fillBatch is how many words one click asks for. Eight keeps the wait to a
	// few seconds and, more importantly, keeps a flaky network from turning one
	// click into a minute of spinner.
	fillBatch    = 8
	fillBatchMax = 40
)

// fetchOnline is a seam for the tests: the suite must never touch the network.
var fetchOnline = dict.FetchOnline

// fillMu keeps two clicks from asking about the same words at once. The
// frontend disables the button while a round runs, but a second device window
// or a retried call would otherwise duplicate every request in flight.
var fillMu sync.Mutex

// glossGaps lists the notebook words nothing can explain yet.
func glossGaps() ([]string, error) {
	terms, err := vocab.Terms()
	if err != nil {
		return nil, err
	}
	d, _ := openDict()
	out := make([]string, 0, len(terms))
	for _, term := range terms {
		if g := glossOf(d, term); g.Translation == "" && !g.TriedOnline {
			out = append(out, term)
		}
	}
	return out, nil
}

// VocabGlossGaps reports how many notebook words have no meaning at all —
// neither the local dictionary nor a previous online lookup could explain them.
func (b *Backend) VocabGlossGaps() (int, error) {
	gaps, err := glossGaps()
	if err != nil {
		return 0, err
	}
	return len(gaps), nil
}

// GlossFillResult reports one round of filling in.
type GlossFillResult struct {
	Tried     int `json:"tried"`
	Filled    int `json:"filled"`
	NotFound  int `json:"notFound"`
	Failed    int `json:"failed"`
	Remaining int `json:"remaining"`
}

// FillVocabGlosses asks a public dictionary for up to `limit` unexplained
// notebook words and stores the answers.
//
// It reports failures instead of returning them: one unreachable word must not
// throw away the seven that worked.
func (b *Backend) FillVocabGlosses(limit int) (*GlossFillResult, error) {
	fillMu.Lock()
	defer fillMu.Unlock()
	if limit <= 0 {
		limit = fillBatch
	}
	if limit > fillBatchMax {
		limit = fillBatchMax
	}
	gaps, err := glossGaps()
	if err != nil {
		return nil, err
	}
	total := len(gaps)
	res := &GlossFillResult{Remaining: total}
	if total == 0 {
		return res, nil
	}
	if len(gaps) > limit {
		gaps = gaps[:limit]
	}

	// Generous overall budget: each source has its own 6s timeout, and two are
	// tried per word.
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(len(gaps))*12*time.Second)
	defer cancel()

	for i, term := range gaps {
		if i > 0 {
			// About six words a second: these are hand-made requests, not a
			// crawl, and both sources are free.
			select {
			case <-ctx.Done():
			case <-time.After(150 * time.Millisecond):
			}
		}
		res.Tried++
		e, err := fetchOnline(ctx, term)
		switch {
		case err != nil:
			res.Failed++
		case e == nil:
			// The sources answered and neither knew the word. Record the
			// attempt (an entry with no gloss) so the next visit does not ask
			// again — an unanswerable word would otherwise sit in the gap
			// count forever.
			res.NotFound++
			_ = dictcache.Put(dictcache.Entry{Term: term, Word: term})
		default:
			err := dictcache.Put(dictcache.Entry{
				Term:        term,
				Word:        firstNonEmpty(e.Word, term),
				Phonetic:    e.Phonetic,
				Translation: e.Translation,
				Definition:  e.Definition,
				Source:      e.Source,
			})
			if err != nil {
				res.Failed++
			} else {
				res.Filled++
			}
		}
	}
	res.Remaining = total - res.Filled - res.NotFound
	return res, nil
}
