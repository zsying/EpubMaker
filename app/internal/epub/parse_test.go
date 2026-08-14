package epub

import (
	"bytes"
	"os"
	"testing"
)

// minimalPNG is a tiny but syntactically valid PNG header; content is not
// actually rendered in tests.
var minimalPNG = []byte{0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52}

func buildSampleEpub(t *testing.T) []byte {
	t.Helper()
	var buf bytes.Buffer
	input := BuildInput{
		Title:    "测试书",
		Author:   "作者A",
		Language: "zh",
		Chapters: []BuildChapter{
			{
				Title:   "第一章",
				Href:    "OEBPS/ch1.xhtml",
				Content: []byte(`<html xmlns="http://www.w3.org/1999/xhtml"><head><title>第一章</title></head><body><h1>第一章</h1><p>正文</p></body></html>`),
			},
		},
		Assets: []BuildAsset{
			{Href: "images/cover.png", MediaType: "image/png", Content: bytes.NewReader(minimalPNG)},
		},
	}
	if err := BuildEpub(input, &buf); err != nil {
		t.Fatalf("build sample epub: %v", err)
	}
	return buf.Bytes()
}

func TestParseEpub(t *testing.T) {
	data := buildSampleEpub(t)
	parsed, err := ParseEpub(data)
	if err != nil {
		t.Fatalf("parse epub: %v", err)
	}
	if parsed.Metadata.Title != "测试书" {
		t.Errorf("title=%q, want 测试书", parsed.Metadata.Title)
	}
	if parsed.Metadata.Author != "作者A" {
		t.Errorf("author=%q, want 作者A", parsed.Metadata.Author)
	}
	if len(parsed.Spine) != 1 {
		t.Errorf("spine=%d, want 1", len(parsed.Spine))
	}
}

func TestParseEpubInvalid(t *testing.T) {
	_, err := ParseEpub([]byte("this is not an epub"))
	if err == nil {
		t.Fatal("expected error for non-zip input")
	}
	if !bytes.Contains([]byte(err.Error()), []byte("文件头不是 ZIP")) {
		t.Errorf("error should mention zip header, got: %v", err)
	}
}

func TestParseEpubEmpty(t *testing.T) {
	_, err := ParseEpub([]byte{})
	if err == nil {
		t.Fatal("expected error for empty input")
	}
}

func TestParseEpubLeadingJunk(t *testing.T) {
	data := buildSampleEpub(t)
	// Simulate a downloader stub / BOM placed before the actual ZIP.
	prefixed := append([]byte("\xef\xbb\xbf<!-- stub -->\r\n"), data...)
	parsed, err := ParseEpub(prefixed)
	if err != nil {
		t.Fatalf("parse epub with leading junk: %v", err)
	}
	if parsed.Metadata.Title != "测试书" {
		t.Errorf("title=%q, want 测试书", parsed.Metadata.Title)
	}
}

func TestParseEpubFile(t *testing.T) {
	data := buildSampleEpub(t)
	tmp := t.TempDir() + "/sample.epub"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		t.Fatalf("write temp epub: %v", err)
	}
	parsed, err := ParseEpubFile(tmp)
	if err != nil {
		t.Fatalf("parse epub file: %v", err)
	}
	if parsed.Metadata.Title != "测试书" {
		t.Errorf("title=%q, want 测试书", parsed.Metadata.Title)
	}
}

// TestParseNcxHierarchy verifies NCX <navPoint> nesting is preserved.
func TestParseNcxHierarchy(t *testing.T) {
	xmlStr := `<?xml version="1.0"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/">
  <navMap>
    <navPoint id="np1" playOrder="1">
      <navLabel><text>第一章</text></navLabel>
      <content src="ch1.xhtml"/>
      <navPoint id="np1a" playOrder="2">
        <navLabel><text>第一节</text></navLabel>
        <content src="ch1.xhtml#s1"/>
      </navPoint>
      <navPoint id="np1b" playOrder="3">
        <navLabel><text>第二节</text></navLabel>
        <content src="ch1.xhtml#s2"/>
      </navPoint>
    </navPoint>
    <navPoint id="np2" playOrder="4">
      <navLabel><text>第二章</text></navLabel>
      <content src="ch2.xhtml"/>
    </navPoint>
  </navMap>
</ncx>`
	root, err := parseXMLTree([]byte(xmlStr))
	if err != nil {
		t.Fatalf("parse xml: %v", err)
	}
	list := parseNcxTree(root, "OEBPS/toc.ncx")
	if len(list) != 2 {
		t.Fatalf("top-level entries=%d, want 2", len(list))
	}
	if list[0].Title != "第一章" || list[0].Href != "OEBPS/ch1.xhtml" {
		t.Errorf("entry0=%+v", list[0])
	}
	if len(list[0].Children) != 2 {
		t.Fatalf("entry0 children=%d, want 2", len(list[0].Children))
	}
	if list[0].Children[0].Title != "第一节" || list[0].Children[0].Href != "OEBPS/ch1.xhtml#s1" {
		t.Errorf("child0=%+v", list[0].Children[0])
	}
	// NCX content/@src keeps its fragment; ResolveHref only resolves the base.
	if list[0].Children[1].Href != "OEBPS/ch1.xhtml#s2" {
		t.Errorf("child1 href=%q", list[0].Children[1].Href)
	}
	if list[1].Title != "第二章" || list[1].Href != "OEBPS/ch2.xhtml" {
		t.Errorf("entry1=%+v", list[1])
	}
}

// TestParseNavHierarchy verifies EPUB3 nav <ol><li> nesting is preserved,
// including <span> parent nodes that group children without a link.
func TestParseNavHierarchy(t *testing.T) {
	xmlStr := `<?xml version="1.0"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<body>
  <nav epub:type="toc" id="toc">
    <ol>
      <li><a href="ch1.xhtml">第一章</a>
        <ol>
          <li><a href="ch1.xhtml#s1">第一节</a></li>
          <li><a href="ch1.xhtml#s2">第二节</a></li>
        </ol>
      </li>
      <li><span>附录</span>
        <ol>
          <li><a href="appendix.xhtml">完整附录</a></li>
        </ol>
      </li>
    </ol>
  </nav>
</body>
</html>`
	root, err := parseXMLTree([]byte(xmlStr))
	if err != nil {
		t.Fatalf("parse xml: %v", err)
	}
	list := parseNavTree(root, "OEBPS/nav.xhtml")
	if len(list) != 2 {
		t.Fatalf("top-level entries=%d, want 2", len(list))
	}
	if list[0].Title != "第一章" || list[0].Href != "OEBPS/ch1.xhtml" {
		t.Errorf("entry0=%+v", list[0])
	}
	if len(list[0].Children) != 2 {
		t.Fatalf("entry0 children=%d, want 2", len(list[0].Children))
	}
	if list[0].Children[1].Title != "第二节" {
		t.Errorf("child1=%+v", list[0].Children[1])
	}
	// span parent has no href (it only groups children) but still nests them.
	if list[1].Href != "" {
		t.Errorf("span parent href=%q, want empty", list[1].Href)
	}
	if len(list[1].Children) != 1 || list[1].Children[0].Title != "完整附录" || list[1].Children[0].Href != "OEBPS/appendix.xhtml" {
		t.Errorf("appendix group=%+v", list[1].Children)
	}
}
