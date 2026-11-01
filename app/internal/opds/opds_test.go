package opds

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// navFeed mirrors the shape of Project Gutenberg's /ebooks.opds/ root: three
// navigation entries, no acquisition links, thumbnails served as inline data
// URIs, and every href relative to the host root.
const navFeed = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opds="http://opds-spec.org/2010/catalog" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">
<id>http://www.gutenberg.org/ebooks.opds/</id>
<updated>2026-10-30T02:00:17Z</updated>
<title>Project Gutenberg</title>
<link rel="self" title="This Page" type="application/atom+xml;profile=opds-catalog" href="/ebooks.opds/"/>
<opensearch:itemsPerPage>25</opensearch:itemsPerPage>
<entry>
<updated>2026-10-30T02:00:17Z</updated>
<id>https://www.gutenberg.org/ebooks/search.opds/?sort_order=downloads</id>
<title>Popular</title>
<content type="text">Our most popular books.</content>
<link type="application/atom+xml;profile=opds-catalog" rel="subsection" href="/ebooks/search.opds/?sort_order=downloads"/>
<link type="image/png" rel="http://opds-spec.org/image/thumbnail" href="data:image/png;base64,iVBORw0KGgo="/>
</entry>
<entry>
<updated>2026-10-30T02:00:17Z</updated>
<id>https://www.gutenberg.org/ebooks/search.opds/?sort_order=release_date</id>
<title>Latest</title>
<content type="text">Our latest releases.</content>
<link type="application/atom+xml;profile=opds-catalog" rel="subsection" href="/ebooks/search.opds/?sort_order=release_date"/>
</entry>
</feed>`

// detailFeed is a trimmed Gutenberg work page. Two <entry> elements describe the
// same book (with and without images); each carries several acquisition links of
// which only the EPUB ones are usable here. The `related` links must not be
// mistaken for navigation.
const detailFeed = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opds="http://opds-spec.org/2010/catalog" xmlns:dcterms="http://purl.org/dc/terms/">
<id>http://www.gutenberg.org/ebooks/164.opds</id>
<title>Twenty Thousand Leagues under the Sea by Jules Verne</title>
<entry>
<id>urn:gutenberg:164:2</id>
<title>Twenty Thousand Leagues under the Sea</title>
<content type="xhtml">
<div xmlns="http://www.w3.org/1999/xhtml">
<p>This edition had all images removed.</p>
<p>Summary: A submarine voyage.</p>
</div>
</content>
<author>
<name>Verne, Jules</name>
</author>
<dcterms:language>en</dcterms:language>
<link type="application/epub+zip" rel="http://opds-spec.org/acquisition" title="EPUB (older e-readers, no images)" length="370585" href="https://www.gutenberg.org/ebooks/164.epub.noimages"/>
<link type="application/x-mobipocket-ebook" rel="http://opds-spec.org/acquisition" title="Kindle (no images)" length="563526" href="https://www.gutenberg.org/ebooks/164.kindle.noimages"/>
<link type="image/jpeg" rel="http://opds-spec.org/image/thumbnail" href="https://www.gutenberg.org/cache/epub/164/pg164.cover.small.jpg"/>
<link type="application/atom+xml;profile=opds-catalog" rel="related" href="/ebooks/author/60.opds" title="By Verne, Jules…"/>
</entry>
<entry>
<id>urn:gutenberg:164:3</id>
<title>Twenty Thousand Leagues under the Sea</title>
<content type="xhtml">
<div xmlns="http://www.w3.org/1999/xhtml">
<p>This edition has images.</p>
</div>
</content>
<author>
<name>Verne, Jules</name>
</author>
<dcterms:language>en</dcterms:language>
<link type="application/epub+zip" rel="http://opds-spec.org/acquisition" title="EPUB3 (E-readers incl. Send-to-Kindle)" length="3226308" href="https://www.gutenberg.org/ebooks/164.epub3.images"/>
<link type="application/epub+zip" rel="http://opds-spec.org/acquisition" title="EPUB (older e-readers)" length="3225359" href="https://www.gutenberg.org/ebooks/164.epub.images"/>
<link type="application/x-mobipocket-ebook" rel="http://opds-spec.org/acquisition" title="Kindles (kf8)" length="3478363" href="https://www.gutenberg.org/ebooks/164.kf8.images"/>
<link type="image/jpeg" rel="http://opds-spec.org/image/thumbnail" href="https://www.gutenberg.org/cache/epub/164/pg164.cover.small.jpg"/>
<link type="application/atom+xml;profile=opds-catalog" rel="related" href="/ebooks/bookshelf/68.opds" title="In Science Fiction…"/>
</entry>
</feed>`

// relativeFeed exercises href resolution against a catalog that lives in a
// subdirectory and links to siblings with "..".
const relativeFeed = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
<id>/dav/opds/</id>
<title>Calibre-Web</title>
<link rel="self" href="/dav/opds/"/>
<link rel="next" href="/dav/opds/?page=2"/>
<entry>
<id>urn:uuid:1</id>
<title>San Ti</title>
<author><name>Liu Cixin</name></author>
<link rel="http://opds-spec.org/acquisition/open-access" type="application/epub+zip" length="1048576" href="../books/san%20ti.epub"/>
<link rel="http://opds-spec.org/image" type="image/jpeg" href="../covers/1.jpg"/>
</entry>
</feed>`

func TestParseNavigationFeed(t *testing.T) {
	feed, err := ParseFeed(navFeed, "https://www.gutenberg.org/ebooks.opds/")
	if err != nil {
		t.Fatalf("ParseFeed: %v", err)
	}
	if feed.Title != "Project Gutenberg" {
		t.Errorf("feed title = %q", feed.Title)
	}
	if feed.Self != "https://www.gutenberg.org/ebooks.opds/" {
		t.Errorf("self = %q", feed.Self)
	}
	if len(feed.Entries) != 2 {
		t.Fatalf("entries = %d, want 2", len(feed.Entries))
	}

	first := feed.Entries[0]
	if first.Title != "Popular" {
		t.Errorf("entry title = %q", first.Title)
	}
	// A navigation entry must carry an absolute target and no downloads.
	wantNav := "https://www.gutenberg.org/ebooks/search.opds/?sort_order=downloads"
	if first.NavHref != wantNav {
		t.Errorf("navHref = %q, want %q", first.NavHref, wantNav)
	}
	if len(first.Downloads) != 0 {
		t.Errorf("navigation entry should have no downloads, got %d", len(first.Downloads))
	}
	// data: URIs must survive untouched — they are not relative paths.
	if !strings.HasPrefix(first.Thumbnail, "data:image/png;base64,") {
		t.Errorf("thumbnail = %q, want a data URI", first.Thumbnail)
	}
}

// Some real catalogs (Ebooks libres et gratuits among them) publish a
// navigation entry whose link carries a type but no rel at all. Ignoring it
// leaves the row unclickable, which reads as a dead catalog.
const relLessNav = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
<title>Catalogue</title>
<entry>
  <title>Dernières parutions</title>
  <link type="application/atom+xml" href="feed.php"/>
  <id>https://example.com/opds/feed.php</id>
</entry>
</feed>`

// The UI calls entry.downloads.find(...) on every row to show the file size.
// A navigation entry that serialises downloads as null takes the whole page
// down with "Cannot read properties of null" — which is exactly what happened
// on the phone the first time a search feed was opened.
func TestDownloadsMarshalAsEmptyArray(t *testing.T) {
	feed, err := ParseFeed(navFeed, "https://www.gutenberg.org/ebooks.opds/")
	if err != nil {
		t.Fatalf("ParseFeed: %v", err)
	}
	b, err := json.Marshal(feed.Entries[0])
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	if !strings.Contains(string(b), `"downloads":[]`) {
		t.Errorf("navigation entry JSON should carry an empty downloads array, got %s", b)
	}
}

// Same null-vs-empty problem one level up: a search with no hits has to reach
// the UI as an empty list, not null, or the "这里没有内容" branch never runs.
const emptyFeed = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom"><title>Nothing found</title></feed>`

func TestEmptyFeedMarshalsEmptyEntries(t *testing.T) {
	feed, err := ParseFeed(emptyFeed, "https://example.com/opds/")
	if err != nil {
		t.Fatalf("ParseFeed: %v", err)
	}
	b, err := json.Marshal(feed)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	if !strings.Contains(string(b), `"entries":[]`) {
		t.Errorf("empty feed should marshal entries as [], got %s", b)
	}
}

func TestParseNavigationWithoutRel(t *testing.T) {
	feed, err := ParseFeed(relLessNav, "https://example.com/opds/")
	if err != nil {
		t.Fatalf("ParseFeed: %v", err)
	}
	if len(feed.Entries) != 1 {
		t.Fatalf("entries = %d, want 1", len(feed.Entries))
	}
	want := "https://example.com/opds/feed.php"
	if got := feed.Entries[0].NavHref; got != want {
		t.Errorf("navHref = %q, want %q", got, want)
	}
}

func TestParsePublicationFeedMergesVariants(t *testing.T) {
	feed, err := ParseFeed(detailFeed, "https://www.gutenberg.org/ebooks/164.opds")
	if err != nil {
		t.Fatalf("ParseFeed: %v", err)
	}
	// The two entries are the same book: they collapse into one row whose
	// download list is the union of both.
	if len(feed.Entries) != 1 {
		t.Fatalf("entries = %d, want 1 after merging variants", len(feed.Entries))
	}
	e := feed.Entries[0]
	if e.Author != "Verne, Jules" {
		t.Errorf("author = %q", e.Author)
	}
	if e.Language != "en" {
		t.Errorf("language = %q", e.Language)
	}
	// 2 epub + 1 mobi from the image-less edition, 2 epub + 1 mobi from the
	// illustrated one.
	if len(e.Downloads) != 5 {
		t.Errorf("downloads = %d, want 5 (3 epub + 2 mobi)", len(e.Downloads))
	}
	// `related` links point at other catalogs, not at this book's files.
	if e.NavHref != "" {
		t.Errorf("publication should not expose navHref, got %q", e.NavHref)
	}
	// The blurb lives inside <content><div><p>, not in a direct text node of
	// <content>; the merge keeps whichever variant said more.
	if !strings.Contains(e.Summary, "Summary: A submarine voyage") {
		t.Errorf("summary lost the deep xhtml text: %q", e.Summary)
	}
}

func TestPickEpubPrefersIllustrated(t *testing.T) {
	feed, err := ParseFeed(detailFeed, "https://www.gutenberg.org/ebooks/164.opds")
	if err != nil {
		t.Fatalf("ParseFeed: %v", err)
	}
	got := PickEpub(feed.Entries[0].Downloads)
	if got == nil {
		t.Fatal("PickEpub returned nil")
	}
	if want := "164.epub3.images"; !strings.Contains(got.Href, want) {
		t.Errorf("picked %q, want the illustrated EPUB3 (%s)", got.Href, want)
	}
}

func TestPickEpubRules(t *testing.T) {
	epub := func(title, href string, length int64) Link {
		return Link{Rel: "http://opds-spec.org/acquisition", Type: "application/epub+zip", Title: title, Href: href, Length: length}
	}
	mobi := Link{Rel: "http://opds-spec.org/acquisition", Type: "application/x-mobipocket-ebook", Href: "https://x/b.mobi"}

	cases := []struct {
		name  string
		links []Link
		want  string
	}{
		{"only mobi yields nothing", []Link{mobi}, ""},
		{"a lone epub wins", []Link{mobi, epub("EPUB", "https://x/a.epub", 10)}, "https://x/a.epub"},
		{
			name:  "no-images variant is skipped even when listed first",
			links: []Link{epub("EPUB (no images)", "https://x/plain.epub", 999), epub("EPUB3", "https://x/rich.epub", 10)},
			want:  "https://x/rich.epub",
		},
		{
			name:  "largest wins when titles say nothing",
			links: []Link{epub("EPUB", "https://x/small.epub", 10), epub("EPUB", "https://x/big.epub", 20)},
			want:  "https://x/big.epub",
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := PickEpub(c.links)
			if c.want == "" {
				if got != nil {
					t.Fatalf("PickEpub = %q, want nil", got.Href)
				}
				return
			}
			if got == nil || got.Href != c.want {
				t.Fatalf("PickEpub = %v, want %q", got, c.want)
			}
		})
	}
}

func TestParseResolvesRelativeHrefs(t *testing.T) {
	feed, err := ParseFeed(relativeFeed, "https://dav.example.com/dav/opds/")
	if err != nil {
		t.Fatalf("ParseFeed: %v", err)
	}
	if feed.Next != "https://dav.example.com/dav/opds/?page=2" {
		t.Errorf("next = %q", feed.Next)
	}
	e := feed.Entries[0]
	if len(e.Downloads) != 1 {
		t.Fatalf("downloads = %d, want 1", len(e.Downloads))
	}
	if want := "https://dav.example.com/dav/books/san%20ti.epub"; e.Downloads[0].Href != want {
		t.Errorf("href = %q, want %q", e.Downloads[0].Href, want)
	}
	if want := "https://dav.example.com/dav/covers/1.jpg"; e.Thumbnail != want {
		t.Errorf("thumbnail = %q, want %q", e.Thumbnail, want)
	}
}

func TestParseRejectsNonOPDS(t *testing.T) {
	_, err := ParseFeed(`<html><body><h1>Not a catalog</h1></body></html>`, "https://example.com/")
	if err == nil {
		t.Fatal("expected an error for an HTML page")
	}
	if !strings.Contains(err.Error(), "OPDS") {
		t.Errorf("error should name OPDS so the user knows what went wrong: %v", err)
	}
}

func TestParseTruncatesSummary(t *testing.T) {
	long := strings.Repeat("word ", 400) // 2000 chars of xhtml text
	raw := `<feed xmlns="http://www.w3.org/2005/Atom"><title>t</title><entry>
<id>1</id><title>Long</title>
<content type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml"><p>` + long + `</p></div></content>
<link rel="http://opds-spec.org/acquisition" type="application/epub+zip" href="https://x/a.epub"/>
</entry></feed>`
	feed, err := ParseFeed(raw, "https://x/")
	if err != nil {
		t.Fatalf("ParseFeed: %v", err)
	}
	if n := len([]rune(feed.Entries[0].Summary)); n > 320 {
		t.Errorf("summary is %d runes, want it truncated near 300", n)
	}
}

func TestSourceBrowseURL(t *testing.T) {
	gutenberg := Source{
		URL:       "https://www.gutenberg.org/ebooks.opds/",
		SearchURL: "https://www.gutenberg.org/ebooks/search.opds/?query={search}",
	}
	if got := gutenberg.BrowseURL(""); got != gutenberg.URL {
		t.Errorf("empty query = %q, want the entry point", got)
	}
	// PathEscape (not QueryEscape) so the same template can be used in a path
	// segment, as Calibre-Web's /opds/search/{search} does.
	if got, want := gutenberg.BrowseURL("san ti"), "https://www.gutenberg.org/ebooks/search.opds/?query=san%20ti"; got != want {
		t.Errorf("query = %q, want %q", got, want)
	}
	if got, want := gutenberg.BrowseURL("三体"), "https://www.gutenberg.org/ebooks/search.opds/?query=%E4%B8%89%E4%BD%93"; got != want {
		t.Errorf("cjk query = %q, want %q", got, want)
	}

	noSearch := Source{URL: "https://x/opds/"}
	if got := noSearch.BrowseURL("dune"); got != "" {
		t.Errorf("without a template a query must yield %q, got %q", "", got)
	}
}

func TestParseSourceValidatesURL(t *testing.T) {
	if _, err := ParseSource(map[string]any{"url": ""}); err == nil {
		t.Error("empty url should be rejected")
	}
	if _, err := ParseSource(map[string]any{"url": "ftp://x/opds"}); err == nil {
		t.Error("non-http scheme should be rejected")
	}
	s, err := ParseSource(map[string]any{"url": "https://x/opds/", "username": "u", "password": "p", "insecure": true})
	if err != nil {
		t.Fatalf("ParseSource: %v", err)
	}
	if s.Username != "u" || s.Password != "p" || !s.Insecure {
		t.Errorf("credentials lost: %+v", s)
	}
}

// A phone connection that dies mid-body must be resumed, not restarted: the
// first import of 西遊記 on the device failed with "unexpected EOF" and the
// second tap happened to succeed, but 紅樓夢 failed twice in a row. Resuming
// from the byte already on disk is what makes that recoverable.
const truncPayload = "PK\x03\x04 the whole book body"

func TestDownloadResumesTruncatedBody(t *testing.T) {
	var hits int
	var rangeHeader string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		if hits == 1 {
			conn, buf, err := w.(http.Hijacker).Hijack()
			if err != nil {
				t.Errorf("hijack: %v", err)
				return
			}
			defer conn.Close()
			buf.WriteString("HTTP/1.1 200 OK\r\nContent-Type: application/epub+zip\r\nContent-Length: 999\r\n\r\n")
			buf.WriteString(truncPayload[:10])
			_ = buf.Flush()
			return
		}
		rangeHeader = r.Header.Get("Range")
		if rangeHeader != "bytes=10-" {
			t.Errorf("resume should ask for the remaining bytes, got Range %q", rangeHeader)
		}
		w.Header().Set("Content-Type", "application/epub+zip")
		w.WriteHeader(http.StatusPartialContent)
		_, _ = w.Write([]byte(truncPayload[10:]))
	}))
	defer srv.Close()

	dest := filepath.Join(t.TempDir(), "book.epub")
	if err := Download(context.Background(), Source{}, srv.URL+"/book.epub", dest); err != nil {
		t.Fatalf("Download should resume a truncated transfer: %v", err)
	}
	if hits != 2 {
		t.Errorf("server hits = %d, want 2 (one attempt, one resume)", hits)
	}
	b, err := os.ReadFile(dest)
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	if string(b) != truncPayload {
		t.Errorf("saved file = %q, want %q with no duplicated prefix", b, truncPayload)
	}
}

// A server that ignores Range answers the resumed request with the full body.
// Appending it to the partial file would corrupt the EPUB, so the file has to
// be rewritten from zero instead.
func TestDownloadRestartsWhenServerIgnoresRange(t *testing.T) {
	var hits int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		if hits == 1 {
			conn, buf, err := w.(http.Hijacker).Hijack()
			if err != nil {
				t.Errorf("hijack: %v", err)
				return
			}
			defer conn.Close()
			buf.WriteString("HTTP/1.1 200 OK\r\nContent-Type: application/epub+zip\r\nContent-Length: 999\r\n\r\n")
			buf.WriteString(truncPayload[:10])
			_ = buf.Flush()
			return
		}
		// Deliberately no 206 and no Content-Range.
		w.Header().Set("Content-Type", "application/epub+zip")
		_, _ = w.Write([]byte(truncPayload))
	}))
	defer srv.Close()

	dest := filepath.Join(t.TempDir(), "book.epub")
	if err := Download(context.Background(), Source{}, srv.URL+"/book.epub", dest); err != nil {
		t.Fatalf("Download: %v", err)
	}
	b, err := os.ReadFile(dest)
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	if string(b) != truncPayload {
		t.Errorf("saved file = %q, want %q", b, truncPayload)
	}
}

// A server that answers 404 must not be asked twice.
func TestDownloadDoesNotRetryStatusErrors(t *testing.T) {
	var hits int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		http.Error(w, "nope", http.StatusNotFound)
	}))
	defer srv.Close()

	dest := filepath.Join(t.TempDir(), "book.epub")
	if err := Download(context.Background(), Source{}, srv.URL+"/missing.epub", dest); err == nil {
		t.Fatal("expected an error for 404")
	}
	if hits != 1 {
		t.Errorf("server hits = %d, want 1 (404 is not retryable)", hits)
	}
}
