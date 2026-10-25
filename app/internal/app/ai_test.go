package app

import (
	"context"
	"encoding/json"
	"os"
	"strings"
	"testing"

	"epubmaker-desktop/internal/aiconfig"
	"epubmaker-desktop/internal/ai"
	"epubmaker-desktop/internal/db"
	"epubmaker-desktop/internal/storage"
)

// aiRecorder captures what the stub provider was asked, so the tests can
// assert the prompts carry the grounding material.
type aiRecorder struct {
	calls   int
	systems []string
	users   []string
}

// stubAI points aiChat at a fake reply and restores the real one afterwards.
// The suite must never touch the network.
func stubAI(t *testing.T, reply func(system, user string) (string, error)) *aiRecorder {
	t.Helper()
	old := aiChat
	rec := &aiRecorder{}
	aiChat = func(ctx context.Context, cfg ai.Config, system, user string) (string, error) {
		rec.calls++
		rec.systems = append(rec.systems, system)
		rec.users = append(rec.users, user)
		return reply(system, user)
	}
	t.Cleanup(func() { aiChat = old })
	return rec
}

// resetAI clears the cache and the settings file so every test starts from
// "not configured, nothing cached".
func resetAI(t *testing.T) {
	t.Helper()
	d, err := db.Open()
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	if _, err := d.Exec(`DELETE FROM ai_cache`); err != nil {
		t.Fatalf("clear ai_cache: %v", err)
	}
	if err := os.Remove(aiconfig.Path()); err != nil && !os.IsNotExist(err) {
		t.Fatalf("remove ai.json: %v", err)
	}
}

func saveAIConfig(t *testing.T, cfg ai.Config) {
	t.Helper()
	if err := aiconfig.Save(cfg); err != nil {
		t.Fatalf("aiconfig.Save: %v", err)
	}
}

func seedChapterWithContent(t *testing.T, bookID, chapterID, title, xhtml string) {
	t.Helper()
	resetPolicy(t)
	seedBook(t, bookID, "书", chapterID, title, false)
	if err := storage.WriteContent(bookID, "c1.xhtml", []byte(xhtml)); err != nil {
		t.Fatalf("write content: %v", err)
	}
}

func TestExplainInContext(t *testing.T) {
	resetAI(t)
	saveAIConfig(t, ai.Config{BaseURL: "http://ai.test/v1", APIKey: "sk-test", Model: "m"})
	rec := stubAI(t, func(system, user string) (string, error) {
		return `{"sense":2,"note":"这里指翻动书页"}`, nil
	})
	b := &Backend{}

	senses := []string{"vt. 转动；旋转", "vt. 翻；翻转", "vi. 变成；变得"}
	out, err := b.ExplainInContext("turn", "She turned the page and smiled.", senses)
	if err != nil {
		t.Fatalf("ExplainInContext: %v", err)
	}
	if out.Sense != 2 || out.SenseText != "vt. 翻；翻转" {
		t.Errorf("sense = %d (%q), want 2 (vt. 翻；翻转)", out.Sense, out.SenseText)
	}
	if out.Note != "这里指翻动书页" {
		t.Errorf("note = %q", out.Note)
	}
	if out.Cached {
		t.Error("first answer should not be cached")
	}
	// Grounding: the prompt must carry the word, the sentence and every
	// numbered sense — the model chooses between them, it is not asked to
	// remember anything.
	if rec.calls != 1 {
		t.Fatalf("calls = %d, want 1", rec.calls)
	}
	if !strings.Contains(rec.users[0], "She turned the page and smiled.") {
		t.Errorf("user prompt missing the sentence: %q", rec.users[0])
	}
	for i, s := range senses {
		if !strings.Contains(rec.users[0], s) {
			t.Errorf("user prompt missing sense %d (%q)", i+1, s)
		}
	}
	if !strings.Contains(rec.users[0], "2. vt. 翻；翻转") {
		t.Errorf("senses should be numbered: %q", rec.users[0])
	}

	// The second ask of the same question must be free.
	out2, err := b.ExplainInContext("turn", "She turned the page and smiled.", senses)
	if err != nil {
		t.Fatalf("ExplainInContext (2nd): %v", err)
	}
	if !out2.Cached {
		t.Error("second answer should be cached")
	}
	if rec.calls != 1 {
		t.Errorf("calls = %d, want 1 (the second ask must hit the cache)", rec.calls)
	}
}

func TestExplainInContextNotConfigured(t *testing.T) {
	resetAI(t)
	b := &Backend{}
	_, err := b.ExplainInContext("turn", "She turned the page.", []string{"vt. 翻"})
	if err == nil || !strings.Contains(err.Error(), "未配置") {
		t.Fatalf("error = %v, want the not-configured message", err)
	}
}

// An empty reply is a soft failure: retryable, and not cached — a cached
// empty would make the retry button a lie.
func TestExplainInContextEmptyReplyNotCached(t *testing.T) {
	resetAI(t)
	saveAIConfig(t, ai.Config{BaseURL: "http://ai.test/v1", APIKey: "sk-test", Model: "m"})
	var rec *aiRecorder
	rec = stubAI(t, func(system, user string) (string, error) {
		if rec.calls == 1 {
			return "  ", nil
		}
		return `{"sense":1,"note":"翻页"}`, nil
	})
	b := &Backend{}
	senses := []string{"vt. 翻"}

	if _, err := b.ExplainInContext("turn", "She turned the page.", senses); err == nil {
		t.Fatal("an empty reply should fail")
	}
	out, err := b.ExplainInContext("turn", "She turned the page.", senses)
	if err != nil {
		t.Fatalf("retry: %v", err)
	}
	if out.Cached {
		t.Error("the retry answered fresh, not from a tombstone")
	}
	if rec.calls != 2 {
		t.Errorf("calls = %d, want 2 (nothing may be cached for an empty reply)", rec.calls)
	}
}

func TestExplainInContextSenseOutOfRange(t *testing.T) {
	resetAI(t)
	saveAIConfig(t, ai.Config{BaseURL: "http://ai.test/v1", APIKey: "sk-test", Model: "m"})
	stubAI(t, func(system, user string) (string, error) {
		return `{"sense":99,"note":"这些义项都不贴合本句"}`, nil
	})
	b := &Backend{}
	out, err := b.ExplainInContext("turn", "a turn of events", []string{"vt. 翻"})
	if err != nil {
		t.Fatalf("ExplainInContext: %v", err)
	}
	if out.Sense != -1 || out.SenseText != "" {
		t.Errorf("sense = %d (%q), want -1 with no text", out.Sense, out.SenseText)
	}
	if out.Note == "" {
		t.Error("the note should survive an out-of-range sense")
	}
}

func TestExplainInContextRejectsMissingGrounding(t *testing.T) {
	resetAI(t)
	saveAIConfig(t, ai.Config{BaseURL: "http://ai.test/v1", APIKey: "sk-test", Model: "m"})
	b := &Backend{}
	if _, err := b.ExplainInContext("turn", "She turned the page.", nil); err == nil {
		t.Error("no senses means nothing to ground on; the call must be refused")
	}
}

func TestParseSentence(t *testing.T) {
	resetAI(t)
	saveAIConfig(t, ai.Config{BaseURL: "http://ai.test/v1", APIKey: "sk-test", Model: "m"})
	stubAI(t, func(system, user string) (string, error) {
		return `{"translation":"她翻过书页，笑了。",
		         "segments":[{"text":"She","role":"主语","gloss":"她"},
		                     {"text":"turned the page","role":"谓语","gloss":"翻过书页"}],
		         "notes":["and 连接两个并列谓语"]}`, nil
	})
	b := &Backend{}
	out, err := b.ParseSentence("She turned the page and smiled.")
	if err != nil {
		t.Fatalf("ParseSentence: %v", err)
	}
	if out.Translation != "她翻过书页，笑了。" {
		t.Errorf("translation = %q", out.Translation)
	}
	if len(out.Segments) != 2 || out.Segments[1].Role != "谓语" {
		t.Fatalf("segments = %+v", out.Segments)
	}
	if len(out.Notes) != 1 {
		t.Errorf("notes = %v", out.Notes)
	}

	out2, err := b.ParseSentence("She turned the page and smiled.")
	if err != nil {
		t.Fatalf("ParseSentence (2nd): %v", err)
	}
	if !out2.Cached {
		t.Error("second parse should be cached")
	}
}

// A model that ignores the JSON instruction and just writes the translation
// still gets its answer shown.
func TestParseSentenceProseFallback(t *testing.T) {
	resetAI(t)
	saveAIConfig(t, ai.Config{BaseURL: "http://ai.test/v1", APIKey: "sk-test", Model: "m"})
	stubAI(t, func(system, user string) (string, error) {
		return "这句话的意思是：她把这一页翻了过去。", nil
	})
	b := &Backend{}
	out, err := b.ParseSentence("She turned the page.")
	if err != nil {
		t.Fatalf("ParseSentence: %v", err)
	}
	if out.Translation != "这句话的意思是：她把这一页翻了过去。" {
		t.Errorf("translation = %q", out.Translation)
	}
	if len(out.Segments) != 0 {
		t.Errorf("segments = %+v, want none for a prose reply", out.Segments)
	}
}

func TestParseSentenceRejectsEmpty(t *testing.T) {
	resetAI(t)
	b := &Backend{}
	if _, err := b.ParseSentence("   "); err == nil {
		t.Error("an empty sentence must be refused")
	}
}

func TestSummarizeChapter(t *testing.T) {
	resetAI(t)
	saveAIConfig(t, ai.Config{BaseURL: "http://ai.test/v1", APIKey: "sk-test", Model: "m"})
	xhtml := `<h1>第一章</h1><p>Alice began to get bored sitting by her sister on the bank.</p>
	          <p>She had peeped into the book her sister was reading, but it had no pictures.</p>`
	seedChapterWithContent(t, "b-ai", "c-ai", "第一章", xhtml)
	rec := stubAI(t, func(system, user string) (string, error) {
		return `{"summary":"爱丽丝厌倦了河岸上的午后，偷看姐姐的书却发现没有插图。",
		         "points":["爱丽丝在河岸犯困","姐姐的书没有插图"],
		         "terms":[{"term":"bank","gloss":"河岸"},{"term":"peeped","gloss":"偷看"}]}`, nil
	})
	b := &Backend{}

	out, err := b.SummarizeChapter("b-ai", "c-ai")
	if err != nil {
		t.Fatalf("SummarizeChapter: %v", err)
	}
	if out.Summary == "" || len(out.Points) != 2 || len(out.Terms) != 2 {
		t.Fatalf("result = %+v", out)
	}
	if out.Truncated {
		t.Error("a two-paragraph chapter is nowhere near the budget")
	}
	// Grounding: the chapter's own text and title are in the prompt.
	if !strings.Contains(rec.users[0], "Alice began to get bored") {
		t.Errorf("user prompt missing the chapter text: %q", rec.users[0])
	}
	if !strings.Contains(rec.users[0], "第一章") {
		t.Errorf("user prompt missing the chapter title: %q", rec.users[0])
	}

	out2, err := b.SummarizeChapter("b-ai", "c-ai")
	if err != nil {
		t.Fatalf("SummarizeChapter (2nd): %v", err)
	}
	if !out2.Cached {
		t.Error("second summary should be cached")
	}
	if rec.calls != 1 {
		t.Errorf("calls = %d, want 1", rec.calls)
	}
}

func TestSummarizeChapterTruncates(t *testing.T) {
	resetAI(t)
	saveAIConfig(t, ai.Config{BaseURL: "http://ai.test/v1", APIKey: "sk-test", Model: "m"})
	long := "<p>" + strings.Repeat("字", 7000) + "</p>"
	seedChapterWithContent(t, "b-ai", "c-ai", "长章", long)
	stubAI(t, func(system, user string) (string, error) {
		return `{"summary":"很长的一章。","points":[],"terms":[]}`, nil
	})
	b := &Backend{}
	out, err := b.SummarizeChapter("b-ai", "c-ai")
	if err != nil {
		t.Fatalf("SummarizeChapter: %v", err)
	}
	if !out.Truncated {
		t.Error("a chapter past the budget must report the truncation")
	}
}

func TestSummarizeChapterMissingChapter(t *testing.T) {
	resetAI(t)
	saveAIConfig(t, ai.Config{BaseURL: "http://ai.test/v1", APIKey: "sk-test", Model: "m"})
	b := &Backend{}
	if _, err := b.SummarizeChapter("no-book", "no-chapter"); err == nil {
		t.Error("a missing chapter must fail")
	}
}

func TestSummarizeChapterNotConfigured(t *testing.T) {
	resetAI(t)
	seedChapterWithContent(t, "b-ai", "c-ai", "第一章", "<p>Some text.</p>")
	b := &Backend{}
	if _, err := b.SummarizeChapter("b-ai", "c-ai"); err == nil || !strings.Contains(err.Error(), "未配置") {
		t.Fatalf("error = %v, want the not-configured message", err)
	}
}

func TestGetAIConfigMasksKey(t *testing.T) {
	resetAI(t)
	saveAIConfig(t, ai.Config{BaseURL: "https://api.deepseek.com/v1", APIKey: "sk-abcdef9999", Model: "deepseek-chat"})
	b := &Backend{}
	v, err := b.GetAIConfig()
	if err != nil {
		t.Fatalf("GetAIConfig: %v", err)
	}
	if !v.KeySet || v.KeyHint != "…9999" {
		t.Errorf("key reporting = %v / %q", v.KeySet, v.KeyHint)
	}
	if v.BaseURL != "https://api.deepseek.com/v1" || v.Model != "deepseek-chat" {
		t.Errorf("view = %+v", v)
	}
	// The key itself must never reach the frontend, not even by accident.
	raw, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), "sk-abcdef9999") {
		t.Errorf("the view leaked the key: %s", raw)
	}
}

func TestSaveAIConfigValidatesAndKeepsKey(t *testing.T) {
	resetAI(t)
	b := &Backend{}
	if err := b.SaveAIConfig("api.openai.com/v1", "k", "m"); err == nil {
		t.Error("a URL without a scheme must be refused")
	}
	if err := b.SaveAIConfig("https://api.openai.com/v1", "sk-keep-me", "gpt-4o-mini"); err != nil {
		t.Fatalf("SaveAIConfig: %v", err)
	}
	// The settings page never receives the key, so a model-only change sends
	// a blank one back — the stored key must survive it.
	if err := b.SaveAIConfig("https://api.openai.com/v1", "", "gpt-4o"); err != nil {
		t.Fatalf("SaveAIConfig (model change): %v", err)
	}
	cfg, err := aiconfig.Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.APIKey != "sk-keep-me" {
		t.Errorf("apiKey = %q, want the stored key kept", cfg.APIKey)
	}
	if cfg.Model != "gpt-4o" {
		t.Errorf("model = %q, want gpt-4o", cfg.Model)
	}
}

func TestAITestConnection(t *testing.T) {
	resetAI(t)
	saveAIConfig(t, ai.Config{BaseURL: "http://ai.test/v1", APIKey: "sk-test", Model: "m"})
	stubAI(t, func(system, user string) (string, error) {
		return "连接正常", nil
	})
	b := &Backend{}
	out, err := b.AITestConnection()
	if err != nil {
		t.Fatalf("AITestConnection: %v", err)
	}
	if out["ok"] != true || out["reply"] != "连接正常" {
		t.Fatalf("result = %v", out)
	}
}

// A failed test connection is a result, not an exception: the settings page
// shows the provider's own message.
func TestAITestConnectionReportsFailure(t *testing.T) {
	resetAI(t)
	saveAIConfig(t, ai.Config{BaseURL: "http://ai.test/v1", APIKey: "sk-bad", Model: "m"})
	stubAI(t, func(system, user string) (string, error) {
		return "", &ai.StatusError{Status: 401, Body: `{"error":{"message":"invalid key"}}`}
	})
	b := &Backend{}
	out, err := b.AITestConnection()
	if err != nil {
		t.Fatalf("AITestConnection should report, not throw: %v", err)
	}
	if out["ok"] != false {
		t.Fatalf("result = %v, want ok=false", out)
	}
	if msg, _ := out["error"].(string); !strings.Contains(msg, "401") {
		t.Errorf("error = %q, want the provider status in the message", msg)
	}
}

func TestChapterTextKeepsParagraphs(t *testing.T) {
	text, truncated := chapterText("<h1>标题</h1><p>第一段。</p><p>第二段。</p>", 6000)
	if truncated {
		t.Error("short text must not be truncated")
	}
	if strings.Contains(text, "<") {
		t.Errorf("tags should be gone: %q", text)
	}
	if !strings.Contains(text, "\n") {
		t.Errorf("paragraph breaks should survive: %q", text)
	}
	if !strings.Contains(text, "第一段。") || !strings.Contains(text, "第二段。") {
		t.Errorf("text lost: %q", text)
	}
}
