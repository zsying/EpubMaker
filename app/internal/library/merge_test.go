package library

import (
	"os"
	"strings"
	"testing"

	"epubmaker-desktop/internal/html"
	"epubmaker-desktop/internal/storage"
)

func setupMergeBook(t *testing.T) {
	t.Helper()
	resetLibraryTables(t)
	insertBookRow(t, "mb", "合并测试")
	insertChapterRow(t, "mb", "tgt", 0)
	insertChapterRow(t, "mb", "s1", 1)
	insertChapterRow(t, "mb", "s2", 2)
	for id, body := range map[string]string{
		"tgt": "<p>目标正文</p>",
		"s1":  "<p>源一正文</p>",
		"s2":  "<p>源二正文</p>",
	} {
		if err := storage.WriteContent("mb", "ch"+id+".xhtml", []byte(html.WrapDocument(id, body))); err != nil {
			t.Fatalf("write %s: %v", id, err)
		}
	}
}

func chapterIDs(list []ChapterDTO) []string {
	out := make([]string, 0, len(list))
	for _, c := range list {
		out = append(out, c.ID)
	}
	return out
}

func TestMergeChaptersJoinsTheSources(t *testing.T) {
	setupMergeBook(t)

	list, err := MergeChapters("mb", "tgt", []string{"s1", "s2"})
	if err != nil {
		t.Fatalf("merge: %v", err)
	}
	if got := chapterIDs(list); len(got) != 1 || got[0] != "tgt" {
		t.Fatalf("chapters after merge = %v, want only tgt", got)
	}

	src, err := GetChapterSource("mb", "tgt")
	if err != nil {
		t.Fatalf("read merged: %v", err)
	}
	for _, want := range []string{"目标正文", "源一正文", "源二正文"} {
		if !strings.Contains(src.HTML, want) {
			t.Errorf("merged body is missing %q: %s", want, src.HTML)
		}
	}
}

// An unreadable source chapter used to be skipped silently: the merged chapter
// was written without it and the source chapter was deleted right afterwards,
// so the text was gone for good. Now the merge must abort with nothing changed.
func TestMergeChaptersAbortsWhenASourceCannotBeRead(t *testing.T) {
	setupMergeBook(t)
	path, err := storage.ContentPath("mb", "chs1.xhtml")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}

	_, err = MergeChapters("mb", "tgt", []string{"s1", "s2"})
	if err == nil {
		t.Fatal("a merge that cannot read every part must not report success")
	}

	// The target chapter is untouched and both sources are still listed.
	src, err := GetChapterSource("mb", "tgt")
	if err != nil {
		t.Fatalf("target became unreadable: %v", err)
	}
	if !strings.Contains(src.HTML, "目标正文") || strings.Contains(src.HTML, "源二正文") {
		t.Errorf("the target was rewritten despite the failure: %s", src.HTML)
	}
	list, err := ListChapters("mb")
	if err != nil {
		t.Fatal(err)
	}
	if got := chapterIDs(list); len(got) != 3 {
		t.Errorf("chapters = %v, want all three still present", got)
	}
}

// The same when the target itself cannot be read: writing an empty body over it
// and deleting the sources turned one unreadable file into three lost chapters.
func TestMergeChaptersAbortsWhenTheTargetCannotBeRead(t *testing.T) {
	setupMergeBook(t)
	path, err := storage.ContentPath("mb", "chtgt.xhtml")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}

	if _, err := MergeChapters("mb", "tgt", []string{"s1", "s2"}); err == nil {
		t.Fatal("a merge with an unreadable target must not report success")
	}

	// Nothing was written in its place: the file is still absent rather than a
	// freshly created empty document, and the sources are still there.
	if storage.ContentExists("mb", "chtgt.xhtml") {
		t.Error("the target was recreated as an empty document")
	}
	list, err := ListChapters("mb")
	if err != nil {
		t.Fatal(err)
	}
	if got := chapterIDs(list); len(got) != 3 {
		t.Errorf("chapters = %v, want all three still present", got)
	}
}
