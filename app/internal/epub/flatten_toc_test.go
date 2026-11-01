package epub

import "testing"

// A nav that anchors every section (calibre's `#filepos…`) still has to name the
// document those sections live in: the spine only knows documents, and a
// key-with-fragment never matches one. 邓小平时代 shipped 33 such entries and
// every chapter fell back to the file's <title> — the English cover title.
func TestFlattenTOCDropsFragments(t *testing.T) {
	toc := []TOCEntry{
		{Href: "book_split_000.html#filepos109", Title: "扉　页"},
		{Href: "book_split_000.html#filepos97506", Title: "第1章 革命者"},
		{Href: "book_split_001.html#filepos183975", Title: "第2章 从放逐到返京"},
		{Title: "第一部 分组", Children: []TOCEntry{
			{Href: "book_split_002.html#a", Title: "第3章 整顿秩序"},
		}},
		{Href: "book_split_003.html", Title: "第4章 规划未来"},
	}
	got := flattenTOC(toc)

	want := map[string]string{
		// First entry in document order wins: the section the file opens with.
		"book_split_000.html": "扉　页",
		"book_split_001.html": "第2章 从放逐到返京",
		"book_split_002.html": "第3章 整顿秩序",
		"book_split_003.html": "第4章 规划未来",
	}
	for href, title := range want {
		if got[href] != title {
			t.Errorf("TOC[%s] = %q, want %q", href, got[href], title)
		}
	}
	// The fragment key must not survive as a second, unusable entry.
	if _, ok := got["book_split_002.html#a"]; ok {
		t.Errorf("flattened TOC kept a key with its fragment")
	}
	if len(got) != len(want) {
		t.Errorf("TOC has %d keys, want %d: %v", len(got), len(want), got)
	}
}
