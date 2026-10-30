// Package opds reads OPDS 1.x catalogs (Atom feeds with the opds: profile) and
// downloads the EPUB files they advertise.
//
// Only the read side of OPDS 1.2 is implemented: navigation feeds, acquisition
// links, pagination. OPDS 2.0 (application/opds+json) is not handled — every
// server in practice still publishes 1.x, including Calibre-Web, Komga, Kavita
// and Project Gutenberg.
//
// Nothing here is scheduled or background: a feed is fetched only when the
// reader asks for it, every request is bounded by a timeout and a byte cap, and
// nothing is cached between calls. That keeps the package inside the project
// rule that network access must be explicit, bounded and never block the UI.
package opds

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"io"
	"net/http"
	neturl "net/url"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"epubmaker-desktop/internal/epub"
)

// OPDS / Atom relation types. The acquisition family is prefix-matched because
// OPDS 1.2 splits it into /open-access, /borrow, /buy and /sample.
const (
	relAcquisition = "http://opds-spec.org/acquisition"
	relThumbnail   = "http://opds-spec.org/image/thumbnail"
	relImage       = "http://opds-spec.org/image"

	relSelf       = "self"
	relNext       = "next"
	relPrevious   = "previous"
	relSubsection = "subsection"
	relAlternate  = "alternate"

	mimeEpub    = "application/epub+zip"
	mimeCatalog = "application/atom+xml"
)

const (
	// fetchTimeout bounds one feed request. Catalogs are small XML documents;
	// anything slower than this is a server problem the reader cannot fix.
	fetchTimeout = 15 * time.Second
	// downloadTimeout is much longer: a 40 MB EPUB over a phone connection is
	// normal, and the reader already sees a progress-less "importing" state.
	downloadTimeout = 5 * time.Minute

	// maxFeedBytes caps a catalog document. Some servers inline base64
	// thumbnails per entry, so this is generous but still bounded.
	maxFeedBytes = 8 << 20
	// maxBookBytes caps a single download, so a hostile or broken link cannot
	// fill the disk before the importer ever sees the file.
	maxBookBytes = 256 << 20

	// downloadAttempts counts resumed attempts, not full restarts: each one
	// picks up where the last left off, so 3 is cheap and covers a connection
	// that drops twice on the same book.
	downloadAttempts = 3

	// summaryLimit truncates the blurb from the feed. Gutenberg ships several
	// kilobytes of xhtml per entry; the card shows two lines.
	summaryLimit = 300

	// browserUA is required in practice: some catalogs (Gutenberg among them)
	// answer a bare Go client with a stub or an error page.
	browserUA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
		"(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)

// Link is one <link> element with its href already made absolute.
type Link struct {
	Rel    string `json:"rel"`
	Href   string `json:"href"`
	Type   string `json:"type"`
	Title  string `json:"title"`
	Length int64  `json:"length"`
}

// Entry is one catalog row: either a navigation node (NavHref set, no
// downloads) or a publication (Downloads non-empty).
type Entry struct {
	ID        string `json:"id"`
	Title     string `json:"title"`
	Author    string `json:"author"`
	Summary   string `json:"summary"`
	Language  string `json:"language"`
	Updated   string `json:"updated"`
	Thumbnail string `json:"thumbnail"`
	NavHref   string `json:"navHref"`
	Downloads []Link `json:"downloads"`
}

// Feed is a parsed catalog page.
type Feed struct {
	Title string `json:"title"`
	// Requested is the URL this page was actually served from. The UI keeps it
	// as the "back" target, which matters because many catalogs omit rel=self.
	Requested string  `json:"requested"`
	Self      string  `json:"self"`
	Next      string  `json:"next"`
	Prev      string  `json:"prev"`
	Entries   []Entry `json:"entries"`
}

// Source is a catalog the reader configured: an entry point plus an optional
// search template and optional basic-auth credentials.
type Source struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	// Desc is what the built-in catalog shows under a source's name; sources
	// the reader typed in leave it empty.
	Desc string `json:"desc"`
	URL  string `json:"url"`
	// SearchURL must contain the literal {search}; without it the UI hides the
	// search box instead of guessing every server's query syntax.
	SearchURL string `json:"searchUrl"`
	Username  string `json:"username"`
	Password  string `json:"password"`
	Insecure  bool   `json:"insecure"`
}

// ParseSource validates the map the frontend sends. It is the only place that
// turns untyped binding arguments into a Source.
func ParseSource(input map[string]any) (Source, error) {
	raw, _ := input["url"].(string)
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return Source{}, errors.New("请填写 OPDS 地址")
	}
	u, err := neturl.Parse(raw)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return Source{}, errors.New("OPDS 地址格式不正确（需为完整 http(s) URL）")
	}
	s := Source{URL: u.String()}
	s.ID, _ = input["id"].(string)
	s.Name, _ = input["name"].(string)
	s.Desc, _ = input["desc"].(string)
	s.SearchURL, _ = input["searchUrl"].(string)
	s.SearchURL = strings.TrimSpace(s.SearchURL)
	s.Username, _ = input["username"].(string)
	s.Password, _ = input["password"].(string)
	switch v := input["insecure"].(type) {
	case bool:
		s.Insecure = v
	case string:
		s.Insecure = v == "true" || v == "1"
	}
	return s, nil
}

// BrowseURL returns the URL to fetch for a query. An empty query means "the
// catalog entry point"; a non-empty query without a {search} template returns
// the empty string, which callers treat as "search not supported here".
func (s Source) BrowseURL(query string) string {
	query = strings.TrimSpace(query)
	if query == "" {
		return s.URL
	}
	if !strings.Contains(s.SearchURL, "{search}") {
		return ""
	}
	// PathEscape, not QueryEscape: OPDS search templates appear both as a query
	// parameter and as a path segment (/opds/search/{search}), and %20 is valid
	// in both while '+' is only correct in the former.
	return strings.ReplaceAll(s.SearchURL, "{search}", neturl.PathEscape(query))
}

// ParseFeed turns one catalog document into a Feed. feedURL is the URL the
// document was actually served from; every relative href is resolved against
// it, because almost no catalog uses absolute links.
func ParseFeed(raw, feedURL string) (*Feed, error) {
	root, err := epub.ParseXMLString(raw)
	if err != nil {
		return nil, fmt.Errorf("OPDS 内容不是合法 XML：%w", err)
	}
	node := child(root, "feed")
	if node == nil {
		return nil, errors.New("这不是一个 OPDS 目录（没有找到 <feed>，请确认地址指向 OPDS 而不是网页）")
	}

	// xml:base is rare but legal; honour it before resolving anything else.
	base := feedURL
	if b := node.Attrs["base"]; b != "" {
		base = resolveHref(base, b)
	}

	feed := &Feed{Title: deepText(child(node, "title")), Requested: feedURL}
	for _, l := range linksOf(node) {
		href := resolveHref(base, l.href)
		switch l.rel {
		case relSelf:
			feed.Self = href
		case relNext:
			feed.Next = href
		case relPrevious:
			feed.Prev = href
		}
	}

	for _, en := range childrenOf(node, "entry") {
		e, ok := parseEntry(en, base)
		if ok {
			feed.Entries = append(feed.Entries, e)
		}
	}
	feed.Entries = mergeVariants(feed.Entries)
	// A nil slice marshals to `null`, and the frontend reads these as lists
	// without checking (`feed.entries.length`, `entry.downloads.find(...)`).
	// An empty page — a search with no hits — would therefore crash the reader
	// instead of showing "这里没有内容".
	if feed.Entries == nil {
		feed.Entries = []Entry{}
	}
	for i := range feed.Entries {
		if feed.Entries[i].Downloads == nil {
			feed.Entries[i].Downloads = []Link{}
		}
	}
	return feed, nil
}

// parseEntry reads one <entry>. It reports false for rows that carry nothing
// usable (no title and no links), which is how some servers pad a feed.
func parseEntry(node *epub.XMLNode, base string) (Entry, bool) {
	e := Entry{
		ID:       deepText(child(node, "id")),
		Title:    deepText(child(node, "title")),
		Updated:  deepText(child(node, "updated")),
		Language: deepText(child(node, "language")),
	}
	if a := child(node, "author"); a != nil {
		e.Author = deepText(child(a, "name"))
	}
	if c := child(node, "content"); c != nil {
		e.Summary = truncate(deepText(c), summaryLimit)
	}
	if e.Summary == "" {
		if s := child(node, "summary"); s != nil {
			e.Summary = truncate(deepText(s), summaryLimit)
		}
	}

	var fallbackImage string
	// A catalog link with no rel at all. OPDS 1.x asks for rel="subsection",
	// but Ebooks libres et gratuits ships `<link type="application/atom+xml"
	// href="feed.php"/>` and a strict reading leaves every row dead. It is only
	// honoured as a last resort, and only on rows that offer no file, so it can
	// never turn a download into a folder.
	var relLessCatalog string
	for _, l := range linksOf(node) {
		href := resolveHref(base, l.href)
		switch {
		case strings.HasPrefix(l.rel, relAcquisition):
			e.Downloads = append(e.Downloads, Link{
				Rel: l.rel, Href: href, Type: l.typ, Title: l.title, Length: l.length,
			})
		case l.rel == relThumbnail:
			e.Thumbnail = href
		case l.rel == relImage:
			fallbackImage = href
		case l.rel == relSubsection, l.rel == relAlternate && strings.Contains(l.typ, mimeCatalog):
			// The alternate-catalog case is how a publication feed links back to
			// a browsable parent; `related` links also point at catalogs but they
			// are deliberately ignored so a book row never turns into a folder.
			if e.NavHref == "" {
				e.NavHref = href
			}
		case l.rel == "" && strings.Contains(l.typ, mimeCatalog) && relLessCatalog == "":
			relLessCatalog = href
		}
	}
	if e.Thumbnail == "" {
		e.Thumbnail = fallbackImage
	}
	if e.NavHref == "" && len(e.Downloads) == 0 {
		e.NavHref = relLessCatalog
	}

	if e.Title == "" && e.NavHref == "" && len(e.Downloads) == 0 {
		return Entry{}, false
	}
	if e.Title == "" {
		e.Title = "未命名"
	}
	// React needs a stable key even when the server omits <id>.
	if e.ID == "" {
		e.ID = firstNonEmpty(e.NavHref, downloadHref(e.Downloads), e.Title)
	}
	return e, true
}

// mergeVariants folds the "same book, several editions" pattern into one row.
// Gutenberg lists an illustrated and an image-less edition as two entries with
// the same title and author; showing them twice in a picker is noise.
func mergeVariants(in []Entry) []Entry {
	out := make([]Entry, 0, len(in))
	index := make(map[string]int, len(in))
	for _, e := range in {
		if e.Author == "" || len(e.Downloads) == 0 {
			out = append(out, e)
			continue
		}
		key := e.Title + "\x00" + e.Author
		if i, ok := index[key]; ok {
			out[i] = mergeInto(out[i], e)
			continue
		}
		index[key] = len(out)
		out = append(out, e)
	}
	return out
}

func mergeInto(dst, src Entry) Entry {
	seen := make(map[string]bool, len(dst.Downloads))
	for _, d := range dst.Downloads {
		seen[d.Href] = true
	}
	for _, d := range src.Downloads {
		if !seen[d.Href] {
			dst.Downloads = append(dst.Downloads, d)
			seen[d.Href] = true
		}
	}
	if dst.Thumbnail == "" {
		dst.Thumbnail = src.Thumbnail
	}
	if dst.Language == "" {
		dst.Language = src.Language
	}
	if len(src.Summary) > len(dst.Summary) {
		dst.Summary = src.Summary
	}
	return dst
}

// PickEpub chooses the EPUB to download from a book's acquisition links, or nil
// when it has none. Rules, in order: EPUB only; skip "no images" variants; then
// prefer the larger file, which in practice is the illustrated edition.
func PickEpub(downloads []Link) *Link {
	var best *Link
	for i := range downloads {
		l := &downloads[i]
		if !strings.HasPrefix(strings.ToLower(l.Type), mimeEpub) {
			continue
		}
		if best == nil || betterEpub(*l, *best) {
			best = l
		}
	}
	return best
}

func betterEpub(a, b Link) bool {
	aBare, bBare := imageLess(a), imageLess(b)
	if aBare != bBare {
		return !aBare
	}
	return a.Length > b.Length
}

func imageLess(l Link) bool {
	t := strings.ToLower(l.Title)
	return strings.Contains(t, "no image") || strings.Contains(t, "noimages") || strings.Contains(t, "without images")
}

/* ---------------------------------- http ---------------------------------- */

// Fetch downloads and parses one catalog page. The URL is taken as given: the
// caller resolved it from a link the feed itself published, so it is a request
// the reader indirectly asked for.
func Fetch(ctx context.Context, s Source, rawURL string) (*Feed, error) {
	if strings.TrimSpace(rawURL) == "" {
		return nil, errors.New("OPDS 目录地址为空")
	}
	body, err := get(ctx, s, rawURL, "application/atom+xml,application/xml;q=0.9,*/*;q=0.8", maxFeedBytes, fetchTimeout)
	if err != nil {
		return nil, err
	}
	return ParseFeed(string(body), rawURL)
}

// Download saves one file to destPath. The caller imports it and then removes
// the temp file, exactly like the WebDAV path does.
//
// This streams straight to disk and resumes with a Range request, because on a
// phone a large catalog file is regularly cut off mid-body: 紅樓夢 failed twice
// in a row with "unexpected EOF" while 西遊記 went through on the second tap.
// Restarting from zero each time makes a 1.5 MB book a coin flip; continuing
// from the last byte makes the interrupted transfer cheap.
func Download(ctx context.Context, s Source, rawURL, destPath string) error {
	if err := os.MkdirAll(filepath.Dir(destPath), 0o755); err != nil {
		return err
	}
	var written int64
	var lastErr error
	for attempt := 0; attempt < downloadAttempts; attempt++ {
		n, err := fetchInto(ctx, s, rawURL, destPath, written)
		written += n
		if err == nil {
			return nil
		}
		lastErr = err
		// A status the server chose (404, 401) is final; a body that stopped
		// halfway is not.
		if !retryable(err) {
			_ = os.Remove(destPath)
			return err
		}
	}
	_ = os.Remove(destPath)
	return fmt.Errorf("%s（已下载 %s，重试 %d 次仍未完成）", lastErr, humanBytes(written), downloadAttempts)
}

// fetchInto requests the file from byte offset `from` and appends what arrives
// to destPath. It returns the number of bytes written.
//
// The 200 branch is not paranoia: a server that ignores Range answers the
// resumed request with the whole file, and appending that to the half we
// already have would corrupt the EPUB in a way the importer reports as
// "不是有效的 epub" much later.
func fetchInto(ctx context.Context, s Source, rawURL, destPath string, from int64) (int64, error) {
	ctx, cancel := context.WithTimeout(ctx, downloadTimeout)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return 0, fmt.Errorf("地址无效：%w", err)
	}
	req.Header.Set("User-Agent", browserUA)
	req.Header.Set("Accept", "application/epub+zip,*/*;q=0.8")
	if from > 0 {
		req.Header.Set("Range", fmt.Sprintf("bytes=%d-", from))
	}
	if s.Username != "" {
		req.SetBasicAuth(s.Username, s.Password)
	}

	resp, err := client(s).Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return 0, errors.New("请求超时，请检查网络或换一个书源")
		}
		return 0, fmt.Errorf("网络请求失败：%w", err)
	}
	defer resp.Body.Close()

	switch {
	case resp.StatusCode == http.StatusUnauthorized:
		return 0, errors.New("认证失败：用户名或密码错误")
	case resp.StatusCode == http.StatusNotFound:
		return 0, fmt.Errorf("文件不存在（404）：%s", rawURL)
	case resp.StatusCode == http.StatusRequestedRangeNotSatisfiable && from > 0:
		// Nothing left to send: the file we have is already complete.
		return 0, nil
	case resp.StatusCode == http.StatusPartialContent:
		// Append, as asked.
	case resp.StatusCode >= 200 && resp.StatusCode < 300:
		from = 0
	default:
		return 0, fmt.Errorf("服务器返回 %s", resp.Status)
	}

	flags := os.O_CREATE | os.O_WRONLY | os.O_APPEND
	if from == 0 {
		flags = os.O_CREATE | os.O_WRONLY | os.O_TRUNC
	}
	f, err := os.OpenFile(destPath, flags, 0o644)
	if err != nil {
		return 0, fmt.Errorf("无法写入文件：%w", err)
	}
	defer f.Close()

	n, err := io.Copy(f, io.LimitReader(resp.Body, maxBookBytes-from+1))
	if err != nil {
		// Keep the partial file: the next attempt resumes from here.
		return n, fmt.Errorf("下载中断：%w", err)
	}
	if from+n > maxBookBytes {
		return n, fmt.Errorf("文件超过 %d MB 上限，已中止", maxBookBytes>>20)
	}
	return n, nil
}

func humanBytes(n int64) string {
	switch {
	case n <= 0:
		return "0 B"
	case n < 1<<10:
		return fmt.Sprintf("%d B", n)
	case n < 1<<20:
		return fmt.Sprintf("%.0f KB", float64(n)/(1<<10))
	default:
		return fmt.Sprintf("%.1f MB", float64(n)/(1<<20))
	}
}

// retryable is deliberately narrow: only a transfer that was cut short, never a
// status the server chose (404, 401, 503). Retrying those would just make the
// reader wait twice for the same answer.
func retryable(err error) bool {
	if errors.Is(err, io.ErrUnexpectedEOF) || errors.Is(err, syscall.ECONNRESET) {
		return true
	}
	msg := strings.ToLower(err.Error())
	return strings.Contains(msg, "unexpected eof") || strings.Contains(msg, "connection reset")
}

func get(ctx context.Context, s Source, rawURL, accept string, max int64, timeout time.Duration) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return nil, fmt.Errorf("地址无效：%w", err)
	}
	req.Header.Set("User-Agent", browserUA)
	req.Header.Set("Accept", accept)
	if s.Username != "" {
		req.SetBasicAuth(s.Username, s.Password)
	}

	resp, err := client(s).Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return nil, errors.New("请求超时，请检查网络或换一个书源")
		}
		return nil, fmt.Errorf("网络请求失败：%w", err)
	}
	defer resp.Body.Close()

	switch {
	case resp.StatusCode == http.StatusUnauthorized:
		return nil, errors.New("认证失败：用户名或密码错误")
	case resp.StatusCode == http.StatusNotFound:
		return nil, fmt.Errorf("目录不存在（404），请检查地址：%s", rawURL)
	case resp.StatusCode < 200 || resp.StatusCode >= 300:
		return nil, fmt.Errorf("服务器返回 %s", resp.Status)
	}

	// Read one byte past the cap so an oversized document is an error rather
	// than a silent truncation that later fails to parse.
	body, err := io.ReadAll(io.LimitReader(resp.Body, max+1))
	if err != nil {
		return nil, fmt.Errorf("读取响应失败：%w", err)
	}
	if int64(len(body)) > max {
		return nil, fmt.Errorf("响应超过 %d MB 上限，已中止", max>>20)
	}
	return body, nil
}

func client(s Source) *http.Client {
	if !s.Insecure {
		return http.DefaultClient
	}
	return &http.Client{
		Transport: &http.Transport{TLSClientConfig: &tls.Config{InsecureSkipVerify: true}},
	}
}

/* --------------------------------- helpers -------------------------------- */

// child returns the first direct child with the given local name. The package's
// XMLNode.Find is a descendant search, which would happily pull <author> out of
// an embedded xhtml content block; entries need the strict version.
func child(n *epub.XMLNode, local string) *epub.XMLNode {
	if n == nil {
		return nil
	}
	for _, c := range n.Children {
		if c.Local == local {
			return c
		}
	}
	return nil
}

func childrenOf(n *epub.XMLNode, local string) []*epub.XMLNode {
	if n == nil {
		return nil
	}
	var out []*epub.XMLNode
	for _, c := range n.Children {
		if c.Local == local {
			out = append(out, c)
		}
	}
	return out
}

// rawLink keeps the attributes of a <link> before resolution. XMLNode exposes a
// map, so this is just a typed read of it.
type rawLink struct {
	rel, href, typ, title string
	length                int64
}

func linksOf(n *epub.XMLNode) []rawLink {
	var out []rawLink
	for _, c := range childrenOf(n, "link") {
		var length int64
		if v := c.Attrs["length"]; v != "" {
			fmt.Sscanf(v, "%d", &length)
		}
		out = append(out, rawLink{
			rel:    strings.TrimSpace(c.Attrs["rel"]),
			href:   strings.TrimSpace(c.Attrs["href"]),
			typ:    strings.TrimSpace(c.Attrs["type"]),
			title:  strings.TrimSpace(c.Attrs["title"]),
			length: length,
		})
	}
	return out
}

// deepText concatenates the text of a node and all its descendants. The
// package's XMLNode.Text only holds direct character data, so
// <content><div><p>text</p></div></content> reads as empty without this.
func deepText(n *epub.XMLNode) string {
	if n == nil {
		return ""
	}
	var b strings.Builder
	var walk func(*epub.XMLNode)
	walk = func(x *epub.XMLNode) {
		b.WriteString(x.Text)
		b.WriteByte(' ')
		for _, c := range x.Children {
			walk(c)
		}
	}
	walk(n)
	return strings.Join(strings.Fields(b.String()), " ")
}

func truncate(s string, limit int) string {
	r := []rune(s)
	if len(r) <= limit {
		return s
	}
	return strings.TrimSpace(string(r[:limit])) + "…"
}

// resolveHref makes a link absolute against the document it appeared in. Any
// non-relative reference (http, https, data:, mailto:) is returned untouched.
func resolveHref(base, href string) string {
	href = strings.TrimSpace(href)
	if href == "" {
		return ""
	}
	if strings.HasPrefix(strings.ToLower(href), "data:") {
		return href
	}
	ref, err := neturl.Parse(href)
	if err != nil {
		return href
	}
	if ref.IsAbs() {
		return href
	}
	b, err := neturl.Parse(base)
	if err != nil {
		return href
	}
	return b.ResolveReference(ref).String()
}

func downloadHref(links []Link) string {
	if len(links) > 0 {
		return links[0].Href
	}
	return ""
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}
