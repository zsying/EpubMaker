package dict

import (
	"os"
	"path/filepath"
	"testing"
)

// fixtureCSV mirrors the ECDICT column layout closely enough to exercise the
// importer: quoted fields with commas, empty numeric cells, and an `exchange`
// payload carrying inflected forms plus a `0:` lemma pointer.
const fixtureCSV = `word,phonetic,definition,translation,pos,collins,oxford,tag,bnc,frq,exchange,detail,audio
climb,klaim,"to go up","v. 攀登, 爬",v:100,3,1,cet4,3000,2800,d:climbed/p:climbed/3:climbs/i:climbing,,
child,tʃaild,"a young person","n. 孩子",n:100,5,1,zk,500,400,s:children,,
perceive,pə'si:v,"to notice","v. 察觉",v:100,3,0,cet6,4000,3900,0:perceive/d:perceived/p:perceived/3:perceives/i:perceiving,,
blorp,,"a made-up noun","n. 虚构词",n:100,0,0,,0,0,,,
give,,"to hand over","v. 给",v:100,5,1,cet4,100,90,3:gives/i:giving/d:given/p:gave,,
give up,,"to stop trying","phr. 放弃",,0,0,,0,0,,,
run,,"to move fast","v. 跑",v:100,5,1,cet4,80,70,d:ran/p:ran/3:runs/i:running,,
'hood,hʊd,,"n. 罩；风帽",n:100,0,0,,0,0,,,
blimp,,"a small airship","n. 小型飞艇",n:100,0,0,,0,0,,,
blimped,,"imp. & p. p. of blimp","v. blimp的过去式",,0,0,,0,0,0:blimp/1:pd,,
`

// newTestDict builds a throwaway dictionary from the fixture and returns it
// opened for queries.
func newTestDict(t *testing.T) *Dict {
	t.Helper()
	dir := t.TempDir()
	csvPath := filepath.Join(dir, "ecdict.csv")
	dbPath := filepath.Join(dir, "dict.db")
	if err := os.WriteFile(csvPath, []byte(fixtureCSV), 0o644); err != nil {
		t.Fatalf("write fixture: %v", err)
	}
	if err := ImportCSV(csvPath, dbPath, nil); err != nil {
		t.Fatalf("ImportCSV: %v", err)
	}
	d, err := Open(dbPath)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { d.Close() })
	return d
}

func TestNormalize(t *testing.T) {
	cases := []struct{ in, want string }{
		{"  Climb  ", "climb"},
		{"climb,", "climb"},
		{"“perceive.”", "perceive"},
		{"child’s", "child"},
		{"child's", "child"},
		{"dogs'", "dogs"},
		{"Give   Up", "give up"},
		{"long-time", "long-time"},
		{"", ""},
		{"--", ""},
		// Print-converted EPUBs hyphenate with a soft hyphen, and a selection
		// that spans the break carries it: "ac\u00ADcused" must reach the same
		// key as "accused", or the lookup misses a word that is right there on
		// the page. Zero-width marks and the BOM come from the same converters.
		{"ac\u00ADcused", "accused"},
		{"\u200bword\u200c\u200d", "word"},
		{"\ufeffPerceive.\u00AD", "perceive"},
	}
	for _, c := range cases {
		if got := Normalize(c.in); got != c.want {
			t.Errorf("Normalize(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

// A hyphenated word selected across the break must still be found: the soft
// hyphen is a layout artifact, not part of the headword.
func TestLookupIgnoresInvisibleMarks(t *testing.T) {
	d := newTestDict(t)
	for _, q := range []string{"per\u00ADceive", "PER\u00ADCEIVE", "perceive\u200b"} {
		r, err := d.Lookup(q)
		if err != nil {
			t.Fatalf("Lookup(%q): %v", q, err)
		}
		if !r.Found || r.Entry == nil || r.Entry.Word != "perceive" {
			t.Fatalf("Lookup(%q) = %+v, want a hit on perceive", q, r)
		}
	}
}

func TestLookupExactIsCaseInsensitive(t *testing.T) {
	d := newTestDict(t)
	for _, q := range []string{"climb", "Climb", "CLIMB", " climb. "} {
		r, err := d.Lookup(q)
		if err != nil {
			t.Fatalf("Lookup(%q): %v", q, err)
		}
		if !r.Found || r.Entry.Word != "climb" {
			t.Fatalf("Lookup(%q) = %+v, want hit on climb", q, r)
		}
		if r.Lemmatized {
			t.Errorf("Lookup(%q) reported lemmatized=true for an exact hit", q)
		}
	}
}

func TestLookupCarriesFields(t *testing.T) {
	d := newTestDict(t)
	r, err := d.Lookup("climb")
	if err != nil {
		t.Fatal(err)
	}
	if r.Entry.Phonetic != "klaim" {
		t.Errorf("phonetic = %q", r.Entry.Phonetic)
	}
	if r.Entry.Translation != "v. 攀登, 爬" {
		t.Errorf("translation = %q (commas inside quoted fields must survive)", r.Entry.Translation)
	}
	if r.Entry.Collins != 3 || r.Entry.BNC != 3000 || r.Entry.Tag != "cet4" {
		t.Errorf("metadata not imported: %+v", r.Entry)
	}
}

// Inflected forms listed in a headword's `exchange` field must resolve back to
// it, otherwise half of real reading lookups miss.
func TestLookupLemmaFromExchange(t *testing.T) {
	d := newTestDict(t)
	cases := map[string]string{
		"climbed":   "climb", // p:/d:
		"climbs":    "climb", // 3:
		"climbing":  "climb", // i:
		"children":  "child", // s:
		"perceived": "perceive",
		"gave":      "give", // p: on give
		"ran":       "run",  // p: on run
	}
	for q, want := range cases {
		r, err := d.Lookup(q)
		if err != nil {
			t.Fatalf("Lookup(%q): %v", q, err)
		}
		if !r.Found || r.Entry.Word != want {
			t.Errorf("Lookup(%q) = %+v, want %q", q, r, want)
		}
		if !r.Lemmatized {
			t.Errorf("Lookup(%q) should be flagged as lemmatized", q)
		}
		if r.Matched != want {
			t.Errorf("Lookup(%q).Matched = %q, want %q", q, r.Matched, want)
		}
	}
}

// Words absent from the `exchange` map still need to resolve ("blorped" is not
// listed anywhere; only the rule-based stripper can find "blorp").
func TestLookupRuleBasedFallback(t *testing.T) {
	d := newTestDict(t)
	for _, q := range []string{"blorped", "blorping", "blorps"} {
		r, err := d.Lookup(q)
		if err != nil {
			t.Fatalf("Lookup(%q): %v", q, err)
		}
		if !r.Found || r.Entry.Word != "blorp" {
			t.Errorf("Lookup(%q) = %+v, want blorp", q, r)
		}
	}
}

func TestLookupPhrase(t *testing.T) {
	d := newTestDict(t)
	r, err := d.Lookup("Give  Up")
	if err != nil {
		t.Fatal(err)
	}
	if !r.Found || r.Entry.Word != "give up" {
		t.Fatalf("Lookup(Give  Up) = %+v, want phrase hit", r)
	}
}

// ECDICT ships headwords that begin with punctuation ("'hood"). Such a word
// must still be found even though Normalize strips the leading apostrophe for
// ordinary selections.
func TestLookupPunctuatedHeadword(t *testing.T) {
	d := newTestDict(t)
	r, err := d.Lookup("'hood")
	if err != nil {
		t.Fatal(err)
	}
	if !r.Found || r.Entry.Word != "'hood" {
		t.Fatalf("Lookup('hood) = %+v, want a hit on 'hood", r)
	}
	if r.Query != "hood" {
		t.Errorf("Query = %q, want the normalized display form", r.Query)
	}
}

// ECDICT ships every inflection as its own entry, and those entries usually
// define nothing but "past tense of X". The base form must therefore be
// reachable alongside the inflected entry, not instead of it.
func TestLookupExposesBaseForm(t *testing.T) {
	d := newTestDict(t)
	r, err := d.Lookup("blimped")
	if err != nil {
		t.Fatal(err)
	}
	if !r.Found || r.Entry.Word != "blimped" {
		t.Fatalf("Lookup(blimped) = %+v, want the inflected entry itself", r)
	}
	if r.Base == nil || r.Base.Word != "blimp" {
		t.Fatalf("Base = %+v, want blimp", r.Base)
	}
	if r.Base.Translation != "n. 小型飞艇" {
		t.Errorf("Base translation = %q", r.Base.Translation)
	}

	plain, err := d.Lookup("climb")
	if err != nil {
		t.Fatal(err)
	}
	if plain.Base != nil {
		t.Errorf("a non-inflected headword should have no Base, got %+v", plain.Base)
	}
}

func TestLookupNotFound(t *testing.T) {
	d := newTestDict(t)
	r, err := d.Lookup("zzzznotaword")
	if err != nil {
		t.Fatal(err)
	}
	if r.Found {
		t.Fatalf("expected miss, got %+v", r)
	}
	if r.Query != "zzzznotaword" {
		t.Errorf("Query should echo the normalized input, got %q", r.Query)
	}
}

func TestLookupEmptyInput(t *testing.T) {
	d := newTestDict(t)
	r, err := d.Lookup("   ")
	if err != nil {
		t.Fatal(err)
	}
	if r.Found || r.Query != "" {
		t.Fatalf("empty input should miss cleanly, got %+v", r)
	}
}

// Re-importing must replace the dictionary rather than double the rows.
func TestImportIsRepeatable(t *testing.T) {
	dir := t.TempDir()
	csvPath := filepath.Join(dir, "ecdict.csv")
	dbPath := filepath.Join(dir, "dict.db")
	if err := os.WriteFile(csvPath, []byte(fixtureCSV), 0o644); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		if err := ImportCSV(csvPath, dbPath, nil); err != nil {
			t.Fatalf("import #%d: %v", i+1, err)
		}
	}
	d, err := Open(dbPath)
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()
	n, err := d.Count()
	if err != nil {
		t.Fatal(err)
	}
	if n != 10 {
		t.Errorf("Count() = %d after two imports, want 10", n)
	}
}

// The importer must tolerate a CSV whose columns are reordered, because users
// may hand it a trimmed or re-exported file.
func TestImportToleratesColumnOrder(t *testing.T) {
	dir := t.TempDir()
	csvPath := filepath.Join(dir, "reordered.csv")
	dbPath := filepath.Join(dir, "dict.db")
	body := `translation,word,phonetic
"v. 攀登",climb,klaim
`
	if err := os.WriteFile(csvPath, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := ImportCSV(csvPath, dbPath, nil); err != nil {
		t.Fatalf("ImportCSV: %v", err)
	}
	d, err := Open(dbPath)
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()
	r, err := d.Lookup("climb")
	if err != nil {
		t.Fatal(err)
	}
	if !r.Found || r.Entry.Translation != "v. 攀登" {
		t.Fatalf("column mapping failed: %+v", r)
	}
}

func TestImportMissingFile(t *testing.T) {
	dir := t.TempDir()
	err := ImportCSV(filepath.Join(dir, "nope.csv"), filepath.Join(dir, "dict.db"), nil)
	if err == nil {
		t.Fatal("expected an error for a missing csv")
	}
}

// ECDICT stores multi-line definitions as a literal backslash-n inside the csv
// cell, not as a real newline. Left as-is the UI would print "\n" verbatim.
func TestImportUnescapesLiteralLineBreaks(t *testing.T) {
	dir := t.TempDir()
	csvPath := filepath.Join(dir, "escaped.csv")
	dbPath := filepath.Join(dir, "dict.db")
	body := `word,definition,translation
climb,"to go up\nmoving upward","v. 攀登\nn. 爬升"
`
	if err := os.WriteFile(csvPath, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := ImportCSV(csvPath, dbPath, nil); err != nil {
		t.Fatalf("ImportCSV: %v", err)
	}
	d, err := Open(dbPath)
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()
	r, err := d.Lookup("climb")
	if err != nil {
		t.Fatal(err)
	}
	if !r.Found {
		t.Fatal("climb not found")
	}
	if want := "to go up\nmoving upward"; r.Entry.Definition != want {
		t.Errorf("definition = %q, want %q", r.Entry.Definition, want)
	}
	if want := "v. 攀登\nn. 爬升"; r.Entry.Translation != want {
		t.Errorf("translation = %q, want %q", r.Entry.Translation, want)
	}
}

// Smoke test against a real ECDICT export; skipped unless pointed at one with
// EPUBMAKER_DICT_CSV=/path/to/ecdict.csv.
func TestImportRealECDICT(t *testing.T) {
	csvPath := os.Getenv("EPUBMAKER_DICT_CSV")
	if csvPath == "" {
		t.Skip("set EPUBMAKER_DICT_CSV to run against a real ECDICT export")
	}
	dbPath := filepath.Join(t.TempDir(), "dict.db")
	if err := ImportCSV(csvPath, dbPath, nil); err != nil {
		t.Fatalf("ImportCSV(%s): %v", csvPath, err)
	}
	d, err := Open(dbPath)
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()
	n, err := d.Count()
	if err != nil {
		t.Fatal(err)
	}
	if n < 10 {
		t.Fatalf("only %d entries imported", n)
	}

	// Any headword the file actually contains must round-trip.
	var sample string
	if err := d.db.QueryRow(`SELECT word FROM entries ORDER BY key LIMIT 1`).Scan(&sample); err != nil {
		t.Fatalf("pick sample: %v", err)
	}
	r, err := d.Lookup(sample)
	if err != nil {
		t.Fatal(err)
	}
	if !r.Found || r.Matched != sample {
		t.Errorf("Lookup(%q) = %+v, want a hit on itself", sample, r)
	}
	if r.Entry.Translation == "" && r.Entry.Definition == "" {
		t.Errorf("entry %q carries no meaning: %+v", sample, r.Entry)
	}

	// Full exports contain "run"; sampling exports may not, so this part is
	// best-effort.
	if run, err := d.Lookup("run"); err == nil && run != nil && run.Found {
		// Every inflection is its own headword in the full export, so the
		// inflected entry wins — but its base form must come along.
		inf, err := d.Lookup("climbed")
		if err != nil {
			t.Fatal(err)
		}
		if !inf.Found {
			t.Fatal("climbed not found")
		}
		if inf.Base == nil || inf.Base.Word != "climb" {
			t.Errorf("Lookup(climbed).Base = %+v, want climb", inf.Base)
		}
	}
	t.Logf("imported %d entries; sample %q -> %q", n, sample, r.Entry.Phonetic)
}
