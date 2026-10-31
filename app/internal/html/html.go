// Package html holds tiny HTML/XML string helpers used across the book,
// chapter, and EPUB-engine logic. They mirror server/src/epub/html.ts.
package html

import (
	"fmt"
	"net/url"
	"path"
	"regexp"
	"strings"
)

var bodyRe = regexp.MustCompile(`(?is)(<body[^>]*>)(.*?)(</body>)`)

var tagRe = regexp.MustCompile(`<[^>]*>`)
var wsRe = regexp.MustCompile(`\s+`)
var urlSchemeRe = regexp.MustCompile(`^[a-zA-Z][a-zA-Z0-9+.\-]*:`)
var titleRe = regexp.MustCompile(`(?is)<title[^>]*>(.*?)</title>`)
var hRe = regexp.MustCompile(`(?is)<h[1-3][^>]*>(.*?)</h[1-3]>`)
var svgHrefRe = regexp.MustCompile(`(?i)xlink:href\s*=\s*["']([^"']+)["']`)
var cssUrlRe = regexp.MustCompile(`(?i)url\(\s*['"]?([^'"()]+?)['"]?\s*\)`)

// urlAttrRe matches src/href/poster/data attributes. RE2 has no backreferences
// so we capture both quotes as separate groups and require them to match
// (q1 == q2) in the calling code before rewriting.
var urlAttrRe = regexp.MustCompile(`(\s(?:src|href|poster|data)\s*=\s*)(["'])([^"']*?)(["'])`)

// ExtractBody returns the content of <body>…</body>, or the whole input if no
// body element is present.
func ExtractBody(s string) string {
	m := bodyRe.FindStringSubmatchIndex(s)
	if m == nil {
		return s
	}
	return s[m[4]:m[5]]
}

// ReplaceBody swaps the inner content of <body>, keeping the surrounding
// document. Falls back to wrapping the body in a fresh document.
func ReplaceBody(doc, body string) string {
	m := bodyRe.FindStringSubmatchIndex(doc)
	if m == nil {
		return WrapDocument("", body)
	}
	// m[2] is end of opening <body...>, m[5] is start of </body>.
	return doc[:m[2]] + body + doc[m[5]:]
}

// WrapDocument builds a minimal XHTML document around a body.
func WrapDocument(title, body string) string {
	if title == "" {
		title = "章节"
	}
	return fmt.Sprintf(`<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><meta charset="utf-8"/><title>%s</title></head>
<body>%s</body>
</html>`, title, body)
}

// EncodeHrefForURL percent-encodes each path segment of an href the same way
// JavaScript's encodeURIComponent does, so the frontend can build asset URLs
// that the server decodes with decodeURIComponent.
func EncodeHrefForURL(href string) string {
	segs := strings.Split(href, "/")
	for i, s := range segs {
		segs[i] = encodeURIComponent(s)
	}
	return strings.Join(segs, "/")
}

// NormalizeHref cleans a forward-slash href: drop fragment/query, decode
// percent-encoding, convert backslashes, collapse "."/"..", strip leading
// slashes and leading "../". Mirrors server/src/epub/html.ts normalizeHref.
func NormalizeHref(href string) string {
	if i := strings.IndexByte(href, '#'); i >= 0 {
		href = href[:i]
	}
	if i := strings.IndexByte(href, '?'); i >= 0 {
		href = href[:i]
	}
	if dec, err := url.PathUnescape(href); err == nil {
		href = dec
	}
	href = strings.ReplaceAll(href, "\\", "/")
	href = path.Clean(href)
	href = strings.TrimPrefix(href, "/")
	for strings.HasPrefix(href, "../") {
		href = href[3:]
	}
	return href
}

// ResolveHref resolves a (possibly relative) href against the file it appears
// in, returning a normalized zip-internal path. Absolute URLs, protocol-
// relative, and fragment-only references are returned unchanged.
func ResolveHref(fromFile, rel string) string {
	if isAbsURL(rel) || strings.HasPrefix(rel, "//") || strings.HasPrefix(rel, "#") {
		return rel
	}
	dir := path.Dir(fromFile)
	if dir == "." || dir == "" {
		return NormalizeHref(rel)
	}
	return NormalizeHref(path.Join(dir, rel))
}

func isAbsURL(s string) bool {
	return urlSchemeRe.MatchString(s)
}

// StripTags removes tags and decodes the common HTML entities, then collapses
// whitespace — matching server/src/epub/html.ts.
func StripTags(s string) string {
	s = tagRe.ReplaceAllString(s, "")
	s = strings.NewReplacer(
		"&nbsp;", " ",
		"&amp;", "&",
		"&lt;", "<",
		"&gt;", ">",
		"&quot;", "\"",
	).Replace(s)
	s = wsRe.ReplaceAllString(s, " ")
	return strings.TrimSpace(s)
}

// ExtractTitle guesses a title from <title> then the first h1-h3.
func ExtractTitle(xhtml string) string {
	if m := titleRe.FindStringSubmatch(xhtml); m != nil {
		if t := StripTags(m[1]); t != "" {
			return t
		}
	}
	if m := hRe.FindStringSubmatch(xhtml); m != nil {
		if t := StripTags(m[1]); t != "" {
			return t
		}
	}
	return ""
}

// EscapeXml escapes the five XML predefined entities.
func EscapeXml(s string) string {
	return strings.NewReplacer(
		"&", "&amp;",
		"<", "&lt;",
		">", "&gt;",
		`"`, "&quot;",
		"'", "&apos;",
	).Replace(s)
}

// RewriteResourceUrls rewrites relative resource URLs in htmlStr to absolute
// (served) URLs via resolver. resolver returns "" to keep the original link
// (e.g. when the target resource is missing). Fragment-only suffixes are
// preserved.
func RewriteResourceUrls(htmlStr, fromFile string, resolver func(string) string) string {
	var b strings.Builder
	last := 0
	for _, idx := range urlAttrRe.FindAllStringSubmatchIndex(htmlStr, -1) {
		full := htmlStr[idx[0]:idx[1]]
		prefix := htmlStr[idx[2]:idx[3]]
		q1 := htmlStr[idx[4]:idx[5]]
		val := htmlStr[idx[6]:idx[7]]
		q2 := htmlStr[idx[8]:idx[9]]
		b.WriteString(htmlStr[last:idx[0]])
		if q1 == q2 && val != "" && !isAbsURL(val) && !strings.HasPrefix(val, "//") && !strings.HasPrefix(val, "#") {
			target := ResolveHref(fromFile, val)
			if mapped := resolver(target); mapped != "" {
				hash := ""
				if i := strings.IndexByte(val, '#'); i >= 0 {
					hash = val[i:]
				}
				b.WriteString(prefix + q1 + mapped + hash + q1)
				last = idx[1]
				continue
			}
		}
		b.WriteString(full)
		last = idx[1]
	}
	b.WriteString(htmlStr[last:])
	return b.String()
}

// anchorIdRe matches a real `id` attribute: whitespace before the name, so
// `data-id` and `xml:id` (preceded by '-' and ':') are left alone. RE2 has no
// backreferences, so the two quotes are captured separately.
var anchorIdRe = regexp.MustCompile(`(\s)id\s*=\s*(["'])([^"']+)(["'])`)

// IdsToAnchors renames `id="x"` to `data-anc="x"` throughout a chapter body.
//
// The reader purifies chapter HTML with DOMPurify, which forbids `id`: an epub
// is free to ship id="root" or id="app" and hijack the host page's own
// selectors. But those ids are exactly what a table of contents points at
// (`#filepos330338`), so dropping them left every nav entry for a section
// inside a document landing on the top of that document. A data attribute
// carries the same anchor without the collision: DOMPurify keeps data-*
// untouched, and the reader looks anchors up by that name.
func IdsToAnchors(s string) string {
	var b strings.Builder
	last := 0
	for _, idx := range anchorIdRe.FindAllStringSubmatchIndex(s, -1) {
		ws, q1 := s[idx[2]:idx[3]], s[idx[4]:idx[5]]
		val, q2 := s[idx[6]:idx[7]], s[idx[8]:idx[9]]
		if q1 != q2 {
			continue
		}
		b.WriteString(s[last:idx[2]])
		b.WriteString(ws + `data-anc=` + q1 + val + q1)
		last = idx[1]
	}
	b.WriteString(s[last:])
	return b.String()
}

// CollectReferences returns the set of internal resource paths referenced by
// src/href/poster/data and xlink:href attributes in htmlStr.
func CollectReferences(htmlStr, fromFile string) []string {
	seen := map[string]bool{}
	add := func(val string) {
		if val == "" || isAbsURL(val) || strings.HasPrefix(val, "//") || strings.HasPrefix(val, "#") {
			return
		}
		seen[ResolveHref(fromFile, val)] = true
	}
	for _, idx := range urlAttrRe.FindAllStringSubmatchIndex(htmlStr, -1) {
		if htmlStr[idx[4]:idx[5]] != htmlStr[idx[8]:idx[9]] {
			continue
		}
		add(htmlStr[idx[6]:idx[7]])
	}
	for _, m := range svgHrefRe.FindAllStringSubmatch(htmlStr, -1) {
		add(m[1])
	}
	out := make([]string, 0, len(seen))
	for k := range seen {
		out = append(out, k)
	}
	return out
}

// CollectCssReferences returns the set of internal resources referenced by
// url(...) expressions in a CSS string.
func CollectCssReferences(css, fromFile string) []string {
	seen := map[string]bool{}
	for _, m := range cssUrlRe.FindAllStringSubmatch(css, -1) {
		val := m[1]
		if val == "" || isAbsURL(val) || strings.HasPrefix(val, "//") {
			continue
		}
		seen[ResolveHref(fromFile, val)] = true
	}
	out := make([]string, 0, len(seen))
	for k := range seen {
		out = append(out, k)
	}
	return out
}

func encodeURIComponent(s string) string {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		if (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') ||
			c == '-' || c == '_' || c == '.' || c == '!' || c == '~' || c == '*' || c == '\'' || c == '(' || c == ')' {
			b.WriteByte(c)
		} else {
			b.WriteString(fmt.Sprintf("%%%02X", c))
		}
	}
	return b.String()
}
