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

// reset empties the library so every test starts from nothing. Seeding is a
// check-and-fill (not a sync.Once), so the first List/Get after a reset puts
// the system rows back — tests filter them out with userOnly where order or
// counts matter.
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

// userOnly keeps the user-created rows: tests about CRUD order should not
// count the seeded system prompts.
func userOnly(all []Prompt) []Prompt {
	out := []Prompt{}
	for _, p := range all {
		if !p.System {
			out = append(out, p)
		}
	}
	return out
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
	if p.System {
		t.Error("a blank-id save must create a user prompt")
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
	users := userOnly(all)
	if len(users) != 2 || users[0].Name != "语法教练" || users[1].ID != p.ID {
		t.Errorf("List order = %+v, want newest first", users)
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

func TestSeedIsIdempotentAndSystem(t *testing.T) {
	reset(t)

	seed() // seedOnce already fired in an earlier test — a no-op either way
	all, err := List()
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	sys := map[string]Prompt{}
	for _, p := range all {
		if p.System {
			sys[p.ID] = p
		}
	}
	for _, id := range []string{SysChat, SysWord, SysSentence, SysGuide} {
		p, ok := sys[id]
		if !ok {
			t.Errorf("seeded prompt %s missing", id)
			continue
		}
		if p.Default == "" {
			t.Errorf("%s carries no built-in text for 恢复默认", id)
		}
	}

	// The 查词 row IS the built-in text: the lookup feature reads it.
	if sys[SysWord].Content != BuiltinWord {
		t.Error("seeded 查词 prompt drifted from the built-in text")
	}

	// Reset puts an edited system row back.
	if err := Save(&Prompt{ID: SysWord, Name: "查词（魔改）", Content: "输出诗歌。"}); err != nil {
		t.Fatalf("Save(system edit): %v", err)
	}
	if err := Reset(SysWord); err != nil {
		t.Fatalf("Reset: %v", err)
	}
	p, _ := Get(SysWord)
	if p == nil || p.Name != "查词" || p.Content != BuiltinWord {
		t.Errorf("Reset left %+v", p)
	}
}

func TestSystemRowsAreProtected(t *testing.T) {
	reset(t)

	if err := Delete(SysChat); err == nil {
		t.Error("deleting a system prompt must be refused")
	}
	if err := Delete(SysWord); err == nil {
		t.Error("deleting a system prompt must be refused")
	}
	if err := Reset("not-a-system-id"); err == nil {
		t.Error("Reset on a user prompt must be refused")
	}

	// Editing is allowed — that is the point of the entry — but the row
	// stays system and cannot be turned into a user prompt by a save.
	if err := Save(&Prompt{ID: SysGuide, Name: "导读（自定义）", Content: "换个风格写摘要。"}); err != nil {
		t.Fatalf("Save(system edit): %v", err)
	}
	p, _ := Get(SysGuide)
	if p == nil || !p.System {
		t.Errorf("system row lost its flag: %+v", p)
	}
}

func TestContentForFallsBackToBuiltin(t *testing.T) {
	reset(t)

	// A feature must keep working even with its row gone: the built-in text
	// is the floor, the library row is the override.
	if got := ContentFor(SysWord); got != BuiltinWord {
		t.Error("ContentFor(sys-word) with no row must answer the built-in text")
	}
	if got := ContentFor("user-gone"); got != "" {
		t.Errorf("ContentFor(unknown user id) = %q, want empty", got)
	}
	// A row overrides the built-in.
	if err := Save(&Prompt{ID: SysSentence, Name: "拆句", Content: "自定义拆句提示词。"}); err != nil {
		t.Fatalf("Save: %v", err)
	}
	if got := ContentFor(SysSentence); got != "自定义拆句提示词。" {
		t.Errorf("ContentFor override = %q", got)
	}
}
