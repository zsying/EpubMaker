package epub

import (
	"archive/zip"
	"bytes"
	"errors"
	"fmt"
	"io"
	"os"
	"regexp"
	"strings"

	"epubmaker-desktop/internal/html"
	"epubmaker-desktop/internal/mime"
)

// ManifestItem is a single OPF manifest entry, resolved to a zip-internal path.
type ManifestItem struct {
	ID         string
	Href       string // normalized zip-internal path
	MediaType  string
	Properties string
}

// TOCEntry is a single node in the (possibly hierarchical) table of contents.
// Children carries nested sub-sections, mirroring NCX <navPoint> nesting and
// EPUB3 nav <ol><li> nesting. A node without an href is a structural parent
// (e.g. an EPUB3 nav <span> group) that still groups its children.
type TOCEntry struct {
	Href     string     `json:"href"`
	Title    string     `json:"title"`
	Children []TOCEntry `json:"children,omitempty"`
}

// ParsedEpub is the extracted structure of an EPUB, ready to be persisted.
type ParsedEpub struct {
	Metadata  Metadata
	OpfPath   string
	Spine     []ManifestItem
	Resources []ManifestItem
	TOC       map[string]string // href -> title (flat, used for spine title lookup)
	TOCList   []TOCEntry        // hierarchical table of contents (preserves nesting)
	CoverHref string
	// Entries maps normalized href -> zip file handle. Cleared after use.
	Entries map[string]*zip.File
}

// Metadata holds the book's Dublin Core metadata.
type Metadata struct {
	Title       string
	Author      string
	Language    string
	Publisher   string
	Description string
	Identifier  string
}

// ReadEntry reads the full (decompressed) bytes of a zip entry.
func ReadEntry(f *zip.File) ([]byte, error) {
	rc, err := f.Open()
	if err != nil {
		return nil, err
	}
	defer rc.Close()
	return io.ReadAll(rc)
}

// textOf extracts trimmed text from an XMLNode character-data value (which our
// parser stores as a plain string in .Text).
func textOf(v any) string {
	switch t := v.(type) {
	case nil:
		return ""
	case string:
		return strings.TrimSpace(t)
	case bool, float64, int:
		return fmt.Sprint(t)
	case []any:
		if len(t) > 0 {
			return textOf(t[0])
		}
	}
	return ""
}

// innerText recursively concatenates the character data of a node and all its
// descendants (so titles inside <a>Chapter <b>1</b></a> come out whole).
func innerText(n *XMLNode) string {
	if n == nil {
		return ""
	}
	var sb strings.Builder
	sb.WriteString(n.Text)
	for _, c := range n.Children {
		sb.WriteString(innerText(c))
	}
	return strings.TrimSpace(sb.String())
}

// childElems returns the direct children of parent whose local name is local.
// Direct children only — unlike FindAll, which is depth-first over all
// descendants — so nested lists are not double-counted when recursing.
func childElems(parent *XMLNode, local string) []*XMLNode {
	if parent == nil {
		return nil
	}
	var out []*XMLNode
	for _, c := range parent.Children {
		if c.Local == local {
			out = append(out, c)
		}
	}
	return out
}

// parseNcxTree builds the hierarchical TOC from an NCX navMap, preserving
// <navPoint> nesting. Returns nil when no navMap is present.
func parseNcxTree(root *XMLNode, ncxPath string) []TOCEntry {
	if root == nil {
		return nil
	}
	navMap := root.find("navMap")
	if navMap == nil {
		return nil
	}
	return ncxNavPoints(navMap, ncxPath)
}

func ncxNavPoints(parent *XMLNode, ncxPath string) []TOCEntry {
	var out []TOCEntry
	for _, np := range childElems(parent, "navPoint") {
		var title string
		if label := childElems(np, "navLabel"); len(label) > 0 {
			if t := childElems(label[0], "text"); len(t) > 0 {
				title = innerText(t[0])
			}
		}
		var href string
		if content := childElems(np, "content"); len(content) > 0 {
			if src, ok := content[0].Attrs["src"]; ok && src != "" {
				href = resolveHrefKeepFragment(ncxPath, src)
			}
		}
		out = append(out, TOCEntry{
			Href:     href,
			Title:    title,
			Children: ncxNavPoints(np, ncxPath),
		})
	}
	return out
}

// resolveHrefKeepFragment resolves a TOC entry href against its container file
// but keeps any #fragment, since sub-section entries point at anchors inside a
// chapter document. ResolveHref/NormalizeHref strip the fragment, so we split
// it off, resolve the base, and re-append it.
func resolveHrefKeepFragment(fromFile, rel string) string {
	frag := ""
	if i := strings.IndexByte(rel, '#'); i >= 0 {
		frag = rel[i:]
		rel = rel[:i]
	}
	if rel == "" {
		return frag // fragment-only reference
	}
	return html.ResolveHref(fromFile, rel) + frag
}

// parseNavTree builds the hierarchical TOC from an EPUB3 nav document,
// preserving <ol><li> nesting. Prefers the nav with epub:type="toc".
func parseNavTree(root *XMLNode, navPath string) []TOCEntry {
	if root == nil {
		return nil
	}
	var nav *XMLNode
	for _, n := range root.FindAll("nav") {
		if strings.Contains(n.Attrs["epub:type"], "toc") {
			nav = n
			break
		}
	}
	if nav == nil {
		nav = root.find("nav")
	}
	if nav == nil {
		return nil
	}
	return navListItems(nav, navPath)
}

// navListItems walks the immediate <ol> children of parent, recursing into
// each <li>'s nested <ol> to keep the hierarchy intact.
func navListItems(parent *XMLNode, navPath string) []TOCEntry {
	var out []TOCEntry
	for _, ol := range childElems(parent, "ol") {
		for _, li := range childElems(ol, "li") {
			entry := navLi(li, navPath)
			entry.Children = navListItems(li, navPath)
			out = append(out, entry)
		}
	}
	return out
}

// navLi extracts a single <li>'s href/title from its DIRECT children only — a
// <a> gives the link, a bare <span> (or the li's own text) is a structural
// parent grouping its children. Descendant search is avoided so a parent li
// does not hijack a nested li's <a>.
func navLi(li *XMLNode, navPath string) TOCEntry {
	title, href := "", ""
	if a := childElems(li, "a"); len(a) > 0 {
		if h, ok := a[0].Attrs["href"]; ok && h != "" {
			href = resolveHrefKeepFragment(navPath, h)
		}
		title = innerText(a[0])
	}
	if title == "" {
		if span := childElems(li, "span"); len(span) > 0 {
			title = innerText(span[0])
		}
	}
	if title == "" {
		title = innerText(li)
	}
	return TOCEntry{Href: href, Title: title}
}

// flattenTOC collapses a hierarchical TOC into the flat href->title map used
// for spine title lookups. Document order is preserved; first occurrence wins.
func flattenTOC(entries []TOCEntry) map[string]string {
	out := map[string]string{}
	var walk func([]TOCEntry)
	walk = func(es []TOCEntry) {
		for _, e := range es {
			if e.Href != "" && e.Title != "" {
				if _, ok := out[e.Href]; !ok {
					out[e.Href] = e.Title
				}
			}
			walk(e.Children)
		}
	}
	walk(entries)
	return out
}

const zipLocalHeader = "PK\x03\x04"

// findZipOffset returns the index of the first ZIP local file header.
// Some downloaded EPUBs carry a small leading stub (BOM, HTML redirect,
// downloader watermark, etc.); this lets us tolerate such junk.
func findZipOffset(data []byte) int {
	return bytes.Index(data, []byte(zipLocalHeader))
}

// ParseEpub reads an EPUB byte slice and extracts its metadata, reading order,
// resources, table of contents, and cover.
func ParseEpub(data []byte) (*ParsedEpub, error) {
	if len(data) < 4 {
		return nil, errors.New("文件为空，不是有效的 EPUB")
	}
	offset := findZipOffset(data)
	if offset < 0 {
		return nil, fmt.Errorf("不是有效的 EPUB（文件头不是 ZIP 格式），前 16 字节: %x", data[:min(len(data), 16)])
	}
	zr, err := zip.NewReader(bytes.NewReader(data[offset:]), int64(len(data)-offset))
	if err != nil {
		return nil, fmt.Errorf("不是有效的 EPUB（zip 解析失败）: %w", err)
	}
	return parseZip(zr)
}

// ParseEpubFile reads an EPUB from disk and tolerates a small leading stub
// before the ZIP signature (e.g. BOM or downloader watermark).
func ParseEpubFile(path string) (*ParsedEpub, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	return ParseEpub(data)
}

func parseZip(zr *zip.Reader) (*ParsedEpub, error) {
	byName := map[string]*zip.File{}
	for _, f := range zr.File {
		if f.FileInfo().IsDir() {
			continue
		}
		byName[html.NormalizeHref(f.Name)] = f
	}
	find := func(name string) *zip.File { return byName[html.NormalizeHref(name)] }

	// 1. container.xml -> opf path
	var opfPath string
	if ce := find("META-INF/container.xml"); ce != nil {
		if b, e := ReadEntry(ce); e == nil {
			if root, e := parseXMLTree(b); e == nil {
				opfPath = findOpfPath(root)
			}
		}
	}
	if opfPath == "" {
		for _, f := range zr.File {
			if strings.HasSuffix(strings.ToLower(f.Name), ".opf") {
				opfPath = html.NormalizeHref(f.Name)
				break
			}
		}
	}
	if opfPath == "" {
		return nil, errors.New("不是有效的 EPUB：找不到 OPF 文件")
	}
	opfEntry := find(opfPath)
	if opfEntry == nil {
		return nil, fmt.Errorf("不是有效的 EPUB：OPF 文件缺失 (%s)", opfPath)
	}
	opfXML, err := ReadEntry(opfEntry)
	if err != nil {
		return nil, fmt.Errorf("读取 OPF 失败: %w", err)
	}
	root, err := parseXMLTree(opfXML)
	if err != nil {
		return nil, fmt.Errorf("OPF 解析失败: %w", err)
	}
	pkg := root.find("package")
	if pkg == nil {
		return nil, errors.New("OPF 解析失败：缺少 package 元素")
	}

	// 2. metadata
	meta := pkg.find("metadata")
	metaTags := map[string]string{} // name(attr) -> content(attr)
	if meta != nil {
		for _, m := range meta.findAll("meta") {
			name := m.Attrs["name"]
			content := m.Attrs["content"]
			if name != "" {
				metaTags[strings.ToLower(name)] = content
			}
		}
	}
	metadata := Metadata{
		Title:       orDefault(textOf(metaChild(meta, "title")), "未命名书籍"),
		Author:      strings.Join(creatorList(meta), "、"),
		Language:    orDefault(textOf(metaChild(meta, "language")), "zh"),
		Publisher:   textOf(metaChild(meta, "publisher")),
		Description: html.StripTags(textOf(metaChild(meta, "description"))),
		Identifier:  firstNonEmpty(identifierList(meta)),
	}

	// 3. manifest
	var items []ManifestItem
	if manifest := pkg.find("manifest"); manifest != nil {
		for _, it := range manifest.findAll("item") {
			href := html.ResolveHref(opfPath, it.Attrs["href"])
			mt := it.Attrs["media-type"]
			if mt == "" {
				mt = mime.GuessMediaType(href)
			}
			items = append(items, ManifestItem{
				ID:         it.Attrs["id"],
				Href:       href,
				MediaType:  mt,
				Properties: it.Attrs["properties"],
			})
		}
	}
	byID := map[string]ManifestItem{}
	for _, it := range items {
		byID[it.ID] = it
	}

	// 4. spine
	var spine []ManifestItem
	if spineEl := pkg.find("spine"); spineEl != nil {
		var navItem *ManifestItem
		for i := range items {
			if strings.Contains(items[i].Properties, "nav") {
				navItem = &items[i]
				break
			}
		}
		ncxID := spineEl.Attrs["toc"]
		var ncxItem *ManifestItem
		if ncxID != "" {
			if it, ok := byID[ncxID]; ok {
				ncxItem = &it
			}
		}
		if ncxItem == nil {
			for i := range items {
				if items[i].MediaType == "application/x-dtbncx+xml" {
					ncxItem = &items[i]
					break
				}
			}
		}
		for _, ref := range spineEl.findAll("itemref") {
			it, ok := byID[ref.Attrs["idref"]]
			if !ok {
				continue
			}
			if !mime.IsDocument(it.MediaType) {
				continue
			}
			if navItem != nil && it.Href == navItem.Href {
				continue
			}
			spine = append(spine, it)
		}
		if len(spine) == 0 {
			for i := range items {
				if mime.IsDocument(items[i].MediaType) && (navItem == nil || items[i].Href != navItem.Href) {
					spine = append(spine, items[i])
				}
			}
		}
		// 5. table of contents (hierarchical)
		var navRoot, ncxRoot *XMLNode
		if navItem != nil {
			if e := find(navItem.Href); e != nil {
				if b, e2 := ReadEntry(e); e2 == nil {
					if r, e3 := parseXMLTree(b); e3 == nil {
						navRoot = r
					}
				}
			}
		}
		if ncxItem != nil {
			if e := find(ncxItem.Href); e != nil {
				if b, e2 := ReadEntry(e); e2 == nil {
					if r, e3 := parseXMLTree(b); e3 == nil {
						ncxRoot = r
					}
				}
			}
		}
		navTree := parseNavTree(navRoot, navItem.Href)
		ncxTree := parseNcxTree(ncxRoot, ncxItem.Href)
		tocList := navTree
		if len(tocList) == 0 {
			tocList = ncxTree
		}
		toc := flattenTOC(tocList)
		// When both a nav doc and an NCX are present, merge the NCX titles into
		// the flat map too so spine title lookup stays as complete as before.
		if navTree != nil && ncxTree != nil {
			for k, v := range flattenTOC(ncxTree) {
				if _, ok := toc[k]; !ok {
					toc[k] = v
				}
			}
		}

		// 6. cover
		coverHref := ""
		for i := range items {
			if strings.Contains(items[i].Properties, "cover-image") {
				coverHref = items[i].Href
				break
			}
		}
		if coverHref == "" {
			if target, ok := metaTags["cover"]; ok {
				if it, ok := byID[target]; ok && strings.HasPrefix(it.MediaType, "image/") {
					coverHref = it.Href
				}
			}
		}
		if coverHref == "" {
			for i := range items {
				if strings.HasPrefix(items[i].MediaType, "image/") && regexp.MustCompile(`(?i)cover`).MatchString(items[i].Href) {
					coverHref = items[i].Href
					break
				}
			}
		}

		// 7. entries (skip opf/ncx/nav and structural files)
		skip := map[string]bool{opfPath: true}
		if ncxItem != nil {
			skip[ncxItem.Href] = true
		}
		if navItem != nil {
			skip[navItem.Href] = true
		}
		entries := map[string]*zip.File{}
		for norm, f := range byName {
			if norm == "" || norm == "mimetype" || strings.HasPrefix(norm, "META-INF/") {
				continue
			}
			if skip[norm] {
				continue
			}
			if strings.HasSuffix(norm, ".opf") || strings.HasSuffix(norm, ".ncx") {
				continue
			}
			entries[norm] = f
		}

		spineHrefs := map[string]bool{}
		for _, s := range spine {
			spineHrefs[s.Href] = true
		}
		var resources []ManifestItem
		for _, it := range items {
			if spineHrefs[it.Href] || skip[it.Href] || !entryExists(entries, it.Href) {
				continue
			}
			resources = append(resources, it)
		}
		for href := range entries {
			if spineHrefs[href] {
				continue
			}
			found := false
			for _, r := range resources {
				if r.Href == href {
					found = true
					break
				}
			}
			if found {
				continue
			}
			resources = append(resources, ManifestItem{ID: "", Href: href, MediaType: mime.GuessMediaType(href), Properties: ""})
		}

		return &ParsedEpub{
			Metadata:  metadata,
			OpfPath:   opfPath,
			Spine:     spine,
			Resources: resources,
			TOC:       toc,
			TOCList:   tocList,
			CoverHref: coverHref,
			Entries:   entries,
		}, nil
	}

	return nil, errors.New("OPF 缺少 spine")
}

func entryExists(m map[string]*zip.File, k string) bool {
	_, ok := m[k]
	return ok
}

func findOpfPath(root *XMLNode) string {
	if root == nil {
		return ""
	}
	for _, rf := range root.findAll("rootfile") {
		if p := rf.Attrs["full-path"]; p != "" {
			return html.NormalizeHref(p)
		}
	}
	return ""
}

func metaChild(meta *XMLNode, local string) any {
	if meta == nil {
		return nil
	}
	if c := meta.find(local); c != nil {
		return c.Text
	}
	return nil
}

func creatorList(meta *XMLNode) []string {
	if meta == nil {
		return nil
	}
	var out []string
	for _, c := range meta.findAll("creator") {
		if t := strings.TrimSpace(c.Text); t != "" {
			out = append(out, t)
		}
	}
	return out
}

func identifierList(meta *XMLNode) []string {
	if meta == nil {
		return nil
	}
	var out []string
	for _, c := range meta.findAll("identifier") {
		if t := strings.TrimSpace(c.Text); t != "" {
			out = append(out, t)
		}
	}
	return out
}

func firstNonEmpty(ss []string) string {
	for _, s := range ss {
		if s != "" {
			return s
		}
	}
	return ""
}

func orDefault(s, def string) string {
	if strings.TrimSpace(s) == "" {
		return def
	}
	return s
}
