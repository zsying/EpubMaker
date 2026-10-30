package app

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"

	"epubmaker-desktop/internal/library"
	"epubmaker-desktop/internal/opds"
	"epubmaker-desktop/internal/storage"
	"epubmaker-desktop/internal/webdav"
)

// Built-in OPDS catalogs.
//
// The bar for this list is not "well known" but "answers a plain GET from
// inside the app". Every famous catalog was tried before shipping; most are
// behind a Cloudflare interactive challenge (Feedbooks, Gallica, Manybooks,
// Projekt Gutenberg), which a native client cannot solve, and Standard Ebooks
// answers a non-browser with 401 and a page that says "following this link will
// ban your IP". Listing those would only produce a row that always errors.
// Everything self-hosted — Calibre-Web, Komga, Kavita, a NAS — the reader adds
// himself, with the URL shape shown in the form.
//
// The catalog lives in code for the same reason the dictionary sources do
// (dictdownload.go): a new source is one struct entry, with no config migration
// and no settings to keep in sync.
var opdsCatalog = []opds.Source{
	{
		ID:        "gutenberg",
		Name:      "Project Gutenberg",
		Desc:      "七万余本公版书，英文为主；可直接下载 EPUB",
		URL:       "https://www.gutenberg.org/ebooks.opds/",
		SearchURL: "https://www.gutenberg.org/ebooks/search.opds/?query={search}",
	},
	{
		// Same server, a saved query. Gutenberg has no separate Chinese shelf,
		// but its search understands the language filter `l.zh`, and that is
		// what makes this an entry of its own rather than a search the reader
		// has to guess: 西遊記, 紅樓夢 and 三國演義 are all one tap away.
		ID:        "gutenberg-zh",
		Name:      "古登堡·中文书",
		Desc:      "约四百五十本中文公版书，古典小说、史书与诸子",
		URL:       "https://www.gutenberg.org/ebooks/search.opds/?query=l.zh",
		SearchURL: "https://www.gutenberg.org/ebooks/search.opds/?query=l.zh+{search}",
	},
	{
		ID:        "ebooksgratuits",
		Name:      "Ebooks libres et gratuits",
		Desc:      "法文公版书约一千二百本，EPUB / PDF / MOBI 齐全",
		URL:       "https://www.ebooksgratuits.com/opds/",
		SearchURL: "https://www.ebooksgratuits.com/opds/feed.php?mode=search&query={search}",
	},
	{
		// No search endpoint: the catalog's OpenSearch description only
		// publishes an HTML one, so the UI hides the search box for this source
		// instead of sending every query to a URL that 404s.
		ID:   "wolnelektury",
		Name: "Wolne Lektury",
		Desc: "波兰文公版书与学校书单，按作者 / 体裁 / 年代分类",
		URL:  "https://wolnelektury.pl/opds/",
	},
}

// OpdsSources lists the catalogs that are built in and need no configuration.
func (b *Backend) OpdsSources() []opds.Source {
	out := make([]opds.Source, len(opdsCatalog))
	copy(out, opdsCatalog)
	return out
}

// OpdsBrowse fetches one catalog page.
//
// target wins when set: that is how the reader follows next/previous or steps
// into a navigation entry, and following a URL the catalog itself published is
// still an action the reader took. Otherwise query goes through the source's
// search template, and an empty query means the entry point.
func (b *Backend) OpdsBrowse(source map[string]any, query, target string) (*opds.Feed, error) {
	s, err := opds.ParseSource(source)
	if err != nil {
		return nil, err
	}
	u := strings.TrimSpace(target)
	if u == "" {
		u = s.BrowseURL(query)
		if u == "" {
			return nil, fmt.Errorf("这个书源没有配置搜索地址（需要在搜索地址里保留 {search} 占位符）")
		}
	}
	return opds.Fetch(context.Background(), s, u)
}

// OpdsImportItem is one book the reader asked to import.
//
// It carries the acquisition links the entry published, and nothing else. There
// used to be a `nav` field: the backend would follow a navigation entry and grab
// the first EPUB it found. That was a trap — the folders of a catalog ("最受欢迎",
// "按作者") are navigation entries too, and tapping 导入 on one of them quietly
// downloaded whichever book happened to sort first. Which is why this struct has
// no pointer to a catalog page: there is nothing here that can be resolved into
// an arbitrary book.
//
// The frontend passes back what the feed gave it rather than deciding which file
// to fetch: the choice between editions (illustrated vs image-less, EPUB3 vs
// legacy) lives in opds.PickEpub, and duplicating it in TypeScript would let the
// two drift apart.
type OpdsImportItem struct {
	// Downloads are the acquisition links already published on the entry.
	Downloads []opds.Link `json:"downloads"`
	// Name is the display title; it becomes the file name and the fallback
	// title when the EPUB has no dc:title.
	Name string `json:"name"`
}

// OpdsImport downloads the chosen books and imports them.
//
// Same shape as WebdavImport, including the temp-file round trip: the importer
// only accepts a path on disk, and keeping the transfer outside the import
// transaction means a failed download cannot leave a half-built book behind.
func (b *Backend) OpdsImport(source map[string]any, items []OpdsImportItem) (map[string]any, error) {
	s, err := opds.ParseSource(source)
	if err != nil {
		return nil, err
	}
	ctx := context.Background()
	created := []library.BookDTO{}
	failures := []string{}
	duplicates := []string{}
	for _, it := range items {
		href := ""
		if p := opds.PickEpub(it.Downloads); p != nil {
			href = p.Href
		}
		title := it.Name
		if href == "" {
			failures = append(failures, fallbackTitle(title, "")+": 这一项没有可下载的 EPUB，它不是一本书")
			continue
		}

		// The title becomes the book's original file name (and, when the EPUB
		// carries no dc:title, its display title), so it has to survive a
		// filesystem: catalogs routinely ship titles containing "/" and ": ".
		name := storage.SanitizeFileName(title)
		if !strings.HasSuffix(strings.ToLower(name), ".epub") {
			name += ".epub"
		}
		tmp := webdav.TempPath(name)
		if e := opds.Download(ctx, s, href, tmp); e != nil {
			failures = append(failures, name+": "+e.Error())
			continue
		}
		book, e := library.ImportEpub(tmp, name)
		_ = os.Remove(tmp)
		if errors.Is(e, library.ErrDuplicate) {
			// Same rule as ImportPaths: a book already on the shelf is not a
			// failure, and tapping it twice must not read like one.
			duplicates = append(duplicates, fmt.Sprintf("《%s》",
				strings.TrimPrefix(e.Error(), "duplicate:")))
			continue
		}
		if e != nil {
			failures = append(failures, name+": "+e.Error())
			continue
		}
		created = append(created, *book)
	}
	if len(created) == 0 && len(duplicates) == 0 {
		if len(failures) == 0 {
			return nil, fmt.Errorf("没有选中任何书籍")
		}
		return nil, fmt.Errorf("%s", strings.Join(failures, "\n"))
	}
	return map[string]any{"books": created, "errors": failures, "duplicates": duplicates}, nil
}

func fallbackTitle(title, href string) string {
	if strings.TrimSpace(title) != "" {
		return title
	}
	return href
}
