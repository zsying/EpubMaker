package library

import (
	"bytes"
	"database/sql"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"testing"
	"time"

	"epubmaker-desktop/internal/storage"
)

func nullStrFor(s string) sql.NullString { return sql.NullString{String: s, Valid: true} }

func imgFrom(t *testing.T, raw []byte) image.Image {
	t.Helper()
	img, err := png.Decode(bytes.NewReader(raw))
	if err != nil {
		t.Fatalf("decode png: %v", err)
	}
	return img
}

func writeCoverFile(t *testing.T, book, href string, data []byte) error {
	t.Helper()
	return storage.WriteContent(book, href, data)
}

// A cover big enough that shipping it whole is what made the shelf slow: a
// 1200×1800 jacket is typical for an EPUB (and ~400 KB once base64'd).
func bigCover(t *testing.T) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, 1200, 1800))
	for y := 0; y < 1800; y++ {
		for x := 0; x < 1200; x++ {
			var c color.RGBA
			if x < 600 {
				c = color.RGBA{R: 200, G: 40, B: 40, A: 255}
			} else {
				c = color.RGBA{R: 40, G: 60, B: 200, A: 255}
			}
			img.SetRGBA(x, y, c)
		}
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatalf("encode: %v", err)
	}
	return buf.Bytes()
}

func decodeJPEG(t *testing.T, raw []byte) image.Image {
	t.Helper()
	img, err := jpeg.Decode(bytes.NewReader(raw))
	if err != nil {
		t.Fatalf("the thumbnail is not a decodable JPEG: %v", err)
	}
	return img
}

// The preview has to fit the card it is drawn in, and keep its aspect ratio.
func TestThumbnailFitsTheCard(t *testing.T) {
	small := downscale(imgFrom(t, bigCover(t)), thumbMaxW, thumbMaxH)
	b := small.Bounds()
	if b.Dx() != 320 || b.Dy() != 480 {
		t.Errorf("size = %dx%d, want 320x480 (a 2:3 cover at 320 wide)", b.Dx(), b.Dy())
	}

	// A cover that is already small enough is not enlarged.
	tiny := image.NewRGBA(image.Rect(0, 0, 100, 150))
	if got := downscale(tiny, thumbMaxW, thumbMaxH).Bounds(); got.Dx() != 100 {
		t.Errorf("a small cover was resized to %v", got)
	}
}

// A box filter, not nearest-neighbour: the left half stays red and the right
// half stays blue instead of one pixel's colour smearing across the card.
func TestThumbnailKeepsTheColoursWhereTheyWere(t *testing.T) {
	small := downscale(imgFrom(t, bigCover(t)), thumbMaxW, thumbMaxH)
	b := small.Bounds()
	for _, probe := range []struct {
		x, y     int
		r, g, bl uint8
		name     string
	}{
		{b.Min.X + b.Dx()/4, b.Min.Y + b.Dy()/2, 200, 40, 40, "left"},
		{b.Min.X + b.Dx()*3/4, b.Min.Y + b.Dy()/2, 40, 60, 200, "right"},
	} {
		r, g, bl, _ := small.At(probe.x, probe.y).RGBA()
		if d := diff(uint8(r>>8), probe.r); d > 6 {
			t.Errorf("%s half: red = %d, want ~%d", probe.name, uint8(r>>8), probe.r)
		}
		if d := diff(uint8(g>>8), probe.g); d > 6 {
			t.Errorf("%s half: green = %d, want ~%d", probe.name, uint8(g>>8), probe.g)
		}
		if d := diff(uint8(bl>>8), probe.bl); d > 6 {
			t.Errorf("%s half: blue = %d, want ~%d", probe.name, uint8(bl>>8), probe.bl)
		}
	}
}

// The whole point: a shelf-sized answer. A full cover is ~400 KB of base64;
// the preview has to be an order of magnitude smaller or nothing improved.
func TestThumbnailIsAnOrderOfMagnitudeSmaller(t *testing.T) {
	cover := bigCover(t)
	start := time.Now()
	thumb, err := writeThumb("book-thumb-test", "covers/cover.png", cover)
	elapsed := time.Since(start)
	if err != nil {
		t.Fatalf("writeThumb: %v", err)
	}
	if len(thumb) >= len(cover)/8 {
		t.Errorf("thumbnail is %d bytes against a %d byte cover — not a thumbnail", len(thumb), len(cover))
	}
	if b := decodeJPEG(t, thumb).Bounds(); b.Dx() > thumbMaxW || b.Dy() > thumbMaxH {
		t.Errorf("stored thumbnail is %dx%d, above the cap", b.Dx(), b.Dy())
	}
	// Reported, not asserted: this runs once per book, at import time.
	t.Logf("1200x1800 cover → %d byte thumbnail in %v", len(thumb), elapsed.Round(time.Millisecond))
}

// Reading it back must not re-encode: the second call is served from disk.
func TestThumbnailIsReusedFromDisk(t *testing.T) {
	cover := bigCover(t)
	if _, err := writeThumb("book-thumb-reuse", "covers/c.png", cover); err != nil {
		t.Fatalf("writeThumb: %v", err)
	}
	first, ok := thumbFor("book-thumb-reuse", "covers/c.png")
	if !ok {
		t.Fatal("thumbFor did not find the thumbnail it just wrote")
	}
	second, ok := thumbFor("book-thumb-reuse", "covers/c.png")
	if !ok || !bytes.Equal(first, second) {
		t.Error("the second read returned different bytes")
	}
}

// A format the standard library cannot decode (WEBP, AVIF) or a corrupt file
// must keep working the old way rather than dropping the cover.
func TestUndecodableCoverFallsBackToTheOriginal(t *testing.T) {
	book := "book-thumb-bad"
	if err := writeCoverFile(t, book, "covers/bad.png", []byte("not an image")); err != nil {
		t.Fatalf("write: %v", err)
	}
	if _, ok := thumbFor(book, "covers/bad.png"); ok {
		t.Fatal("thumbFor claimed a thumbnail for a non-image")
	}

	href := "covers/bad.png"
	dto := toBookListDTO(BookRow{ID: book, Title: "坏封面", CoverHref: nullStrFor(href)}, 1)
	if dto.ThumbURL != nil {
		t.Error("ThumbURL is set for an undecodable cover")
	}
	if dto.CoverURL == nil {
		t.Error("the shelf lost the cover entirely; it should fall back to the original")
	}
}

// The list answer must not carry a full cover when a thumbnail exists — that
// is the whole fix. The single-book answer keeps both, for the editor.
func TestListAnswerShipsOnlyTheThumbnail(t *testing.T) {
	book := "book-thumb-list"
	cover := bigCover(t)
	if err := writeCoverFile(t, book, "covers/l.png", cover); err != nil {
		t.Fatalf("write: %v", err)
	}
	// Nothing written yet → generated now.
	if _, ok := thumbFor(book, "covers/l.png"); !ok {
		t.Fatal("no thumbnail")
	}

	row := BookRow{ID: book, Title: "书架上的书", CoverHref: nullStrFor("covers/l.png")}
	list := toBookListDTO(row, 3)
	if list.ThumbURL == nil {
		t.Fatal("the shelf answer has no thumbnail")
	}
	if list.CoverURL != nil {
		t.Error("the shelf answer still carries the full cover")
	}
	if len(*list.ThumbURL) > len(cover) {
		t.Errorf("thumb data URL is %d chars, larger than the source", len(*list.ThumbURL))
	}

	single := toBookDTO(row, 3)
	if single.CoverURL == nil || single.ThumbURL == nil {
		t.Error("the single-book answer must carry both sizes for the editor")
	}
}

func diff(a, b uint8) int {
	if a > b {
		return int(a - b)
	}
	return int(b - a)
}
