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
