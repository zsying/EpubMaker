package html

import "testing"

// The reader purifies chapter HTML with DOMPurify, which forbids `id` so an epub
// cannot hijack the host page's own element ids. TOC anchors are ids, so they
// are renamed before the HTML ever leaves Go — otherwise every nav entry that
// points inside a document lands on the top of that document.
func TestIdsToAnchors(t *testing.T) {
	cases := []struct{ in, want string }{
		{`<p id="filepos109">正文</p>`, `<p data-anc="filepos109">正文</p>`},
		{`<a id='x1'/>`, `<a data-anc='x1'/>`},
		{`<p>没有锚点</p>`, `<p>没有锚点</p>`},
		// Not ids: data-id and xml:id keep their names, or the rewrite would
		// invent anchors from attributes that were never link targets.
		{`<p data-id="keep" xml:id="also">t</p>`, `<p data-id="keep" xml:id="also">t</p>`},
		// An empty id is not an anchor target.
		{`<p id="">t</p>`, `<p id="">t</p>`},
		// Two on one line, and text between them.
		{`<p id="a">一</p><p id="b">二</p>`, `<p data-anc="a">一</p><p data-anc="b">二</p>`},
	}
	for _, c := range cases {
		if got := IdsToAnchors(c.in); got != c.want {
			t.Errorf("IdsToAnchors(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}
