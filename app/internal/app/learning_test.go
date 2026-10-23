package app

import (
	"os"
	"path/filepath"
	"testing"

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
	for _, table := range []string{"vocab", "vocab_seen"} {
		if _, err := d.Exec(`DELETE FROM ` + table); err != nil {
			t.Fatalf("reset %s: %v", table, err)
		}
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
