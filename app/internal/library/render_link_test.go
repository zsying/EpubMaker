package library

import (
	"strings"
	"testing"

	"epubmaker-desktop/internal/html"
	"epubmaker-desktop/internal/storage"
)

var linkPNG = []byte{0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52}

func setupLinkBook(t *testing.T) {
	t.Helper()
	resetLibraryTables(t)
	insertBookRow(t, "lb", "链接测试")
	insertChapterRow(t, "lb", "c1", 0)
	insertChapterRow(t, "lb", "c2", 1)
	body := `<p id="top">顶</p>
<p><a href="chc2.xhtml#n1">注1</a> <a href="#top">回顶</a> <a href="https://example.com">外链</a></p>
<p><img src="pic.png" alt="图"/></p>`
	if err := storage.WriteContent("lb", "chc1.xhtml", []byte(html.WrapDocument("一", body))); err != nil {
		t.Fatal(err)
	}
	if err := storage.WriteContent("lb", "chc2.xhtml", []byte(html.WrapDocument("二", "<p>二</p>"))); err != nil {
		t.Fatal(err)
	}
	if err := storage.WriteContent("lb", "pic.png", linkPNG); err != nil {
		t.Fatal(err)
	}
}

// A chapter used to inline the link target as a data URL. DOMPurify removes a
// data: href from <a> (DATA_URI_TAGS has no `a`), so the attribute vanished and
// every footnote and cross-chapter link in every book did nothing when tapped.
// The rendered chapter must carry a destination instead, and a real image must
// still be inlined.
func TestRenderChapterTurnsLinksIntoDestinations(t *testing.T) {
	setupLinkBook(t)

	got, err := RenderChapter("lb", "c1")
	if err != nil {
		t.Fatalf("render: %v", err)
	}

	for _, want := range []string{
		`data-doc-href="chc2.xhtml#n1"`,
		`data-doc-href="#top"`,
		`data-doc-href="https://example.com"`,
	} {
		if !strings.Contains(got.HTML, want) {
			t.Errorf("rendered chapter is missing %s\n%s", want, got.HTML)
		}
	}
	if strings.Contains(got.HTML, "application/xhtml") {
		t.Errorf("an XHTML document was inlined as a resource:\n%s", got.HTML)
	}
	if strings.Contains(got.HTML, ` href="`) {
		t.Errorf("a href survived and would navigate the webview away:\n%s", got.HTML)
	}

	// Images are resources, not destinations: they must still be inlined.
	if !strings.Contains(got.HTML, `src="data:image/png;base64,`) {
		t.Errorf("the image was not inlined:\n%s", got.HTML)
	}
}

// The anchors a same-document link points at must exist as data-anc, otherwise
// the reader has the destination but nothing to scroll to.
func TestRenderChapterKeepsTheAnchorALinkPointsAt(t *testing.T) {
	setupLinkBook(t)

	got, err := RenderChapter("lb", "c1")
	if err != nil {
		t.Fatalf("render: %v", err)
	}
	if !strings.Contains(got.HTML, `data-anc="top"`) {
		t.Errorf("the anchor target was not renamed:\n%s", got.HTML)
	}
}
