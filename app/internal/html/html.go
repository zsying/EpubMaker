// Package html holds tiny HTML helpers needed by the book/chapter logic:
// extract/replace the <body>, wrap content into a minimal XHTML document, and
// encode an href for use inside a URL. These mirror server/src/epub/html.ts
// for the subset used outside the full EPUB render/export engine.
package html

import (
	"fmt"
	"regexp"
	"strings"
)

var bodyRe = regexp.MustCompile(`(?is)(<body[^>]*>)(.*?)(</body>)`)

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
