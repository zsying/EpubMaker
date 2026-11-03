package epub

import (
	"bytes"
	"encoding/base64"
	"errors"
	"io"
	"math/rand"
	"testing"
)

// bigChapter is deliberately larger than flate's 32 KiB window and made of
// incompressible bytes (base64 of a fixed pseudo-random stream). A small
// chapter leaves everything buffered until Close, so the whole archive reaches
// the writer in one Write and "fail on the last byte" cannot target the central
// directory specifically. A big one forces several writes, with the central
// directory in the final one.
func bigChapter() []byte {
	raw := make([]byte, 64*1024)
	rand.New(rand.NewSource(1)).Read(raw)

	var b bytes.Buffer
	b.WriteString(`<html xmlns="http://www.w3.org/1999/xhtml"><head><title>第一章</title></head><body><h1>第一章</h1><p>`)
	b.WriteString(base64.StdEncoding.EncodeToString(raw))
	b.WriteString(`</p></body></html>`)
	return b.Bytes()
}

// countingWriter just totals the bytes so a later run knows exactly how long
// a complete archive is.
type countingWriter int

func (c *countingWriter) Write(p []byte) (int, error) {
	*c += countingWriter(len(p))
	return len(p), nil
}

// failPast accepts the first limit bytes and then refuses everything. Setting
// the limit one byte short of a complete archive makes the final write — the
// zip central directory — the one that fails.
type failPast struct {
	limit int
	n     int
}

func (f *failPast) Write(p []byte) (int, error) {
	if f.n+len(p) > f.limit {
		return 0, errors.New("disk full")
	}
	f.n += len(p)
	return len(p), nil
}

// trackedReader is an asset source that counts how often it is closed.
type trackedReader struct {
	r      io.Reader
	closed *int
}

func (t *trackedReader) Read(p []byte) (int, error) { return t.r.Read(p) }
func (t *trackedReader) Close() error {
	*t.closed++
	return nil
}

func sampleInput() BuildInput {
	return BuildInput{
		Title:      "测试书",
		Author:     "作者A",
		Language:   "zh",
		Identifier: "urn:uuid:00000000-0000-4000-8000-000000000000",
		Chapters: []BuildChapter{
			{
				Title:   "第一章",
				Href:    "OEBPS/ch1.xhtml",
				Content: bigChapter(),
			},
		},
		Assets: []BuildAsset{
			{Href: "images/cover.png", MediaType: "image/png", Content: bytes.NewReader(minimalPNG)},
		},
	}
}

// zip.Writer.Close writes the central directory. Its error used to be dropped by
// a bare `defer zw.Close()`, so a full disk produced a truncated archive that
// the app reported as a successful export. The file opened fine in some
// readers and was simply missing chapters in others — the worst kind of
// failure, because it looks like data loss after the fact.
func TestBuildEpubReportsACentralDirectoryFailure(t *testing.T) {
	var full countingWriter
	if err := BuildEpub(sampleInput(), &full); err != nil {
		t.Fatalf("baseline build: %v", err)
	}

	w := &failPast{limit: int(full) - 1}
	err := BuildEpub(sampleInput(), w)
	if err == nil {
		t.Fatal("a truncated archive must not be reported as success")
	}
	if w.n == 0 {
		t.Fatal("the test writer never received anything; the case is not exercising Close")
	}
}

// Assets arrive already opened by the caller, so every one of them must be
// closed even when the copy in the middle fails. Leaking *os.File keeps the
// book directory locked on Windows: the reader shows "file in use" until the
// process exits, and a second export fails the same way.
func TestBuildEpubClosesEveryAssetEvenOnFailure(t *testing.T) {
	closed := 0
	boom := errors.New("read error")
	in := sampleInput()
	in.Assets = []BuildAsset{
		{Href: "images/a.png", MediaType: "image/png", Content: &trackedReader{r: bytes.NewReader(minimalPNG), closed: &closed}},
		{Href: "images/b.png", MediaType: "image/png", Content: &trackedReader{r: iotestFail{}, closed: &closed}},
		{Href: "images/c.png", MediaType: "image/png", Content: &trackedReader{r: bytes.NewReader(minimalPNG), closed: &closed}},
	}

	err := BuildEpub(in, io.Discard)
	if err == nil {
		t.Fatalf("the failing reader should have surfaced; boom=%v", boom)
	}
	if closed != len(in.Assets) {
		t.Errorf("closed %d of %d assets; the rest leak a file handle", closed, len(in.Assets))
	}
}

// On the happy path the closers must still run — the caller hands ownership
// over and never sees the readers again.
func TestBuildEpubClosesAssetsOnSuccess(t *testing.T) {
	closed := 0
	in := sampleInput()
	in.Assets = []BuildAsset{
		{Href: "images/a.png", MediaType: "image/png", Content: &trackedReader{r: bytes.NewReader(minimalPNG), closed: &closed}},
	}
	if err := BuildEpub(in, io.Discard); err != nil {
		t.Fatal(err)
	}
	if closed != 1 {
		t.Errorf("closed = %d, want 1", closed)
	}
}

type iotestFail struct{}

func (iotestFail) Read([]byte) (int, error) { return 0, errors.New("read error") }
