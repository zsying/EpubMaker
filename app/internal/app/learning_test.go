package app

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"epubmaker-desktop/internal/config"
	"epubmaker-desktop/internal/db"
	"epubmaker-desktop/internal/dict"
)

// policyCSV covers the three cases the recording policy has to distinguish:
// basic vocabulary (the), a rare word (blorp), and an inflected form whose own
// entry only cross-references its base (blimped).
const policyCSV = `word,phonetic,definition,translation,pos,collins,oxford,tag,bnc,frq,exchange,detail,audio
the,ðə,,"art. 这",art:100,5,1,zk,1,1,,
blorp,,"a made-up noun","n. 虚构词",n:100,0,0,,0,20000,,
blimp,,"a small airship","n. 小型飞艇",n:100,0,0,,0,30000,,
blimped,,"imp. of blimp","v. blimp的过去式",,0,0,,0,25000,0:blimp/1:pd,,
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
	for _, table := range []string{"vocab", "vocab_seen", "annotations", "bookmarks", "reading_progress", "chapters", "books"} {
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
	if !st.Installed || st.Entries != 4 {
		t.Fatalf("status = %+v, want installed with 4 entries", st)
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
	list, err := b.ListVocab("", "")
	if err != nil {
		t.Fatal(err)
	}
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
	if list, err := b.ListVocab("", ""); err != nil || len(list) != 0 {
		t.Fatalf("notebook should still be empty, got %v / %v", list, err)
	}

	second, err := b.LookupWord("b1", "c1", 400, "blorp", "the blorp vanished")
	if err != nil {
		t.Fatal(err)
	}
	if !second.Recorded || second.VocabID == "" {
		t.Fatalf("second lookup should record: %+v", second)
	}
	list, err := b.ListVocab("", "")
	if err != nil {
		t.Fatal(err)
	}
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
	list, err := b.ListVocab("", "")
	if err != nil {
		t.Fatal(err)
	}
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
	list, err := b.ListVocab("", "")
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 1 {
		t.Fatalf("notebook = %+v", list)
	}
	if err := b.SetVocabStatus(v.ID, "known"); err != nil {
		t.Fatal(err)
	}
	known, err := b.ListVocab("known", "")
	if err != nil {
		t.Fatal(err)
	}
	if len(known) != 1 {
		t.Fatalf("status filter failed: %+v", known)
	}
	if err := b.DeleteVocab(v.ID); err != nil {
		t.Fatal(err)
	}
	if list, err := b.ListVocab("", ""); err != nil || len(list) != 0 {
		t.Fatalf("delete failed: %v / %v", list, err)
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

	list, err := b.ListVocab("", "")
	if err != nil {
		t.Fatal(err)
	}
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
	list, err := b.ListVocab("", "")
	if err != nil {
		t.Fatal(err)
	}
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

// The review session is built from the queue, not from whatever the notebook
// page happened to have loaded, and graded words keep their meaning attached.
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

	q, err := b.VocabQueue(0)
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
