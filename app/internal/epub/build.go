package epub

import (
	"archive/zip"
	"compress/flate"
	"crypto/rand"
	"fmt"
	"io"
	"strings"
	"time"

	"epubmaker-desktop/internal/html"
	"epubmaker-desktop/internal/mime"
)

const (
	opfName  = "epubmaker.opf"
	navName  = "epubmaker-nav.xhtml"
	ncxName  = "epubmaker-toc.ncx"
	mimeType = "application/epub+zip"
)

// BuildChapter is one XHTML document in the output EPUB.
type BuildChapter struct {
	Title   string
	Href    string
	Content []byte
}

// BuildAsset is a non-document resource (image, css, font, …). Content is
// streamed so large files never have to be buffered fully in memory.
type BuildAsset struct {
	Href      string
	MediaType string
	Content   io.Reader
}

// BuildInput describes the EPUB to produce.
type BuildInput struct {
	Title       string
	Author      string
	Language    string
	Publisher   string
	Description string
	Identifier  string
	CoverHref   string // "" means no cover
	Chapters    []BuildChapter
	Assets      []BuildAsset
}

// makeIds assigns unique, safe XML ids to each href.
func makeIds(hrefs []string) map[string]string {
	out := map[string]string{}
	used := map[string]bool{}
	for _, href := range hrefs {
		base := "id_" + strings.NewReplacer("/", "_", ".", "_", ":", "_", "-", "_").Replace(href)
		base = strings.Trim(base, "_")
		if len(base) > 60 {
			base = base[len(base)-60:]
		}
		id := base
		n := 1
		for used[id] {
			id = fmt.Sprintf("%s_%d", base, n)
			n++
		}
		used[id] = true
		out[href] = id
	}
	return out
}

func buildNav(in BuildInput) string {
	var items strings.Builder
	for _, c := range in.Chapters {
		items.WriteString(fmt.Sprintf("      <li><a href=\"%s\">%s</a></li>\n",
			html.EscapeXml(html.EncodeHrefForURL(c.Href)), html.EscapeXml(orDefault(c.Title, "未命名章节"))))
	}
	return fmt.Sprintf(`<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="%[1]s" xml:lang="%[1]s">
<head>
  <meta charset="utf-8"/>
  <title>目录</title>
</head>
<body>
  <nav epub:type="toc" id="toc">
    <h1>目录</h1>
    <ol>
%[2]s    </ol>
  </nav>
</body>
</html>
`, html.EscapeXml(in.Language), items.String())
}

func buildNcx(in BuildInput, uid string) string {
	var points strings.Builder
	for i, c := range in.Chapters {
		points.WriteString(fmt.Sprintf("    <navPoint id=\"navPoint-%d\" playOrder=\"%d\">\n      <navLabel><text>%s</text></navLabel>\n      <content src=\"%s\"/>\n    </navPoint>\n",
			i+1, i+1, html.EscapeXml(orDefault(c.Title, "未命名章节")), html.EscapeXml(html.EncodeHrefForURL(c.Href))))
	}
	return fmt.Sprintf(`<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE ncx PUBLIC "-//NISO//DTD ncx 2005-1//EN" "http://www.daisy.org/z3986/2005/ncx-2005-1.dtd">
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head>
    <meta name="dtb:uid" content="%[1]s"/>
    <meta name="dtb:depth" content="1"/>
    <meta name="dtb:totalPageCount" content="0"/>
    <meta name="dtb:maxPageNumber" content="0"/>
  </head>
  <docTitle><text>%[2]s</text></docTitle>
  <navMap>
%[3]s  </navMap>
</ncx>
`, html.EscapeXml(uid), html.EscapeXml(in.Title), points.String())
}

func buildOpf(in BuildInput, uid string, ids map[string]string) string {
	modified := time.Now().UTC().Format("2006-01-02T15:04:05Z")

	var manifest strings.Builder
	manifest.WriteString(fmt.Sprintf("    <item id=\"nav\" href=\"%s\" media-type=\"application/xhtml+xml\" properties=\"nav\"/>\n", navName))
	manifest.WriteString(fmt.Sprintf("    <item id=\"ncx\" href=\"%s\" media-type=\"application/x-dtbncx+xml\"/>\n", ncxName))
	for _, c := range in.Chapters {
		manifest.WriteString(fmt.Sprintf("    <item id=\"%s\" href=\"%s\" media-type=\"application/xhtml+xml\"/>\n",
			ids[c.Href], html.EscapeXml(html.EncodeHrefForURL(c.Href))))
	}
	for _, a := range in.Assets {
		props := ""
		if in.CoverHref != "" && a.Href == in.CoverHref {
			props = " properties=\"cover-image\""
		}
		mt := a.MediaType
		if mt == "" {
			mt = mime.GuessMediaType(a.Href)
		}
		manifest.WriteString(fmt.Sprintf("    <item id=\"%s\" href=\"%s\" media-type=\"%s\"%s/>\n",
			ids[a.Href], html.EscapeXml(html.EncodeHrefForURL(a.Href)), html.EscapeXml(mt), props))
	}

	var spine strings.Builder
	for _, c := range in.Chapters {
		spine.WriteString(fmt.Sprintf("    <itemref idref=\"%s\"/>\n", ids[c.Href]))
	}

	coverMeta := ""
	if in.CoverHref != "" && ids[in.CoverHref] != "" {
		coverMeta = fmt.Sprintf("    <meta name=\"cover\" content=\"%s\"/>\n", ids[in.CoverHref])
	}

	var creator strings.Builder
	authors := splitAuthors(in.Author)
	for i, a := range authors {
		creator.WriteString(fmt.Sprintf("    <dc:creator id=\"creator%d\">%s</dc:creator>\n", i+1, html.EscapeXml(a)))
	}

	return fmt.Sprintf(`<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" xml:lang="%[1]s">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">%[2]s</dc:identifier>
    <dc:title>%[3]s</dc:title>
    <dc:language>%[4]s</dc:language>
%[5]s%[6]s%[7]s    <meta property="dcterms:modified">%[8]s</meta>
%[9]s    <meta name="generator" content="EpubMaker"/>
  </metadata>
  <manifest>
%[10]s  </manifest>
  <spine toc="ncx">
%[11]s  </spine>
</package>
`,
		html.EscapeXml(in.Language),
		html.EscapeXml(uid),
		html.EscapeXml(in.Title),
		html.EscapeXml(orDefault(in.Language, "zh")),
		creator.String(),
		ternary(in.Publisher != "", fmt.Sprintf("    <dc:publisher>%s</dc:publisher>\n", html.EscapeXml(in.Publisher)), ""),
		ternary(in.Description != "", fmt.Sprintf("    <dc:description>%s</dc:description>\n", html.EscapeXml(in.Description)), ""),
		modified,
		coverMeta,
		manifest.String(),
		spine.String(),
	)
}

func splitAuthors(s string) []string {
	var out []string
	for _, p := range strings.FieldsFunc(s, func(r rune) bool {
		return r == '、' || r == ',' || r == ';' || r == '；'
	}) {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}

func ternary(cond bool, a, b string) string {
	if cond {
		return a
	}
	return b
}

// BuildEpub writes a complete EPUB to w. The mimetype entry is stored first and
// uncompressed (red line), then the container, document chapters, assets, and
// the regenerated nav/ncx/opf. Assets are streamed from their readers so large
// images are not held in memory.
func BuildEpub(in BuildInput, w io.Writer) error {
	zw := zip.NewWriter(w)
	defer zw.Close()
	zw.RegisterCompressor(zip.Deflate, func(out io.Writer) (io.WriteCloser, error) {
		return flate.NewWriter(out, 6)
	})

	// 1. mimetype first, STORE (no compression) — EPUB OCF requirement.
	mh := &zip.FileHeader{Name: "mimetype", Method: zip.Store}
	mw, err := zw.CreateHeader(mh)
	if err != nil {
		return err
	}
	if _, err := mw.Write([]byte(mimeType)); err != nil {
		return err
	}

	// 2. META-INF/container.xml
	cw, err := zw.Create("META-INF/container.xml")
	if err != nil {
		return err
	}
	if _, err := cw.Write([]byte(fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="%s" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
`, opfName))); err != nil {
		return err
	}

	uid := strings.TrimSpace(in.Identifier)
	if uid == "" {
		uid = "urn:uuid:" + newUUID()
	}
	hrefs := make([]string, 0, len(in.Chapters)+len(in.Assets))
	for _, c := range in.Chapters {
		hrefs = append(hrefs, c.Href)
	}
	for _, a := range in.Assets {
		hrefs = append(hrefs, a.Href)
	}
	ids := makeIds(hrefs)

	// 3. chapters (document content, deflate)
	for _, c := range in.Chapters {
		fw, e := zw.Create(c.Href)
		if e != nil {
			return e
		}
		if _, e := fw.Write(c.Content); e != nil {
			return e
		}
	}

	// 4. assets (streamed)
	for _, a := range in.Assets {
		fw, e := zw.Create(a.Href)
		if e != nil {
			return e
		}
		if _, e := io.Copy(fw, a.Content); e != nil {
			return e
		}
		if rc, ok := a.Content.(io.Closer); ok {
			_ = rc.Close()
		}
	}

	// 5. nav / ncx / opf
	if _, err := writeStr(zw, navName, buildNav(in)); err != nil {
		return err
	}
	if _, err := writeStr(zw, ncxName, buildNcx(in, uid)); err != nil {
		return err
	}
	if _, err := writeStr(zw, opfName, buildOpf(in, uid, ids)); err != nil {
		return err
	}
	return nil
}

func writeStr(zw *zip.Writer, name, content string) (int, error) {
	fw, err := zw.Create(name)
	if err != nil {
		return 0, err
	}
	return fw.Write([]byte(content))
}

func newUUID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return fmt.Sprintf("uuid-%d", time.Now().UnixNano())
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}
