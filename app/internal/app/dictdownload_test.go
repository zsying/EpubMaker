package app

import (
	"path/filepath"
	"testing"

	"epubmaker-desktop/internal/config"
)

// The phone ships with no dictionary at all. A tap on a word must still open
// the lookup card (saying "no dictionary installed") instead of the backend
// erroring out and the frontend silently swallowing it — that silence is
// exactly why tap-to-lookup looked dead on Android.
func TestLookupWordWithoutDictIsGraceful(t *testing.T) {
	closeDict()
	cfg := config.Get()
	saved := cfg.Paths.DictDB
	cfg.Paths.DictDB = filepath.Join(t.TempDir(), "missing-dict.db")
	t.Cleanup(func() {
		cfg.Paths.DictDB = saved
		closeDict()
	})

	b := &Backend{}
	res, err := b.LookupWord("bk1", "ch1", 0, "harbour", "the harbour was full")
	if err != nil {
		t.Fatalf("LookupWord with no dict must not error: %v", err)
	}
	if res.Found || res.Query != "harbour" {
		t.Fatalf("res = %+v, want found=false query=harbour", res)
	}

	dl, err := b.DictLookup("harbour")
	if err != nil {
		t.Fatalf("DictLookup with no dict must not error: %v", err)
	}
	if dl.Found {
		t.Fatalf("DictLookup found=%v, want false", dl.Found)
	}
}

// The online-download catalog must offer at least one real source: an id to
// pass to DownloadDict and an http(s) URL the phone can fetch directly.
func TestDictSourcesCatalog(t *testing.T) {
	b := &Backend{}
	sources := b.DictSources()
	if len(sources) == 0 {
		t.Fatal("DictSources returned no sources")
	}
	seen := map[string]bool{}
	for _, s := range sources {
		if s.ID == "" || s.Name == "" {
			t.Fatalf("source missing id/name: %+v", s)
		}
		if len(s.URL) < 8 || (s.URL[:4] != "http") {
			t.Fatalf("source %s has a non-http url: %q", s.ID, s.URL)
		}
		if seen[s.ID] {
			t.Fatalf("duplicate source id %s", s.ID)
		}
		seen[s.ID] = true
	}
	if !seen["ecdict-mini"] {
		t.Fatalf("catalog lacks the default ecdict-mini source: %+v", sources)
	}
}

// DownloadDict must reject unknown ids before touching the network.
func TestDownloadDictRejectsUnknownID(t *testing.T) {
	b := &Backend{}
	if _, err := b.DownloadDict("no-such-source"); err == nil {
		t.Fatal("DownloadDict with an unknown id must fail")
	}
}
