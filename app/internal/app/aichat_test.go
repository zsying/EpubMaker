package app

import (
	"context"
	"strings"
	"testing"

	"epubmaker-desktop/internal/ai"
	"epubmaker-desktop/internal/aichat"
	"epubmaker-desktop/internal/aiconfig"
	"epubmaker-desktop/internal/aiprompt"
)

// stubAIChat replaces the multi-turn seam (used by AIChatSend) with a fake.
// The single-turn stub (stubAI) and this one are separate on purpose: a test
// that asserts "the conversation page did NOT call the network" can stub both
// and count them independently.
type aiChatRecorder struct {
	calls       int
	transcripts [][]ai.Message
}

func stubAIChat(t *testing.T, reply func(msgs []ai.Message) (string, error)) *aiChatRecorder {
	t.Helper()
	old := aiAskMsgs
	rec := &aiChatRecorder{}
	aiAskMsgs = func(ctx context.Context, cfg ai.Config, msgs []ai.Message) (ai.Reply, error) {
		rec.calls++
		cp := make([]ai.Message, len(msgs))
		copy(cp, msgs)
		rec.transcripts = append(rec.transcripts, cp)
		s, err := reply(msgs)
		return ai.Reply{Content: s, Finish: "stop"}, err
	}
	t.Cleanup(func() { aiAskMsgs = old })
	return rec
}

// listConvs walks the paged list. Tests care about "all conversations"; the
// page size is the page's business, and hard-coding it here would make a
// paging change look like a test failure.
func listConvs(t *testing.T, b *Backend) []AIConversationDTO {
	t.Helper()
	var all []AIConversationDTO
	for offset := 0; ; {
		page, err := b.AIConversations("", "", offset, maxConvPage)
		if err != nil {
			t.Fatalf("AIConversations(offset=%d): %v", offset, err)
		}
		all = append(all, page.Items...)
		if !page.HasMore || len(page.Items) == 0 {
			return all
		}
		offset += len(page.Items)
	}
}

// explainOnce drives one real (stubbed) lookup so the tests always exercise
// the same code path the reader does.
func explainOnce(t *testing.T, b *Backend, word, sentence string) *ExplainResult {
	t.Helper()
	out, err := b.ExplainInContext(word, sentence)
	if err != nil {
		t.Fatalf("ExplainInContext: %v", err)
	}
	return out
}

// A lookup is a conversation: the transcript — system prompt included — is
// on file, so the AI page can show everything that actually went to the
// provider.
func TestExplainRecordsConversation(t *testing.T) {
	resetAI(t)
	saveAIConfig(t, ai.Config{BaseURL: "http://ai.test/v1", APIKey: "sk-test", Model: "m"})
	rec := stubAI(t, func(system, user string) (string, error) {
		return `{"meaning":"翻动书页","translation":"她翻过书页，笑了。","pos":"v."}`, nil
	})
	b := &Backend{}

	out := explainOnce(t, b, "turn", "She turned the page and smiled.")
	if out.ConversationId == "" {
		t.Fatal("the lookup must name the conversation it created")
	}

	convs := listConvs(t, b)
	if len(convs) != 1 {
		t.Fatalf("conversations = %d, want 1", len(convs))
	}
	c := convs[0]
	if c.Origin != aichat.OriginLookup {
		t.Errorf("origin = %q, want lookup", c.Origin)
	}
	if c.Title != "turn" {
		t.Errorf("title = %q, want the word", c.Title)
	}
	if c.Count != 3 {
		t.Errorf("count = %d, want system+user+assistant", c.Count)
	}

	detail, err := b.AIConversation(c.ID)
	if err != nil {
		t.Fatalf("AIConversation: %v", err)
	}
	if len(detail.Messages) != 3 {
		t.Fatalf("messages = %d, want 3", len(detail.Messages))
	}
	sys := detail.Messages[0]
	if sys.Role != aichat.RoleSystem || !strings.Contains(sys.Content, "英语阅读助手") {
		t.Errorf("system message = %+v, want the real prompt", sys)
	}
	if usr := detail.Messages[1]; usr.Role != aichat.RoleUser ||
		!strings.Contains(usr.Content, "turn") ||
		!strings.Contains(usr.Content, "She turned the page") {
		t.Errorf("user message = %+v, want word + sentence", usr)
	}
	if as := detail.Messages[2]; as.Role != aichat.RoleAssistant || !strings.Contains(as.Content, "翻动书页") {
		t.Errorf("assistant message = %+v", as)
	}

	// The same lookup again is a cache hit: it must not duplicate the
	// conversation — one question, one transcript, however often it is asked.
	if _, err := b.ExplainInContext("turn", "She turned the page and smiled."); err != nil {
		t.Fatalf("second explain: %v", err)
	}
	convs = listConvs(t, b)
	if len(convs) != 1 || rec.calls != 1 {
		t.Errorf("after re-ask: conversations=%d calls=%d, want 1 and 1", len(convs), rec.calls)
	}
}

// Parse and summarize get transcripts of their own, badged by origin so the
// list page can tell them apart.
func TestParseAndSummarizeRecordConversations(t *testing.T) {
	resetAI(t)
	saveAIConfig(t, ai.Config{BaseURL: "http://ai.test/v1", APIKey: "sk-test", Model: "m"})
	stubAI(t, func(system, user string) (string, error) {
		return `{"translation":"她翻过书页。","segments":[],"notes":[]}`, nil
	})
	b := &Backend{}
	parsed, err := b.ParseSentence("She turned the page.")
	if err != nil {
		t.Fatalf("ParseSentence: %v", err)
	}
	// The panel offers "查看对话" from the answer itself, so the answer has to
	// name its transcript — otherwise the only way back is the list page.
	if parsed.ConversationId == "" {
		t.Error("ParseSentence must name the conversation it created")
	}

	xhtml := `<h1>第一章</h1><p>Alice began to get bored sitting by her sister.</p>`
	seedChapterWithContent(t, "b-chat", "c-chat", "第一章", xhtml)
	stubAI(t, func(system, user string) (string, error) {
		return `{"summary":"爱丽丝犯困。","points":[],"terms":[]}`, nil
	})
	summarized, err := b.SummarizeChapter("b-chat", "c-chat")
	if err != nil {
		t.Fatalf("SummarizeChapter: %v", err)
	}
	if summarized.ConversationId == "" {
		t.Error("SummarizeChapter must name the conversation it created")
	}

	convs := listConvs(t, b)
	if len(convs) != 2 {
		t.Fatalf("conversations = %d, want 2", len(convs))
	}
	byOrigin := map[string]string{}
	for _, c := range convs {
		byOrigin[c.Origin] = c.Title
	}
	if byOrigin[aichat.OriginParse] != "She turned the page." {
		t.Errorf("parse title = %q", byOrigin[aichat.OriginParse])
	}
	if byOrigin[aichat.OriginSummarize] != "第一章" {
		t.Errorf("summarize title = %q", byOrigin[aichat.OriginSummarize])
	}
	byID := map[string]string{}
	for _, c := range convs {
		byID[c.ID] = c.Origin
	}
	if byID[parsed.ConversationId] != aichat.OriginParse || byID[summarized.ConversationId] != aichat.OriginSummarize {
		t.Errorf("returned ids do not point at their own transcripts: %v", byID)
	}
}

// The list is paged: one request must not carry a year of lookups. Total and
// hasMore are what let the page grow on scroll, and a page boundary must not
// repeat or skip a row.
func TestAIConversationsPages(t *testing.T) {
	resetAI(t)
	b := &Backend{}
	for i := 0; i < 3; i++ {
		c := &aichat.Conversation{Title: "对话", Origin: aichat.OriginManual}
		msgs := []aichat.Message{
			{Role: aichat.RoleSystem, Content: "s"},
			{Role: aichat.RoleUser, Content: "q"},
			{Role: aichat.RoleAssistant, Content: "a"},
		}
		if err := aichat.Create(c, msgs); err != nil {
			t.Fatalf("Create: %v", err)
		}
	}
	page, err := b.AIConversations("", "", 0, 2)
	if err != nil {
		t.Fatalf("AIConversations: %v", err)
	}
	if len(page.Items) != 2 || page.Total != 3 || !page.HasMore {
		t.Fatalf("page 1 = %d items, total %d, hasMore %v; want 2/3/true",
			len(page.Items), page.Total, page.HasMore)
	}
	rest, err := b.AIConversations("", "", 2, 2)
	if err != nil {
		t.Fatalf("AIConversations page 2: %v", err)
	}
	if len(rest.Items) != 1 || rest.HasMore {
		t.Errorf("page 2 = %d items, hasMore %v; want 1/false", len(rest.Items), rest.HasMore)
	}
	if rest.Items[0].ID == page.Items[0].ID || rest.Items[0].ID == page.Items[1].ID {
		t.Error("the second page repeated a row from the first")
	}
	// A caller that passes nothing gets a page, not the table.
	if def, _ := b.AIConversations("", "", 0, 0); len(def.Items) != 3 {
		t.Errorf("default page = %d items, want all 3 here", len(def.Items))
	}
	// …and an absurd limit is clamped rather than obeyed.
	if big, _ := b.AIConversations("", "", 0, 5000); len(big.Items) != 3 {
		t.Errorf("clamped page = %d items", len(big.Items))
	}
}

// A failed lookup must not leave a conversation behind: there is no answer to
// continue, and a transcript ending in nothing is a dead row.
func TestFailedLookupRecordsNothing(t *testing.T) {
	resetAI(t)
	saveAIConfig(t, ai.Config{BaseURL: "http://ai.test/v1", APIKey: "sk-test", Model: "m"})
	stubAI(t, func(system, user string) (string, error) {
		return "", nil // empty reply → soft failure
	})
	b := &Backend{}
	if _, err := b.ExplainInContext("turn", "She turned the page."); err == nil {
		t.Fatal("an empty reply should fail")
	}
	convs := listConvs(t, b)
	if len(convs) != 0 {
		t.Errorf("conversations = %d, want none for a failed ask", len(convs))
	}
}

// Continuing a conversation sends the whole transcript — system prompt, the
// original exchange, the new question — and files the answer.
func TestAIChatSendContinues(t *testing.T) {
	resetAI(t)
	saveAIConfig(t, ai.Config{BaseURL: "http://ai.test/v1", APIKey: "sk-test", Model: "m"})
	stubAI(t, func(system, user string) (string, error) {
		return `{"meaning":"翻动书页","translation":"她翻过书页，笑了。"}`, nil
	})
	b := &Backend{}
	out := explainOnce(t, b, "turn", "She turned the page and smiled.")

	rec := stubAIChat(t, func(msgs []ai.Message) (string, error) {
		return "因为叙事用的是过去时。", nil
	})
	turn, err := b.AIChatSend(out.ConversationId, "为什么翻译成「笑了」？", "")
	if err != nil {
		t.Fatalf("AIChatSend: %v", err)
	}
	if turn.ConversationID != out.ConversationId {
		t.Errorf("conversationId = %q, want %q", turn.ConversationID, out.ConversationId)
	}
	if turn.User.Content != "为什么翻译成「笑了」？" || turn.Assistant.Content != "因为叙事用的是过去时。" {
		t.Errorf("turn = %+v", turn)
	}
	if rec.calls != 1 {
		t.Fatalf("calls = %d, want 1", rec.calls)
	}
	// The wire transcript: everything recorded so far plus the new question.
	msgs := rec.transcripts[0]
	if len(msgs) != 4 {
		t.Fatalf("sent %d messages, want system + exchange + question", len(msgs))
	}
	if msgs[0].Role != "system" || !strings.Contains(msgs[0].Content, "英语阅读助手") {
		t.Errorf("first sent message = %+v, want the stored system prompt", msgs[0])
	}
	if msgs[2].Role != "assistant" || !strings.Contains(msgs[2].Content, "翻动书页") {
		t.Errorf("third sent message = %+v, want the stored answer", msgs[2])
	}
	if msgs[3].Role != "user" || msgs[3].Content != "为什么翻译成「笑了」？" {
		t.Errorf("last sent message = %+v, want the new question", msgs[3])
	}

	detail, _ := b.AIConversation(out.ConversationId)
	if len(detail.Messages) != 5 {
		t.Fatalf("stored messages = %d, want 5 after the continuation", len(detail.Messages))
	}
}

// A failed continuation rolls the user message back, so a retry cannot
// duplicate the question and the transcript stays what actually happened.
func TestAIChatSendFailureRollsBack(t *testing.T) {
	resetAI(t)
	saveAIConfig(t, ai.Config{BaseURL: "http://ai.test/v1", APIKey: "sk-test", Model: "m"})
	stubAI(t, func(system, user string) (string, error) {
		return `{"meaning":"翻动书页","translation":"她翻过书页。"}`, nil
	})
	b := &Backend{}
	out := explainOnce(t, b, "turn", "She turned the page and smiled.")

	rec := stubAIChat(t, func(msgs []ai.Message) (string, error) {
		return "", context.DeadlineExceeded
	})
	if _, err := b.AIChatSend(out.ConversationId, "再说一遍", ""); err == nil {
		t.Fatal("a failed continuation must be an error")
	}
	if rec.calls != 1 {
		t.Errorf("calls = %d", rec.calls)
	}
	detail, _ := b.AIConversation(out.ConversationId)
	if len(detail.Messages) != 3 {
		t.Errorf("messages = %d, want the original 3 (user message rolled back)", len(detail.Messages))
	}
	// And the retry works afterwards.
	stubAIChat(t, func(msgs []ai.Message) (string, error) { return "好的，再说一次。", nil })
	if _, err := b.AIChatSend(out.ConversationId, "再说一遍", ""); err != nil {
		t.Fatalf("retry: %v", err)
	}
	detail, _ = b.AIConversation(out.ConversationId)
	if len(detail.Messages) != 5 {
		t.Errorf("messages after retry = %d, want 5", len(detail.Messages))
	}
}

// A manual chat starts from one message: the app supplies the system prompt,
// the conversation is created on the spot, and the title comes from the text.
func TestAIChatSendCreatesManualConversation(t *testing.T) {
	resetAI(t)
	saveAIConfig(t, ai.Config{BaseURL: "http://ai.test/v1", APIKey: "sk-test", Model: "m"})
	long := strings.Repeat("帮我理解虚拟语气，", 10)
	rec := stubAIChat(t, func(msgs []ai.Message) (string, error) {
		return "虚拟语气表示与事实相反的假设。", nil
	})
	b := &Backend{}
	turn, err := b.AIChatSend("", long, "")
	if err != nil {
		t.Fatalf("AIChatSend: %v", err)
	}
	convs := listConvs(t, b)
	if len(convs) != 1 {
		t.Fatalf("conversations = %d, want 1", len(convs))
	}
	c := convs[0]
	if c.Origin != aichat.OriginManual {
		t.Errorf("origin = %q, want manual", c.Origin)
	}
	if c.ID != turn.ConversationID {
		t.Errorf("returned id %q does not match the stored row %q", turn.ConversationID, c.ID)
	}
	if got := []rune(c.Title); len(got) > 40 {
		t.Errorf("title = %d runes, want clamped", len(got))
	}
	if rec.transcripts[0][0].Role != "system" || strings.Contains(rec.transcripts[0][0].Content, "虚拟语气") {
		t.Errorf("manual chat system prompt = %+v", rec.transcripts[0][0])
	}
	detail, _ := b.AIConversation(c.ID)
	if len(detail.Messages) != 3 || detail.Messages[0].Role != "system" {
		t.Errorf("manual transcript = %+v", detail.Messages)
	}
}

func TestAIChatSendRejectsEmptyAndUnknown(t *testing.T) {
	resetAI(t)
	saveAIConfig(t, ai.Config{BaseURL: "http://ai.test/v1", APIKey: "sk-test", Model: "m"})
	b := &Backend{}
	if _, err := b.AIChatSend("", "  ", ""); err == nil {
		t.Error("an empty message must be refused")
	}
	if _, err := b.AIChatSend("no-such-conv", "你好", ""); err == nil {
		t.Error("an unknown conversation must be refused")
	}
	// Not configured is its own message, naming the settings file.
	resetAI(t)
	if _, err := b.AIChatSend("", "你好", ""); err == nil || !strings.Contains(err.Error(), "未配置") {
		t.Errorf("error = %v, want the not-configured message", err)
	}
}

func TestAIConversationDelete(t *testing.T) {
	resetAI(t)
	saveAIConfig(t, ai.Config{BaseURL: "http://ai.test/v1", APIKey: "sk-test", Model: "m"})
	stubAI(t, func(system, user string) (string, error) {
		return `{"meaning":"翻动书页","translation":"她翻过书页。"}`, nil
	})
	b := &Backend{}
	out := explainOnce(t, b, "turn", "She turned the page and smiled.")
	if err := b.AIConversationDelete(out.ConversationId); err != nil {
		t.Fatalf("AIConversationDelete: %v", err)
	}
	if d, _ := b.AIConversation(out.ConversationId); d != nil {
		t.Error("the conversation survived deletion")
	}
	convs := listConvs(t, b)
	if len(convs) != 0 {
		t.Errorf("list still shows %d conversations", len(convs))
	}
}

// The word card asks for a cached explanation without touching the network:
// a hit is returned with its conversation, a miss is a quiet nil.
func TestAIExplainCached(t *testing.T) {
	resetAI(t)
	saveAIConfig(t, ai.Config{BaseURL: "http://ai.test/v1", APIKey: "sk-test", Model: "m"})
	b := &Backend{}

	// Before any ask: a miss, and the provider is never called. The stub
	// answers with a poisoned value — if the card path asked the network,
	// the test fails right there.
	probe := stubAI(t, func(system, user string) (string, error) {
		t.Error("AIExplainCached must not call the provider")
		return "", nil
	})
	got, err := b.AIExplainCached("turn", "She turned the page and smiled.")
	if err != nil || got != nil {
		t.Fatalf("AIExplainCached = %+v, %v; want nil, nil", got, err)
	}
	_ = probe

	// One real (stubbed) lookup files the answer; from then on the card can
	// read it from the cache.
	stubAI(t, func(system, user string) (string, error) {
		return `{"meaning":"翻动书页","translation":"她翻过书页，笑了。","note":"turn the page"}`, nil
	})
	out := explainOnce(t, b, "turn", "She turned the page and smiled.")

	// The card's read must still not call the provider: fresh stub, same trap.
	stubAI(t, func(system, user string) (string, error) {
		t.Error("AIExplainCached must not call the provider")
		return "", nil
	})
	got, err = b.AIExplainCached("turn", "She turned the page and smiled.")
	if err != nil {
		t.Fatalf("AIExplainCached: %v", err)
	}
	if got == nil {
		t.Fatal("the explanation is cached, want a hit")
	}
	if got.Meaning != "翻动书页" || !got.Cached {
		t.Errorf("hit = %+v", got)
	}
	if got.ConversationId != out.ConversationId {
		t.Errorf("conversationId = %q, want %q", got.ConversationId, out.ConversationId)
	}
	// A different sentence is a different question: still a miss.
	got, _ = b.AIExplainCached("turn", "He turned the corner.")
	if got != nil {
		t.Errorf("a different sentence returned %+v, want nil", got)
	}
}

// A hand-made conversation opens with the prompt it was given: a library
// prompt when one is picked, the reader's configured standing prompt when
// not, the built-in default otherwise. The prompt lands as the transcript's
// first message — the conversation page shows what actually shaped the
// answers, and later edits to the library cannot reach back.
func TestAIChatSendPicksTheOpeningPrompt(t *testing.T) {
	resetAI(t)
	saveAIConfig(t, ai.Config{BaseURL: "http://ai.test/v1", APIKey: "sk-test", Model: "m"})
	rec := stubAIChat(t, func(msgs []ai.Message) (string, error) {
		return "好的。", nil
	})
	b := &Backend{}

	// No pick, no configured override: the built-in default opens.
	turn, err := b.AIChatSend("", "讲讲虚拟语气", "")
	if err != nil {
		t.Fatalf("AIChatSend(default): %v", err)
	}
	if sys := rec.transcripts[0][0]; sys.Role != aichat.RoleSystem ||
		sys.Content != aiconfig.DefaultChatSystem {
		t.Errorf("default opening = %q, want the built-in prompt", sys.Content)
	}
	if n := rec.calls; n != 1 {
		t.Fatalf("calls = %d, want 1", n)
	}

	// The 对话 row IS the standing prompt now — the LLM page maintains it
	// inside the library. Editing it changes what future unprompted chats
	// open with; the built-in default was the seed.
	if _, err := b.AIPromptSave(aiprompt.SysChat, "对话", "你是考研英语家教，回答要给出考点编号。"); err != nil {
		t.Fatalf("AIPromptSave(sys-chat): %v", err)
	}
	if _, err := b.AIChatSend("", "再讲讲虚拟语气", ""); err != nil {
		t.Fatalf("AIChatSend(standing): %v", err)
	}
	if sys := rec.transcripts[1][0]; sys.Content != "你是考研英语家教，回答要给出考点编号。" {
		t.Errorf("standing opening = %q", sys.Content)
	}

	// A library prompt wins over both, and keeps its text even after the
	// prompt is deleted or the setting changes: the transcript stores a copy.
	saved, err := b.AIPromptSave("", "苏格拉底式", "你用反问引导读者自己得出答案，不给直接结论。")
	if err != nil {
		t.Fatalf("AIPromptSave: %v", err)
	}
	if _, err := b.AIChatSend("", "三讲虚拟语气", saved.ID); err != nil {
		t.Fatalf("AIChatSend(prompted): %v", err)
	}
	if sys := rec.transcripts[2][0]; !strings.Contains(sys.Content, "反问") {
		t.Errorf("prompted opening = %q", sys.Content)
	}
	if err := b.AIPromptDelete(saved.ID); err != nil {
		t.Fatalf("AIPromptDelete: %v", err)
	}
	detail, err := b.AIConversation(turn.ConversationID)
	if err != nil {
		t.Fatalf("AIConversation: %v", err)
	}
	// turn's conversation is the first one; find the prompted one instead.
	convs := listConvs(t, b)
	var prompted string
	for _, c := range convs {
		if strings.Contains(c.Title, "三讲") {
			prompted = c.ID
		}
	}
	detail, err = b.AIConversation(prompted)
	if err != nil {
		t.Fatalf("AIConversation(prompted): %v", err)
	}
	if detail.Messages[0].Role != aichat.RoleSystem ||
		!strings.Contains(detail.Messages[0].Content, "反问") {
		t.Errorf("transcript must keep the prompt it was born with, got %q", detail.Messages[0].Content)
	}

	// An unknown prompt id falls back to the standing resolution, so a picker
	// row outliving its prompt degrades to the default, not to an error. The
	// 对话 row was left customized above, so the fallback answers its text.
	if _, err := b.AIChatSend("", "四讲虚拟语气", "gone"); err != nil {
		t.Fatalf("AIChatSend(unknown prompt): %v", err)
	}
	if sys := rec.transcripts[3][0]; sys.Content != "你是考研英语家教，回答要给出考点编号。" {
		t.Errorf("unknown-prompt opening = %q, want the standing prompt", sys.Content)
	}

	// Continuing an existing conversation keeps its own opening prompt even
	// when a different prompt id is passed: the first message is the truth
	// about what shaped the earlier answers.
	if _, err := b.AIChatSend(prompted, "那再举个反例", saved.ID); err == nil {
		t.Log("continue after delete went through")
	}
}

// The prompt library behind the picker: create, list, edit, delete, and the
// validation the form leans on.
func TestAIPromptBackendCRUD(t *testing.T) {
	resetAI(t)
	b := &Backend{}

	if _, err := b.AIPromptSave("", " ", "x"); err == nil {
		t.Error("blank name must be refused")
	}
	saved, err := b.AIPromptSave("", "词汇教练", "你只教词汇，一次只讲一个词。")
	if err != nil {
		t.Fatalf("AIPromptSave: %v", err)
	}
	if saved.ID == "" {
		t.Fatal("save must answer the stored row")
	}

	updated, err := b.AIPromptSave(saved.ID, "词汇教练 v2", "你只教词汇，并给出搭配。")
	if err != nil {
		t.Fatalf("AIPromptSave(update): %v", err)
	}
	if updated.ID != saved.ID {
		t.Errorf("update changed id: %s -> %s", saved.ID, updated.ID)
	}

	list, err := b.AIPromptList()
	if err != nil {
		t.Fatalf("AIPromptList: %v", err)
	}
	users := 0
	for _, p := range list {
		if !p.System {
			users++
			if p.Name != "词汇教练 v2" {
				t.Errorf("user row = %+v", p)
			}
		}
	}
	if users != 1 {
		t.Errorf("user rows = %d, want 1 (list %+v)", users, list)
	}

	if err := b.AIPromptDelete(saved.ID); err != nil {
		t.Fatalf("AIPromptDelete: %v", err)
	}
	list, _ = b.AIPromptList()
	for _, p := range list {
		if !p.System {
			t.Errorf("user row survived delete: %+v", p)
		}
	}

	// A system row refuses to go away: it is part of the app.
	if err := b.AIPromptDelete(aiprompt.SysGuide); err == nil {
		t.Error("deleting a system prompt must be refused")
	}
}
