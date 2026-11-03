package html

import "testing"

// Chapter links must not be inlined as data URLs: DOMPurify drops a data: href
// from <a> (it is not in DATA_URI_TAGS), so every footnote and cross-chapter
// link in every book silently stopped doing anything. href is not a resource to
// embed — it is a destination the reader resolves itself.
func TestDocLinksToData(t *testing.T) {
	cases := []struct{ name, in, want string }{
		{
			"cross-document link is resolved against the current chapter",
			`<p><a href="../text/ch2.xhtml#n1">注1</a></p>`,
			`<p><a data-doc-href="text/ch2.xhtml#n1">注1</a></p>`,
		},
		{
			"same-document anchor keeps its fragment",
			`<p><a href="#n2">注2</a></p>`,
			`<p><a data-doc-href="#n2">注2</a></p>`,
		},
		{
			"an external URL is left as a destination we do not own",
			`<p><a href="https://example.com/x">外链</a></p>`,
			`<p><a data-doc-href="https://example.com/x">外链</a></p>`,
		},
		{
			"single quotes survive",
			`<a href='../text/ch3.xhtml'>三</a>`,
			`<a data-doc-href='text/ch3.xhtml'>三</a>`,
		},
		{
			"an anchor with other attributes keeps them",
			`<a class="noteref" href="notes.xhtml#n1" id="r1">1</a>`,
			`<a class="noteref" data-doc-href="text/notes.xhtml#n1" id="r1">1</a>`,
		},
		{
			// SVG <image href> is a real resource and must stay inlineable.
			"svg href is not a document link",
			`<svg><image href="images/bg.png"/></svg>`,
			`<svg><image href="images/bg.png"/></svg>`,
		},
		{
			"anchor without href is untouched",
			`<a name="top">顶</a>`,
			`<a name="top">顶</a>`,
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := DocLinksToData(c.in, "text/ch1.xhtml"); got != c.want {
				t.Errorf("DocLinksToData(%q)\n got  %q\n want %q", c.in, got, c.want)
			}
		})
	}
}

// The resource rewriter must stop claiming href: it inlined a whole XHTML
// document as a data URL, which is both useless (nothing displays it) and
// broken (the purifier then removes the attribute).
func TestRewriteResourceUrlsLeavesAnchorsAlone(t *testing.T) {
	in := `<p><a href="../text/ch2.xhtml#n1">注</a><img src="a.png"/></p>`
	got := RewriteResourceUrls(in, "text/ch1.xhtml", func(string) string { return "data:image/png;base64,AAAA" })
	want := `<p><a href="../text/ch2.xhtml#n1">注</a><img src="data:image/png;base64,AAAA"/></p>`
	if got != want {
		t.Errorf("got  %q\nwant %q", got, want)
	}
}
