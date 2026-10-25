package dict

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// The fixtures below are trimmed copies of real responses: the shapes are the
// contract, and both sources are third-party, so a change on their side should
// show up here as a failing test rather than as an empty notebook row.
const youdaoOneSense = `{
  "input": "serendipity",
  "ec": {
    "word": [{
      "usphone": "ˌserənˈdɪpəti",
      "ukphone": "ˌserənˈdɪpəti",
      "trs": [{"tr": [{"l": {"i": ["n. 意外发现美好事物的运气，机缘巧合"]}}]}]
    }]
  }
}`

// Youdao returns `i` as a bare string for some words.
const youdaoScalarGloss = `{
  "ec": {"word": [{"usphone": "blɔːp", "trs": [{"tr": [{"l": {"i": "n. 测试用词"}}]}]}]}
}`

// A phrase Youdao only knows as a machine translation has no `ec` block.
const youdaoWebOnly = `{"input": "blorp around", "web_trans": {"web-translation": []}}`

const freeEntries = `[{
  "word": "blorp",
  "phonetic": "/blɔːp/",
  "meanings": [
    {"partOfSpeech": "noun", "definitions": [{"definition": "A word that does not exist."}]},
    {"partOfSpeech": "verb", "definitions": [{"definition": "To test a dictionary."}]}
  ]
}]`

// stubSources points both endpoints at one test server. The handler decides by
// path prefix, so a test can make Youdao fail while Free Dictionary answers.
func stubSources(t *testing.T, handle func(w http.ResponseWriter, r *http.Request)) {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(handle))
	t.Cleanup(srv.Close)

	oldYoudao, oldFree := youdaoEndpoint, freeEndpoint
	youdaoEndpoint = srv.URL + "/youdao?q="
	freeEndpoint = srv.URL + "/free/"
	t.Cleanup(func() {
		youdaoEndpoint, freeEndpoint = oldYoudao, oldFree
	})
}

func TestFetchOnlinePrefersTheChineseGloss(t *testing.T) {
	stubSources(t, func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/youdao") {
			_, _ = w.Write([]byte(youdaoOneSense))
			return
		}
		_, _ = w.Write([]byte(freeEntries))
	})

	got, err := FetchOnline(context.Background(), "Serendipity")
	if err != nil {
		t.Fatal(err)
	}
	if got == nil {
		t.Fatal("no result for a word Youdao knows")
	}
	if got.Source != SourceYoudao {
		t.Errorf("source = %q, want %q", got.Source, SourceYoudao)
	}
	if got.Word != "serendipity" {
		t.Errorf("word = %q, want the normalized key", got.Word)
	}
	if !strings.Contains(got.Translation, "机缘巧合") {
		t.Errorf("translation = %q, want the Chinese gloss", got.Translation)
	}
	if got.Phonetic != "ˌserənˈdɪpəti" {
		t.Errorf("phonetic = %q", got.Phonetic)
	}
	// The English definition belongs to the fallback source; mixing it in would
	// double up the row.
	if got.Definition != "" {
		t.Errorf("definition = %q, want empty for a Youdao hit", got.Definition)
	}
}

// Youdao's `i` field is a string for some words and an array for others. This
// used to be the difference between a gloss and an empty row.
func TestFetchOnlineReadsAScalarGloss(t *testing.T) {
	stubSources(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(youdaoScalarGloss))
	})

	got, err := FetchOnline(context.Background(), "blorp")
	if err != nil {
		t.Fatal(err)
	}
	if got == nil || got.Translation != "n. 测试用词" {
		t.Fatalf("got %+v, want the scalar gloss", got)
	}
}

// Both sources answer; Youdao has nothing useful. The fallback is what makes
// the feature worth having on a word ECDICT and Youdao both declined.
func TestFetchOnlineFallsBackToTheEnglishSource(t *testing.T) {
	stubSources(t, func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/youdao") {
			_, _ = w.Write([]byte(youdaoWebOnly))
			return
		}
		_, _ = w.Write([]byte(freeEntries))
	})

	got, err := FetchOnline(context.Background(), "blorp")
	if err != nil {
		t.Fatal(err)
	}
	if got == nil || got.Source != SourceFree {
		t.Fatalf("got %+v, want a fallback hit", got)
	}
	if !strings.Contains(got.Definition, "does not exist") {
		t.Errorf("definition = %q", got.Definition)
	}
	if !strings.Contains(got.Definition, "noun.") {
		t.Errorf("definition = %q, want the part of speech attached", got.Definition)
	}
	if got.Translation != "" {
		t.Errorf("translation = %q, want empty for an English-only source", got.Translation)
	}
	if got.Phonetic != "/blɔːp/" {
		t.Errorf("phonetic = %q", got.Phonetic)
	}
}

func TestFetchOnlineFallsBackWhenYoudaoErrors(t *testing.T) {
	stubSources(t, func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/youdao") {
			http.Error(w, "boom", http.StatusInternalServerError)
			return
		}
		_, _ = w.Write([]byte(freeEntries))
	})

	got, err := FetchOnline(context.Background(), "blorp")
	if err != nil {
		t.Fatal(err)
	}
	if got == nil || got.Source != SourceFree {
		t.Fatalf("got %+v, want the fallback to cover a broken primary", got)
	}
}

// "Nobody knows this word" is not an error: the caller stores a tombstone so it
// is not asked again, and an error would make it look like a network problem
// and be retried forever.
func TestFetchOnlineReportsAMissAsNil(t *testing.T) {
	stubSources(t, func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, `{"title":"No Definitions Found"}`, http.StatusNotFound)
	})

	got, err := FetchOnline(context.Background(), "blorpilicious")
	if err != nil {
		t.Fatalf("a miss must not be an error, got %v", err)
	}
	if got != nil {
		t.Fatalf("got %+v, want nil", got)
	}
}

// Junk in the URL bar of a selection — punctuation, an empty string, a whole
// sentence — must not become a request.
func TestFetchOnlineSkipsUnusableInput(t *testing.T) {
	requests := 0
	stubSources(t, func(w http.ResponseWriter, r *http.Request) {
		requests++
		_, _ = w.Write([]byte(freeEntries))
	})

	for _, in := range []string{"", "   ", "—-—", strings.Repeat("a", 80)} {
		got, err := FetchOnline(context.Background(), in)
		if err != nil || got != nil {
			t.Errorf("FetchOnline(%q) = %+v, %v; want nil, nil", in, got, err)
		}
	}
	if requests != 0 {
		t.Errorf("%d requests made for input that should be skipped", requests)
	}
}

// A cancelled context stops the chain instead of falling through to the second
// source: the reader closed the page, there is no point asking anyone else.
func TestFetchOnlineStopsOnCancel(t *testing.T) {
	stubSources(t, func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "context canceled", http.StatusBadGateway)
	})

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := FetchOnline(ctx, "blorp"); err == nil {
		t.Error("want the context error, got a silent miss")
	}
}
