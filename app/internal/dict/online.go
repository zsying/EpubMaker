package dict

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// The local ECDICT dictionary is 153k–770k entries depending on the build, and
// the Android one is the trimmed end of that range. What it cannot answer is
// mostly two things: proper nouns and coinages, and inflected forms whose own
// row carries no gloss (those are handled locally — see baseGloss in the app
// package). For the rest there is no offline source, so the notebook can ask a
// public dictionary.
//
// Two sources, because they answer different questions:
//
//   - Youdao's jsonapi returns a Chinese gloss with a phonetic, which is what
//     the notebook is written in. It is not an official API — no key, no terms,
//     and it can change or start refusing requests without notice.
//   - dictionaryapi.dev is an official free API and returns English
//     definitions. It is the fallback, not the preference: an English
//     explanation is still better than an empty row.
//
// Both are read-only lookups of a single word, made only when the reader asks
// for them, and the result is stored locally so the same word is never
// requested twice.

// Online is a gloss fetched from a public dictionary.
type Online struct {
	Word        string `json:"word"`
	Phonetic    string `json:"phonetic"`
	Translation string `json:"translation"`
	Definition  string `json:"definition"`
	Source      string `json:"source"`
}

// Sources, stored alongside the entry so the UI can say where a gloss came
// from and so a later run can prefer the better source.
const (
	SourceYoudao = "youdao"
	SourceFree   = "freedictionary"
)

// browserUA is not politeness theatre: Youdao answers a bare Go client with an
// empty JSON body.
const browserUA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
	"(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"

// fetchTimeout bounds one source. The whole call is bounded by the caller's
// context, because two sources are tried in sequence.
const fetchTimeout = 6 * time.Second

// errNotFound says "the source answered, and it has no such word". It is
// distinct from a network failure: one means stop asking this source, the other
// means try again later.
var errNotFound = errors.New("word not found")

// Endpoints are variables so the tests can point them at a local server.
var (
	youdaoEndpoint = "https://dict.youdao.com/jsonapi?q="
	freeEndpoint   = "https://api.dictionaryapi.dev/api/v2/entries/en/"
)

// FetchOnline resolves a word against the public dictionaries, Chinese gloss
// first. A nil result with a nil error means "nothing anywhere knew this word" —
// callers treat that as a plain miss, not a failure.
func FetchOnline(ctx context.Context, word string) (*Online, error) {
	word = Normalize(word)
	if word == "" || len(word) > 64 {
		return nil, nil
	}

	// Sequential, not parallel: the Chinese gloss is what the notebook wants,
	// and a parallel call would double the traffic for a result that is usually
	// thrown away.
	if e, err := fetchYoudao(ctx, word); err == nil && e != nil {
		return e, nil
	} else if ctx.Err() != nil {
		return nil, ctx.Err()
	}

	if e, err := fetchFreeDictionary(ctx, word); err == nil && e != nil {
		return e, nil
	} else if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	return nil, nil
}

/* -------------------------------- youdao -------------------------------- */

// youdaoResp is the slice of Youdao's jsonapi this app reads. The payload is
// ~28 KB of unrelated material (examples, synonyms, web translations); only
// `ec.word[].trs[].tr[].l.i` carries the Chinese gloss and only
// `usphone`/`ukphone` the phonetic.
type youdaoResp struct {
	EC *struct {
		Word []struct {
			USPhone string `json:"usphone"`
			UKPhone string `json:"ukphone"`
			TRS     []struct {
				TR []struct {
					L struct {
						I json.RawMessage `json:"i"`
					} `json:"l"`
				} `json:"tr"`
			} `json:"trs"`
		} `json:"word"`
	} `json:"ec"`
}

func fetchYoudao(ctx context.Context, word string) (*Online, error) {
	raw, err := getJSON(ctx, youdaoEndpoint+url.QueryEscape(word), 1<<20)
	if err != nil {
		return nil, err
	}
	var r youdaoResp
	if err := json.Unmarshal(raw, &r); err != nil {
		return nil, err
	}
	if r.EC == nil || len(r.EC.Word) == 0 {
		return nil, errNotFound
	}

	// One headword can arrive as several `word` blocks (different senses); the
	// glosses are concatenated the way ECDICT packs them, one per line.
	var lines []string
	for _, w := range r.EC.Word {
		for _, trs := range w.TRS {
			for _, tr := range trs.TR {
				// `i` is a string in most responses and an array in others.
				for _, s := range jsonStrings(tr.L.I) {
					if s = strings.TrimSpace(s); s != "" {
						lines = append(lines, s)
					}
				}
			}
		}
	}
	if len(lines) == 0 {
		// The word exists on Youdao but only as a web translation of a phrase;
		// nothing worth storing in the notebook.
		return nil, errNotFound
	}

	e := &Online{Word: word, Translation: strings.Join(dedupe(lines), "\n"), Source: SourceYoudao}
	if p := r.EC.Word[0].USPhone; p != "" {
		e.Phonetic = p
	} else {
		e.Phonetic = r.EC.Word[0].UKPhone
	}
	return e, nil
}

// jsonStrings reads a JSON value that may be a string or an array of strings.
// Youdao does both for the same field depending on the word.
func jsonStrings(raw json.RawMessage) []string {
	if len(raw) == 0 {
		return nil
	}
	var one string
	if err := json.Unmarshal(raw, &one); err == nil {
		return []string{one}
	}
	var many []string
	if err := json.Unmarshal(raw, &many); err == nil {
		return many
	}
	return nil
}

func dedupe(in []string) []string {
	seen := make(map[string]bool, len(in))
	out := in[:0]
	for _, s := range in {
		if seen[s] {
			continue
		}
		seen[s] = true
		out = append(out, s)
	}
	return out
}

/* ---------------------------- free dictionary ---------------------------- */

type freeEntry struct {
	Word      string `json:"word"`
	Phonetic  string `json:"phonetic"`
	Phonetics []struct {
		Text string `json:"text"`
	} `json:"phonetics"`
	Meanings []struct {
		PartOfSpeech string `json:"partOfSpeech"`
		Definitions  []struct {
			Definition string `json:"definition"`
		} `json:"definitions"`
	} `json:"meanings"`
}

func fetchFreeDictionary(ctx context.Context, word string) (*Online, error) {
	raw, err := getJSON(ctx, freeEndpoint+url.PathEscape(word), 1<<20)
	if err != nil {
		return nil, err
	}
	var entries []freeEntry
	if err := json.Unmarshal(raw, &entries); err != nil {
		return nil, err
	}
	if len(entries) == 0 {
		return nil, errNotFound
	}

	var lines []string
	for _, en := range entries {
		for _, m := range en.Meanings {
			pos := strings.TrimSpace(m.PartOfSpeech)
			for i, def := range m.Definitions {
				if i >= 2 { // two senses per part of speech is plenty for a list row
					break
				}
				d := strings.TrimSpace(def.Definition)
				if d == "" {
					continue
				}
				if pos != "" {
					d = pos + ". " + d
				}
				lines = append(lines, d)
				if len(lines) >= 4 {
					break
				}
			}
			if len(lines) >= 4 {
				break
			}
		}
		if len(lines) >= 4 {
			break
		}
	}
	if len(lines) == 0 {
		return nil, errNotFound
	}

	e := &Online{Word: word, Definition: strings.Join(lines, "\n"), Source: SourceFree}
	for _, en := range entries {
		if en.Phonetic != "" {
			e.Phonetic = en.Phonetic
			break
		}
		for _, p := range en.Phonetics {
			if p.Text != "" {
				e.Phonetic = p.Text
				break
			}
		}
		if e.Phonetic != "" {
			break
		}
	}
	return e, nil
}

/* --------------------------------- http --------------------------------- */

// getJSON performs one GET and returns at most max bytes of the body. Every
// request is bounded on its own as well as by the caller's context: a hung
// public API must never make the notebook hang with it.
func getJSON(ctx context.Context, rawURL string, max int64) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, fetchTimeout)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", browserUA)
	req.Header.Set("Accept", "application/json")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	switch {
	case resp.StatusCode == http.StatusNotFound:
		return nil, errNotFound
	case resp.StatusCode < 200 || resp.StatusCode >= 300:
		return nil, fmt.Errorf("dictionary responded %s", resp.Status)
	}
	return io.ReadAll(io.LimitReader(resp.Body, max))
}
