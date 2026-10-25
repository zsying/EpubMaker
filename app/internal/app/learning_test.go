package app

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"epubmaker-desktop/internal/config"
	"epubmaker-desktop/internal/db"
	"epubmaker-desktop/internal/dict"
	"epubmaker-desktop/internal/dictcache"
)

// policyCSV covers the three cases the recording policy has to distinguish:
// basic vocabulary (the), a rare word (blorp), and an inflected form whose own
// entry only cross-references its base (blimped).
//
// blorps is the row that made the notebook show「（词库无释义）」: an inflected
// form ECDICT ships with an empty translation, whose base form says everything.
const policyCSV = `word,phonetic,definition,translation,pos,collins,oxford,tag,bnc,frq,exchange,detail,audio
the,ðə,,"art. 这",art:100,5,1,zk,1,1,,
blorp,,"a made-up noun","n. 虚构词",n:100,0,0,,0,20000,,
blimp,,"a small airship","n. 小型飞艇",n:100,0,0,,0,30000,,
blimped,,"imp. of blimp","v. blimp的过去式",,0,0,,0,25000,0:blimp/1:pd,,
blorps,,,,,0,0,,0,26000,0:blorp,,
`

func TestMain(m *testing.M) {
	dir, err := os.MkdirTemp("", "epubmaker-app-test")
	if err != nil {
		panic(err)
	}
	os.Setenv("EPUBMAKER_HOME", dir)
	csvPath := filepath.Join(dir, "policy.csv")
	if err := os.WriteFile(csvPath, []byte(policyCSV), 0o644); err != nil {
		panic(err)
	}
	if err := dict.ImportCSV(csvPath, config.Get().Paths.DictDB, nil); err != nil {
		panic(err)
	}
	code := m.Run()
	closeDict()
	_ = db.Close()
	_ = os.RemoveAll(dir)
	os.Exit(code)
}

func resetPolicy(t *testing.T) {
	t.Helper()
	d, err := db.Open()
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	for _, table := range []string{"dict_online", "lookup_history", "vocab", "vocab_seen", "annotations", "bookmarks", "reading_progress", "chapters", "books"} {
		if _, err := d.Exec(`DELETE FROM ` + table); err != nil {
			t.Fatalf("reset %s: %v", table, err)
		}
	}
}

// seedBook inserts a book (and one chapter) so a notebook entry can point at
// real titles. Pass deleted=true to simulate a book that has been thrown away.
func seedBook(t *testing.T, id, title, chapterID, chapterTitle string, deleted bool) {
	t.Helper()
	d, err := db.Open()
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	var deletedAt any
	if deleted {
		deletedAt = now
	}
	if _, err := d.Exec(
		`INSERT INTO books (id, title, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?)`,
		id, title, now, now, deletedAt); err != nil {
		t.Fatalf("seed book: %v", err)
	}
	if chapterID == "" {
		return
	}
	if _, err := d.Exec(
		`INSERT INTO chapters (id, book_id, idx, title, href, created_at, updated_at) VALUES (?, ?, 0, ?, 'c1.xhtml', ?, ?)`,
		chapterID, id, chapterTitle, now, now); err != nil {
		t.Fatalf("seed chapter: %v", err)
	}
}

func TestDictStatusReportsInstalled(t *testing.T) {
	b := &Backend{}
	st, err := b.DictStatus()
	if err != nil {
		t.Fatal(err)
	}
	if !st.Installed || st.Entries != 5 {
		t.Fatalf("status = %+v, want installed with 5 entries", st)
	}
}

// Basic vocabulary must never reach the notebook, no matter how often it is
// looked up — otherwise the notebook fills with "the" and "of".
func TestCommonWordIsNeverAutoRecorded(t *testing.T) {
	resetPolicy(t)
	b := &Backend{}
	for i := 0; i < 3; i++ {
		r, err := b.LookupWord("b1", "c1", 10, "the", "the house")
		if err != nil {
			t.Fatal(err)
		}
		if !r.Found {
			t.Fatal("the should be found")
		}
		if !r.Common {
			t.Error("the should be flagged as common vocabulary")
		}
		if r.Recorded {
			t.Fatalf("lookup #%d auto-recorded a common word", i+1)
		}
	}
	list := allVocab(t, b, "", "")
	if len(list) != 0 {
		t.Fatalf("notebook should be empty, got %+v", list)
	}
}

// A rare word enters the notebook on the second lookup: the first is often
// curiosity, the second means it is genuinely unknown.
func TestRareWordRecordedOnSecondLookup(t *testing.T) {
	resetPolicy(t)
	b := &Backend{}

	first, err := b.LookupWord("b1", "c1", 120, "blorp", "a blorp appeared")
	if err != nil {
		t.Fatal(err)
	}
	if first.Recorded {
		t.Fatal("first lookup must not record")
	}
	if first.SeenCount != 1 {
		t.Errorf("SeenCount = %d, want 1", first.SeenCount)
	}
	if list := allVocab(t, b, "", ""); len(list) != 0 {
		t.Fatalf("notebook should still be empty, got %v", list)
	}

	second, err := b.LookupWord("b1", "c1", 400, "blorp", "the blorp vanished")
	if err != nil {
		t.Fatal(err)
	}
	if !second.Recorded || second.VocabID == "" {
		t.Fatalf("second lookup should record: %+v", second)
	}
	list := allVocab(t, b, "", "")
	if len(list) != 1 || list[0].Term != "blorp" {
		t.Fatalf("notebook = %+v, want blorp", list)
	}
	// The entry is created by the lookup that promoted it, so the stored
	// context is the second occurrence — the first one was never persisted
	// (vocab_seen is a counter, not a history).
	if list[0].Context != "the blorp vanished" {
		t.Errorf("context = %q, want the promoting occurrence", list[0].Context)
	}
}

// Once a word is in the notebook, later lookups keep it and bump its counter —
// they must not be blocked by the frequency rule or the seen-count rule.
func TestRecordedWordKeepsCounting(t *testing.T) {
	resetPolicy(t)
	b := &Backend{}
	if _, err := b.LookupWord("b1", "c1", 0, "blorp", "ctx1"); err != nil {
		t.Fatal(err)
	}
	if _, err := b.LookupWord("b1", "c1", 0, "blorp", "ctx2"); err != nil {
		t.Fatal(err)
	}
	third, err := b.LookupWord("b2", "c2", 0, "blorp", "ctx3")
	if err != nil {
		t.Fatal(err)
	}
	if !third.Recorded {
		t.Fatal("an already-recorded word should stay recorded")
	}
	list := allVocab(t, b, "", "")
	if len(list) != 1 {
		t.Fatalf("expected one row, got %d", len(list))
	}
	if list[0].Lookups != 2 {
		t.Errorf("lookups = %d, want 2 (2nd and 3rd call)", list[0].Lookups)
	}
}

// The manual path always works, even for basic vocabulary.
func TestVocabAddOverridesPolicy(t *testing.T) {
	resetPolicy(t)
	b := &Backend{}
	v, err := b.VocabAdd("the", "the", "b1", "c1", 5, "the house")
	if err != nil {
		t.Fatal(err)
	}
	if v.Term != "the" {
		t.Fatalf("term = %q", v.Term)
	}
	list := allVocab(t, b, "", "")
	if len(list) != 1 {
		t.Fatalf("notebook = %+v", list)
	}
	if err := b.SetVocabStatus(v.ID, "known"); err != nil {
		t.Fatal(err)
	}
	known := allVocab(t, b, "known", "")
	if len(known) != 1 {
		t.Fatalf("status filter failed: %+v", known)
	}
}

// An inflected form must come back with its base form so the popover can show
// real meaning instead of "past tense of blimp".
func TestLookupWordExposesBaseForm(t *testing.T) {
	resetPolicy(t)
	b := &Backend{}
	r, err := b.LookupWord("b1", "c1", 0, "blimped", "")
	if err != nil {
		t.Fatal(err)
	}
	if !r.Found || r.Entry == nil || r.Entry.Word != "blimped" {
		t.Fatalf("entry = %+v", r.Entry)
	}
	if r.Base == nil || r.Base.Word != "blimp" {
		t.Fatalf("base = %+v, want blimp", r.Base)
	}
	if r.Base.Translation != "n. 小型飞艇" {
		t.Errorf("base translation = %q", r.Base.Translation)
	}
}

func TestLookupWordWithoutDictionaryEntry(t *testing.T) {
	resetPolicy(t)
	b := &Backend{}
	r, err := b.LookupWord("b1", "c1", 0, "zzzznotaword", "")
	if err != nil {
		t.Fatal(err)
	}
	if r.Found || r.Entry != nil || r.Recorded {
		t.Fatalf("expected a clean miss, got %+v", r)
	}
}

/* --------------------------- notebook page --------------------------- */

// The notebook list has to be readable on its own: a word without a meaning is
// just a string, so each row carries the dictionary gloss and where it was met.
func TestVocabListCarriesMeaningAndOrigin(t *testing.T) {
	resetPolicy(t)
	seedBook(t, "tb-1", "Test Book", "tbc-1", "Chapter One", false)
	b := &Backend{}
	if _, err := b.VocabAdd("blorp", "blorp", "tb-1", "tbc-1", 120, "a blorp appeared"); err != nil {
		t.Fatal(err)
	}
	if _, err := b.VocabAdd("the", "the", "tb-1", "tbc-1", 5, "the house"); err != nil {
		t.Fatal(err)
	}

	list := allVocab(t, b, "", "")
	if len(list) != 2 {
		t.Fatalf("list = %+v, want 2 rows", list)
	}
	byTerm := map[string]VocabItem{}
	for _, it := range list {
		byTerm[it.Term] = it
	}
	blorp := byTerm["blorp"]
	if blorp.Translation != "n. 虚构词" {
		t.Errorf("blorp translation = %q", blorp.Translation)
	}
	if blorp.BookTitle != "Test Book" || blorp.ChapterTitle != "Chapter One" {
		t.Errorf("blorp origin = %q / %q", blorp.BookTitle, blorp.ChapterTitle)
	}
	if blorp.Context != "a blorp appeared" || blorp.Offset != 120 {
		t.Errorf("blorp context = %q @%d", blorp.Context, blorp.Offset)
	}
	if the := byTerm["the"]; the.Phonetic != "ðə" {
		t.Errorf("the phonetic = %q, want ðə", the.Phonetic)
	}
}

// Deleting a book must not delete the words learned from it. The entry stays;
// only the trail back to the text is gone, so the title is empty rather than
// the row disappearing.
func TestVocabListKeepsWordsFromDeletedBooks(t *testing.T) {
	resetPolicy(t)
	seedBook(t, "tb-2", "Gone Book", "tbc-2", "Chapter Two", true)
	b := &Backend{}
	if _, err := b.VocabAdd("blimp", "blimp", "tb-2", "tbc-2", 40, "a blimp floated"); err != nil {
		t.Fatal(err)
	}
	list := allVocab(t, b, "", "")
	if len(list) != 1 {
		t.Fatalf("word vanished with its book: %+v", list)
	}
	if list[0].Term != "blimp" {
		t.Fatalf("term = %q", list[0].Term)
	}
	if list[0].BookTitle != "" {
		t.Errorf("bookTitle = %q, want empty for a deleted book", list[0].BookTitle)
	}
}

func TestVocabStatsCountsByStatus(t *testing.T) {
	resetPolicy(t)
	b := &Backend{}
	v1, err := b.VocabAdd("blorp", "blorp", "", "", 0, "")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := b.VocabAdd("blimp", "blimp", "", "", 0, ""); err != nil {
		t.Fatal(err)
	}
	if err := b.SetVocabStatus(v1.ID, "known"); err != nil {
		t.Fatal(err)
	}

	st, err := b.VocabStats()
	if err != nil {
		t.Fatal(err)
	}
	if st.Total != 2 || st.New != 1 || st.Known != 1 {
		t.Fatalf("stats = %+v, want total 2 / new 1 / known 1", st)
	}
}

// The history logs what the notebook refuses as well: basic vocabulary never
// gets a row in the notebook, but the reader did look the word up and expects
// to find it in the history — with its gloss, since that is what makes the list
// readable.
func TestLookupHistoryLogsBasicVocabulary(t *testing.T) {
	resetPolicy(t)
	b := &Backend{}
	for i := 0; i < 2; i++ {
		if _, err := b.LookupWord("b1", "c1", 0, "the", "the house"); err != nil {
			t.Fatal(err)
		}
	}
	list := allLookups(t, b, "")
	if len(list) != 1 {
		t.Fatalf("history = %+v, want one row", list)
	}
	hit := list[0]
	if hit.Term != "the" || hit.Lookups != 2 {
		t.Errorf("row = %+v, want the ×2", hit)
	}
	if hit.InNotebook || hit.Status != "" {
		t.Errorf("basic vocabulary entered the notebook: %+v", hit)
	}
	if hit.Translation != "art. 这" {
		t.Errorf("translation = %q", hit.Translation)
	}
}

// A word that is already in the notebook stays in the history, carrying the
// notebook's state, so the page can say "已在生词本" instead of offering the
// button again.
func TestLookupHistoryMarksNotebookWords(t *testing.T) {
	resetPolicy(t)
	b := &Backend{}
	if _, err := b.VocabAdd("blorp", "blorp", "", "", 0, ""); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		if _, err := b.LookupWord("b1", "c1", 0, "blorp", "a blorp appeared"); err != nil {
			t.Fatal(err)
		}
	}
	list := allLookups(t, b, "")
	if len(list) != 1 {
		t.Fatalf("history = %+v", list)
	}
	if !list[0].InNotebook || list[0].Status != "new" {
		t.Errorf("row = %+v, want inNotebook/new", list[0])
	}
	// The manual add itself is not a lookup: the two taps above are.
	if list[0].Lookups != 2 {
		t.Errorf("lookups = %d, want 2", list[0].Lookups)
	}
}

// A word the dictionary does not know never reaches the history: a log entry
// with no gloss is a dead end for the page.
func TestLookupHistoryIgnoresUnknownWords(t *testing.T) {
	resetPolicy(t)
	b := &Backend{}
	if _, err := b.LookupWord("b1", "c1", 0, "zzzznotaword", ""); err != nil {
		t.Fatal(err)
	}
	list := allLookups(t, b, "")
	if len(list) != 0 {
		t.Fatalf("history = %+v, want empty", list)
	}
}

// The review session is built from the schedule, not from whatever the notebook
// page happened to have loaded: a word graded a moment ago is not due again yet,
// and graded words keep their meaning attached when it does come back.
func TestVocabQueueIsTheReviewSession(t *testing.T) {
	resetPolicy(t)
	b := &Backend{}
	missed, err := b.VocabAdd("blorp", "blorp", "", "", 0, "a blorp appeared")
	if err != nil {
		t.Fatal(err)
	}
	mastered, err := b.VocabAdd("blimp", "blimp", "", "", 0, "")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := b.GradeVocab(missed.ID, false); err != nil {
		t.Fatal(err)
	}
	if _, err := b.GradeVocab(mastered.ID, true); err != nil {
		t.Fatal(err)
	}

	// Both words are now scheduled — one ten minutes out, one a day out — so
	// nothing is due and the session is empty.
	q, err := b.VocabQueue(0)
	if err != nil {
		t.Fatal(err)
	}
	if len(q) != 0 {
		t.Fatalf("queue = %+v, want nothing due yet", q)
	}

	// Ten minutes later the missed word comes back.
	d, err := db.Open()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := d.Exec(`UPDATE vocab SET due_at = ? WHERE id = ?`,
		time.Now().UTC().Add(-time.Minute).Format("2006-01-02T15:04:05Z"), missed.ID); err != nil {
		t.Fatal(err)
	}
	q, err = b.VocabQueue(0)
	if err != nil {
		t.Fatal(err)
	}
	if len(q) != 1 || q[0].Term != "blorp" {
		t.Fatalf("queue = %+v, want just blorp", q)
	}
	if q[0].Status != "learning" || q[0].Reviews != 1 {
		t.Errorf("graded row = %+v", q[0])
	}
	if q[0].Translation != "n. 虚构词" {
		t.Errorf("translation = %q, want the gloss attached", q[0].Translation)
	}
}

/* -------------------------------- paging -------------------------------- */

// allVocab reads the notebook in a single request. The tests care about what is
// in it, not about the paging the page uses, so they ask for the largest
// screenful the backend will serve.
func allVocab(t *testing.T, b *Backend, status, keyword string) []VocabItem {
	t.Helper()
	page, err := b.ListVocab(status, keyword, 0, listPageMaxSize)
	if err != nil {
		t.Fatal(err)
	}
	return page.Items
}

func allLookups(t *testing.T, b *Backend, keyword string) []LookupHit {
	t.Helper()
	page, err := b.ListLookupHistory(keyword, 0, listPageMaxSize)
	if err != nil {
		t.Fatal(err)
	}
	return page.Items
}

// Reading the notebook one screenful at a time must neither drop nor repeat a
// row. The whole point of paging is that the reader never learns the list was
// cut up, and a gap between pages would be the one way to tell.
func TestVocabPagesCoverTheListExactly(t *testing.T) {
	resetPolicy(t)
	b := &Backend{}
	const n = 7
	for i := 0; i < n; i++ {
		term := fmt.Sprintf("blorp%02d", i)
		if _, err := b.VocabAdd(term, term, "", "", 0, ""); err != nil {
			t.Fatal(err)
		}
	}

	seen := map[string]bool{}
	offset := 0
	for pages := 0; ; pages++ {
		if pages > n {
			t.Fatal("paging did not terminate")
		}
		page, err := b.ListVocab("", "", offset, 3)
		if err != nil {
			t.Fatal(err)
		}
		if page.Total != n {
			t.Fatalf("total = %d, want %d on every page", page.Total, n)
		}
		if len(page.Items) > 3 {
			t.Fatalf("page returned %d rows for limit 3", len(page.Items))
		}
		for _, it := range page.Items {
			if seen[it.Term] {
				t.Fatalf("%q came back twice across pages", it.Term)
			}
			seen[it.Term] = true
		}
		offset += len(page.Items)
		if !page.HasMore {
			break
		}
	}
	if len(seen) != n {
		t.Fatalf("saw %d of %d words across pages", len(seen), n)
	}
}

// A page size of zero means "the default screenful", not "everything": the
// lists are unbounded, and a caller that forgets the argument must not be able
// to pull the whole notebook over the bridge.
func TestVocabPageSizeIsClamped(t *testing.T) {
	resetPolicy(t)
	b := &Backend{}
	for i := 0; i < listPageSize+1; i++ {
		term := fmt.Sprintf("blorp%02d", i)
		if _, err := b.VocabAdd(term, term, "", "", 0, ""); err != nil {
			t.Fatal(err)
		}
	}

	page, err := b.ListVocab("", "", 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != listPageSize {
		t.Fatalf("got %d rows for a zero limit, want the default %d", len(page.Items), listPageSize)
	}
	if !page.HasMore {
		t.Error("hasMore should be true with one word left over")
	}
	if page.Total != listPageSize+1 {
		t.Errorf("total = %d, want %d", page.Total, listPageSize+1)
	}

	// The last screenful is the one that has to say "no more" — an off-by-one
	// there is what makes a list show a "load more" button that loads nothing.
	rest, err := b.ListVocab("", "", listPageSize, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(rest.Items) != 1 || rest.HasMore {
		t.Fatalf("tail = %d rows, hasMore = %v", len(rest.Items), rest.HasMore)
	}
}

// The history is the fastest-growing list in the app; it pages the same way.
func TestLookupHistoryPagesCoverTheListExactly(t *testing.T) {
	resetPolicy(t)
	b := &Backend{}
	for _, w := range []string{"the", "blorp", "blimp"} {
		if _, err := b.LookupWord("b1", "c1", 0, w, "context with "+w); err != nil {
			t.Fatal(err)
		}
	}

	seen := map[string]bool{}
	offset := 0
	for pages := 0; ; pages++ {
		if pages > 5 {
			t.Fatal("paging did not terminate")
		}
		page, err := b.ListLookupHistory("", offset, 2)
		if err != nil {
			t.Fatal(err)
		}
		if page.Total != 3 {
			t.Fatalf("total = %d, want 3", page.Total)
		}
		for _, hit := range page.Items {
			if seen[hit.Term] {
				t.Fatalf("%q came back twice across pages", hit.Term)
			}
			seen[hit.Term] = true
		}
		offset += len(page.Items)
		if !page.HasMore {
			break
		}
	}
	if len(seen) != 3 {
		t.Fatalf("saw %d of 3 words", len(seen))
	}
}

/* ---------------------------- online glosses ---------------------------- */

// stubFetch replaces the network for the duration of one test and returns a
// counter of how many lookups were attempted.
func stubFetch(t *testing.T, fn func(ctx context.Context, word string) (*dict.Online, error)) *int {
	t.Helper()
	calls := 0
	old := fetchOnline
	fetchOnline = func(ctx context.Context, word string) (*dict.Online, error) {
		calls++
		return fn(ctx, word)
	}
	t.Cleanup(func() { fetchOnline = old })
	return &calls
}

// The notebook used to render「（词库无释义）」for an inflected form whose own
// row is empty — while the base form, one row away, has the whole answer.
func TestGlossFallsBackToTheBaseForm(t *testing.T) {
	resetPolicy(t)
	if _, err := (&Backend{}).VocabAdd("blorps", "blorps", "", "", 0, "a context"); err != nil {
		t.Fatal(err)
	}
	d, err := openDict()
	if err != nil {
		t.Fatal(err)
	}
	g := glossOf(d, "blorps")
	if !strings.Contains(g.Translation, "虚构词") {
		t.Fatalf("translation = %q, want the base form's gloss", g.Translation)
	}
	if g.TriedOnline {
		t.Error("a word its base form explains is not an online gap")
	}
}

// A word the base form rescues must not be counted as missing, or the page
// would offer to go online for something it can already answer.
func TestGlossGapsIgnoresWordsTheBaseFormExplains(t *testing.T) {
	resetPolicy(t)
	b := &Backend{}
	for _, w := range []string{"blorp", "blorps", "zorblat"} {
		if _, err := b.VocabAdd(w, w, "", "", 0, ""); err != nil {
			t.Fatal(err)
		}
	}
	gaps, err := b.VocabGlossGaps()
	if err != nil {
		t.Fatal(err)
	}
	if gaps != 1 {
		t.Fatalf("gaps = %d, want 1 — only zorblat is unexplained", gaps)
	}
}

func TestFillVocabGlossesStoresWhatItFound(t *testing.T) {
	resetPolicy(t)
	b := &Backend{}
	if _, err := b.VocabAdd("zorblat", "zorblat", "", "", 0, ""); err != nil {
		t.Fatal(err)
	}
	stubFetch(t, func(_ context.Context, word string) (*dict.Online, error) {
		return &dict.Online{
			Word: word, Phonetic: "ˈzɔːblæt", Translation: "n. 编出来的词",
			Source: dict.SourceYoudao,
		}, nil
	})

	res, err := b.FillVocabGlosses(8)
	if err != nil {
		t.Fatal(err)
	}
	if res.Tried != 1 || res.Filled != 1 || res.Remaining != 0 {
		t.Fatalf("result = %+v", res)
	}

	// The gloss now answers like any other entry: the popover, the notebook
	// rows, and the gap count all read from the same place.
	hit := cachedLookup("zorblat")
	if hit == nil || hit.Entry == nil || hit.Entry.Translation != "n. 编出来的词" {
		t.Fatalf("cachedLookup = %+v", hit)
	}
	if gaps, err := b.VocabGlossGaps(); err != nil || gaps != 0 {
		t.Errorf("gaps = %d, %v after filling", gaps, err)
	}
	page, err := b.ListVocab("", "", 0, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 1 || page.Items[0].Translation != "n. 编出来的词" {
		t.Fatalf("page items = %+v", page.Items)
	}
	found, err := b.DictLookup("zorblat")
	if err != nil {
		t.Fatal(err)
	}
	if !found.Found || found.Entry == nil || found.Entry.Source != dict.SourceYoudao {
		t.Fatalf("DictLookup = %+v", found)
	}
}

// A word no source knows must be recorded as attempted. Otherwise every visit to
// the notebook would ask for it again, forever, and the gap count would never
// reach zero.
func TestFillVocabGlossesRemembersAMiss(t *testing.T) {
	resetPolicy(t)
	b := &Backend{}
	if _, err := b.VocabAdd("zorblat", "zorblat", "", "", 0, ""); err != nil {
		t.Fatal(err)
	}
	calls := stubFetch(t, func(context.Context, string) (*dict.Online, error) {
		return nil, nil // both sources answered, neither knew it
	})

	res, err := b.FillVocabGlosses(8)
	if err != nil {
		t.Fatal(err)
	}
	if res.NotFound != 1 || res.Filled != 0 || res.Remaining != 0 {
		t.Fatalf("result = %+v", res)
	}
	if gaps, err := b.VocabGlossGaps(); err != nil || gaps != 0 {
		t.Errorf("gaps = %d, %v: an answered miss is not a gap", gaps, err)
	}
	if _, err := b.FillVocabGlosses(8); err != nil {
		t.Fatal(err)
	}
	if *calls != 1 {
		t.Errorf("asked %d times, want 1 — a known miss must not be retried", *calls)
	}
}

// A network failure is different from a miss: it stays a gap, so the next click
// tries again.
func TestFillVocabGlossesKeepsGapsThatFailed(t *testing.T) {
	resetPolicy(t)
	b := &Backend{}
	for _, w := range []string{"quibblex", "zorblat"} {
		if _, err := b.VocabAdd(w, w, "", "", 0, ""); err != nil {
			t.Fatal(err)
		}
	}
	stubFetch(t, func(_ context.Context, word string) (*dict.Online, error) {
		if word == "quibblex" {
			return nil, errors.New("network is down")
		}
		return &dict.Online{Word: word, Translation: "n. 甲的释义", Source: dict.SourceYoudao}, nil
	})

	res, err := b.FillVocabGlosses(8)
	if err != nil {
		t.Fatal(err)
	}
	if res.Filled != 1 || res.Failed != 1 {
		t.Fatalf("result = %+v, want one of each", res)
	}
	if gaps, err := b.VocabGlossGaps(); err != nil || gaps != 1 {
		t.Errorf("gaps = %d, %v: the failed word must stay retryable", gaps, err)
	}
}

// A cached gloss must never override a real entry. The ECDICT row is
// authoritative; the network copy is only a last resort.
func TestCachedGlossDoesNotOverrideTheDictionary(t *testing.T) {
	resetPolicy(t)
	if err := dictcache.Put(dictcache.Entry{
		Term: "blorp", Word: "blorp", Translation: "n. 网络上抄错的释义", Source: dict.SourceYoudao,
	}); err != nil {
		t.Fatal(err)
	}
	found, err := (&Backend{}).DictLookup("blorp")
	if err != nil {
		t.Fatal(err)
	}
	if found.Entry == nil || !strings.Contains(found.Entry.Translation, "虚构词") {
		t.Fatalf("DictLookup = %+v, want the local entry", found)
	}
	if found.Entry.Source != "" {
		t.Errorf("source = %q, want empty for a local entry", found.Entry.Source)
	}
}
