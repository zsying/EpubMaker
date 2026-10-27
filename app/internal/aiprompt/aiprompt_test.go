package aiprompt

import (
	"os"
	"strings"
	"testing"
	"time"

	"epubmaker-desktop/internal/db"
)

func TestMain(m *testing.M) {
	dir, err := os.MkdirTemp("", "epubmaker-aiprompt-test")
	if err != nil {
		panic(err)
	}
	os.Setenv("EPUBMAKER_HOME", dir)
	code := m.Run()
	_ = db.Close()
	_ = os.RemoveAll(dir)
	os.Exit(code)
}

// reset empties the library so every test starts from nothing.
func reset(t *testing.T) {
	t.Helper()
	d, err := db.Open()
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	if _, err := d.Exec(`DELETE FROM ai_prompts`); err != nil {
		t.Fatalf("clear ai_prompts: %v", err)
	}
}

func TestPromptCRUDRounds(t *testing.T) {
	reset(t)

	p := &Prompt{Name: "  面试官  ", Content: " 你是英语面试官，用提问的方式帮我练习口语。 "}
	if err := Save(p); err != nil {
		t.Fatalf("Save: %v", err)
	}
	if p.ID == "" || p.CreatedAt == "" || p.UpdatedAt == "" {
		t.Fatalf("created row is incomplete: %+v", p)
	}
	if p.Name != "面试官" || !strings.HasPrefix(p.Content, "你是英语面试官") {
		t.Errorf("fields not trimmed: %+v", p)
	}

	got, err := Get(p.ID)
	if err != nil || got == nil {
		t.Fatalf("Get: %v / %v", got, err)
	}

	// Update keeps the id and does not rewrite created_at (read it back —
	// the update call does not echo it into the struct it was given).
	p2 := &Prompt{ID: p.ID, Name: "面试官（强化）", Content: p.Content}
	if err := Save(p2); err != nil {
		t.Fatalf("Save(update): %v", err)
	}
	back, err := Get(p.ID)
	if err != nil || back == nil {
		t.Fatalf("Get(after update): %v / %v", back, err)
	}
	if back.ID != p.ID || back.CreatedAt != p.CreatedAt || back.Name != "面试官（强化）" {
		t.Errorf("update changed identity: %+v vs %+v", back, p)
	}

	// A second prompt sorts ahead: it was touched last, and a picker wants
	// the most recently edited prompt first. The sleep keeps the two
	// updated_at stamps from landing in the same millisecond, where the
	// order would be a coin flip.
	time.Sleep(2 * time.Millisecond)
	if err := Save(&Prompt{Name: "语法教练", Content: "你是语法教练。"}); err != nil {
		t.Fatalf("Save(second): %v", err)
	}
	all, err := List()
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(all) != 2 || all[0].Name != "语法教练" || all[1].ID != p.ID {
		t.Errorf("List order = %+v, want newest first", all)
	}

	if err := Delete(p.ID); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	if got, _ := Get(p.ID); got != nil {
		t.Error("deleted prompt still readable")
	}
}

func TestPromptValidation(t *testing.T) {
	reset(t)

	if err := Save(&Prompt{Name: "  ", Content: "x"}); err == nil {
		t.Error("blank name must be refused")
	}
	if err := Save(&Prompt{Name: "x", Content: " "}); err == nil {
		t.Error("blank content must be refused")
	}

	long := strings.Repeat("字", contentRunes+10)
	p := &Prompt{Name: strings.Repeat("名", nameRunes+10), Content: long}
	if err := Save(p); err != nil {
		t.Fatalf("Save(clamped): %v", err)
	}
	got, _ := Get(p.ID)
	if got == nil {
		t.Fatal("clamped prompt vanished")
	}
	if len([]rune(got.Name)) != nameRunes || len([]rune(got.Content)) != contentRunes {
		t.Errorf("clamps missed: name=%d content=%d", len([]rune(got.Name)), len([]rune(got.Content)))
	}
}

func TestGetUnknownIsQuietNil(t *testing.T) {
	reset(t)
	got, err := Get("does-not-exist")
	if err != nil || got != nil {
		t.Errorf("Get(unknown) = %v, %v; want nil, nil", got, err)
	}
}
