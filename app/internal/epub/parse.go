package epub

import (
	"archive/zip"
	"bytes"
	"errors"
	"fmt"
	"io"
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

// ParsedEpub is the extracted structure of an EPUB, ready to be persisted.
type ParsedEpub struct {
	Metadata  Metadata
	OpfPath   string
	Spine     []ManifestItem
	Resources []ManifestItem
	TOC       map[string]string // href -> title
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

var ncxTextRe = regexp.MustCompile(`(?is)<text[^>]*>([\s\S]*?)</text>[\s\S]*?<content[^>]*src\s*=\s*["']([^"']+)["']`)
var navLinkRe = regexp.MustCompile(`(?is)<a\s[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)</a>`)

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

// parseNcx extracts <text>title</text> … <content src="…"/> pairs.
func parseNcx(xmlStr, ncxPath string) map[string]string {
	out := map[string]string{}
	for _, m := range ncxTextRe.FindAllStringSubmatch(xmlStr, -1) {
		title := html.StripTags(m[1])
		href := html.ResolveHref(ncxPath, m[2])
		if title != "" && href != "" {
			if _, exists := out[href]; !exists {
				out[href] = title
			}
		}
	}
	return out
}

// parseNav extracts <a href="…">title</a> pairs from an EPUB3 nav document.
func parseNav(xmlStr, navPath string) map[string]string {
	out := map[string]string{}
	for _, m := range navLinkRe.FindAllStringSubmatch(xmlStr, -1) {
		href := html.ResolveHref(navPath, m[1])
		title := html.StripTags(m[2])
		if title != "" && href != "" {
			if _, exists := out[href]; !exists {
				out[href] = title
			}
		}
	}
	return out
}

// ParseEpub reads an EPUB byte slice and extracts its metadata, reading order,
// resources, table of contents, and cover. It streams zip entries lazily and
// keeps only the entry handles (the file is never fully buffered in memory).
func ParseEpub(data []byte) (*ParsedEpub, error) {
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return nil, fmt.Errorf("不是有效的 EPUB（zip 解析失败）: %w", err)
	}

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
		// 5. table of contents
		toc := map[string]string{}
		if navItem != nil {
			if e := find(navItem.Href); e != nil {
				if b, e2 := ReadEntry(e); e2 == nil {
					for k, v := range parseNav(string(b), navItem.Href) {
						toc[k] = v
					}
				}
			}
		}
		if ncxItem != nil {
			if e := find(ncxItem.Href); e != nil {
				if b, e2 := ReadEntry(e); e2 == nil {
					for k, v := range parseNcx(string(b), ncxItem.Href) {
						toc[k] = v
					}
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
