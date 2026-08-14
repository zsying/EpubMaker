package library

import (
	"reflect"
	"testing"

	"epubmaker-desktop/internal/epub"
)

// pickSet builds a lookup keyed by document href (fragment stripped), matching
// how SplitBook keys picked chapters.
func pickSet(hrefs ...string) map[string]bool {
	m := map[string]bool{}
	for _, h := range hrefs {
		m[stripFragment(h)] = true
	}
	return m
}

func TestFilterTOCTree_PickedDocKeepsSubAnchors(t *testing.T) {
	toc := []epub.TOCEntry{
		{
			Href:  "OEBPS/ch1.xhtml",
			Title: "第一章",
			Children: []epub.TOCEntry{
				{Href: "OEBPS/ch1.xhtml#s1", Title: "第一节"},
				{Href: "OEBPS/ch1.xhtml#s2", Title: "第二节"},
			},
		},
		{Href: "OEBPS/ch2.xhtml", Title: "第二章"},
	}
	got := filterTOCTree(toc, pickSet("OEBPS/ch1.xhtml"))
	if len(got) != 1 {
		t.Fatalf("expected 1 top node, got %d", len(got))
	}
	if got[0].Href != "OEBPS/ch1.xhtml" {
		t.Fatalf("unexpected top href %q", got[0].Href)
	}
	if len(got[0].Children) != 2 {
		t.Fatalf("expected both sub-anchors kept, got %d", len(got[0].Children))
	}
	if got[0].Children[0].Href != "OEBPS/ch1.xhtml#s1" {
		t.Fatalf("sub-anchor href lost fragment: %q", got[0].Children[0].Href)
	}
}

func TestFilterTOCTree_DropsUnpickedDoc(t *testing.T) {
	toc := []epub.TOCEntry{
		{Href: "OEBPS/ch1.xhtml", Title: "第一章"},
		{Href: "OEBPS/ch2.xhtml", Title: "第二章"},
	}
	got := filterTOCTree(toc, pickSet("OEBPS/ch1.xhtml"))
	if len(got) != 1 || got[0].Href != "OEBPS/ch1.xhtml" {
		t.Fatalf("expected only ch1 kept, got %+v", got)
	}
}

func TestFilterTOCTree_GroupKeepsOnlyPickedChildren(t *testing.T) {
	toc := []epub.TOCEntry{
		{
			// EPUB3 nav <span> group: no href, groups child chapters.
			Title: "附录",
			Children: []epub.TOCEntry{
				{Href: "OEBPS/appendix-a.xhtml", Title: "附录A"},
				{Href: "OEBPS/appendix-b.xhtml", Title: "附录B"},
			},
		},
	}
	got := filterTOCTree(toc, pickSet("OEBPS/appendix-b.xhtml"))
	if len(got) != 1 {
		t.Fatalf("expected group kept, got %d", len(got))
	}
	if got[0].Href != "" {
		t.Fatalf("group should have empty href, got %q", got[0].Href)
	}
	if len(got[0].Children) != 1 || got[0].Children[0].Href != "OEBPS/appendix-b.xhtml" {
		t.Fatalf("expected only appendix-b kept, got %+v", got[0].Children)
	}
}

func TestFilterTOCTree_EmptyGroupDropped(t *testing.T) {
	toc := []epub.TOCEntry{
		{
			Title: "空分组",
			Children: []epub.TOCEntry{
				{Href: "OEBPS/ch1.xhtml", Title: "第一章"},
			},
		},
	}
	got := filterTOCTree(toc, pickSet("OEBPS/ch2.xhtml"))
	if len(got) != 0 {
		t.Fatalf("expected empty result, got %+v", got)
	}
}

func TestStripFragment(t *testing.T) {
	cases := map[string]string{
		"OEBPS/ch1.xhtml#s1": "OEBPS/ch1.xhtml",
		"OEBPS/ch1.xhtml":    "OEBPS/ch1.xhtml",
		"":                   "",
	}
	for in, want := range cases {
		if got := stripFragment(in); got != want {
			t.Fatalf("stripFragment(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestFilterTOCTree_StableOrder(t *testing.T) {
	toc := []epub.TOCEntry{
		{Href: "OEBPS/a.xhtml", Title: "A"},
		{Href: "OEBPS/b.xhtml", Title: "B"},
		{Href: "OEBPS/c.xhtml", Title: "C"},
	}
	got := filterTOCTree(toc, pickSet("OEBPS/c.xhtml", "OEBPS/a.xhtml"))
	want := []string{"OEBPS/a.xhtml", "OEBPS/c.xhtml"}
	if len(got) != 2 {
		t.Fatalf("expected 2, got %d", len(got))
	}
	gotHrefs := []string{got[0].Href, got[1].Href}
	if !reflect.DeepEqual(gotHrefs, want) {
		t.Fatalf("order not preserved: %+v", gotHrefs)
	}
}
