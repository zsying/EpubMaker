package library

// Shelf thumbnails.
//
// The book list used to carry every cover inline: a 40-book shelf meant 16 MB
// of base64 in one JSON answer, and the WebView had to write twelve ~400 KB
// data URLs into <img src> on every visit to the shelf — measured on the phone
// as 866 ms of setAttribute plus a 1.2 s frozen frame, i.e. the "delay" the
// reader sees when they come back from a book. The cards draw at ~120×170 CSS
// px; nothing on the shelf ever needed the full-size image.
//
// So each cover gets a small JPEG sibling (320×480, quality 82 — about 20 KB)
// that the list ships instead. It is generated once, next to the cover inside
// the book's content directory, so it travels with a backup and is never
// recomputed on a later visit.

import (
	"bytes"
	"image"
	"image/jpeg"
	"math"
	"sync"

	// Registered decoders: covers in EPUBs are almost always JPEG or PNG, GIF
	// shows up in older books. Anything else (WEBP, AVIF, SVG) is not decodable
	// with the standard library — those keep using the original cover, which is
	// the old behaviour for a handful of books rather than a broken shelf.
	_ "image/gif"
	_ "image/png"

	"epubmaker-desktop/internal/storage"
)

const (
	// The card is ~120×170 CSS px on a phone and ~160×230 on a desktop; 320×480
	// covers both at 2× density without shipping pixels nobody can see.
	thumbMaxW = 320
	thumbMaxH = 480
	// 82 is the knee of the JPEG curve for pictures this small: visually
	// identical to the source at card size, a fifth of the bytes of 95.
	thumbQuality = 82
	thumbSuffix  = ".thumb.jpg"
	thumbMime    = "image/jpeg"
)

// thumbHref is the cover's own href plus a suffix, so both files sit side by
// side under the book's content dir (and a deleted book takes them together).
func thumbHref(coverHref string) string { return coverHref + thumbSuffix }

// A cover that cannot be decoded will never become decodable; remembering the
// failure keeps the shelf from re-attempting a WEBP decode on every visit.
var thumbFailed sync.Map // href -> struct{}

// thumbWarm guards the one background pass that fills in thumbnails for books
// imported before thumbnails existed.
var thumbWarm sync.Once

// readThumb returns the stored preview, never generating one. The shelf uses
// this: a page load must not be able to turn into an image-conversion job.
func readThumb(bookID, coverHref string) ([]byte, bool) {
	if coverHref == "" {
		return nil, false
	}
	b, err := storage.ReadContent(bookID, thumbHref(coverHref))
	if err != nil || len(b) == 0 {
		return nil, false
	}
	return b, true
}

// thumbFor returns the small JPEG for a cover, generating it on first use.
// ok=false means "no thumbnail is possible", and the caller falls back to the
// original cover.
func thumbFor(bookID, coverHref string) ([]byte, bool) {
	if coverHref == "" {
		return nil, false
	}
	if b, ok := readThumb(bookID, coverHref); ok {
		return b, true
	}
	if _, bad := thumbFailed.Load(coverHref); bad {
		return nil, false
	}
	raw, err := storage.ReadContent(bookID, coverHref)
	if err != nil {
		return nil, false
	}
	out, err := writeThumb(bookID, coverHref, raw)
	if err != nil {
		thumbFailed.Store(coverHref, struct{}{})
		return nil, false
	}
	return out, true
}

// writeThumb builds and stores the thumbnail. Errors are the caller's signal to
// use the original cover; a failed preview must never fail the book itself.
func writeThumb(bookID, coverHref string, src []byte) ([]byte, error) {
	img, _, err := image.Decode(bytes.NewReader(src))
	if err != nil {
		return nil, err
	}
	small := downscale(img, thumbMaxW, thumbMaxH)
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, small, &jpeg.Options{Quality: thumbQuality}); err != nil {
		return nil, err
	}
	out := buf.Bytes()
	if err := storage.WriteContent(bookID, thumbHref(coverHref), out); err != nil {
		return nil, err
	}
	return out, nil
}

// warmThumb generates the thumbnail ahead of time — at import and on a cover
// change — so the first visit to the shelf after adding a book is already fast.
func warmThumb(bookID, coverHref string) {
	_, _ = thumbFor(bookID, coverHref)
}

// downscale shrinks img to fit inside maxW×maxH with a box filter: every
// destination pixel is the average of the source pixels it covers, which is
// what keeps a text-heavy cover from turning into noise. Nearest-neighbour
// would be faster and visibly worse at this ratio.
//
// The averaging window is precomputed per column/row, so the inner loop is
// plain integer work over the source — a few million samples for a 1200×1800
// cover, tens of milliseconds.
func downscale(src image.Image, maxW, maxH int) image.Image {
	b := src.Bounds()
	sw, sh := b.Dx(), b.Dy()
	if sw <= 0 || sh <= 0 {
		return src
	}
	scale := math.Min(float64(maxW)/float64(sw), float64(maxH)/float64(sh))
	if scale >= 1 {
		return src // already smaller than the card will ever draw it
	}
	dw := int(math.Round(float64(sw) * scale))
	dh := int(math.Round(float64(sh) * scale))
	if dw < 1 {
		dw = 1
	}
	if dh < 1 {
		dh = 1
	}

	x0 := make([]int, dw+1)
	for x := 0; x <= dw; x++ {
		x0[x] = b.Min.X + x*sw/dw
	}
	y0 := make([]int, dh+1)
	for y := 0; y <= dh; y++ {
		y0[y] = b.Min.Y + y*sh/dh
	}

	dst := image.NewRGBA(image.Rect(0, 0, dw, dh))
	for y := 0; y < dh; y++ {
		sy0, sy1 := y0[y], y0[y+1]
		if sy1 <= sy0 {
			sy1 = sy0 + 1
		}
		for x := 0; x < dw; x++ {
			sx0, sx1 := x0[x], x0[x+1]
			if sx1 <= sx0 {
				sx1 = sx0 + 1
			}
			var r, g, bl, a uint64
			var n uint64
			for sy := sy0; sy < sy1; sy++ {
				for sx := sx0; sx < sx1; sx++ {
					cr, cg, cb, ca := src.At(sx, sy).RGBA()
					r += uint64(cr)
					g += uint64(cg)
					bl += uint64(cb)
					a += uint64(ca)
					n++
				}
			}
			if n == 0 {
				continue
			}
			i := dst.PixOffset(x, y)
			dst.Pix[i+0] = uint8(r / n >> 8)
			dst.Pix[i+1] = uint8(g / n >> 8)
			dst.Pix[i+2] = uint8(bl / n >> 8)
			dst.Pix[i+3] = uint8(a / n >> 8)
		}
	}
	return dst
}
