package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"sync"
	"time"

	"epubmaker-desktop/internal/ai"
	"epubmaker-desktop/internal/aicache"
	"epubmaker-desktop/internal/aichat"
	"epubmaker-desktop/internal/aiconfig"
	"epubmaker-desktop/internal/aiprompt"
	"epubmaker-desktop/internal/html"
	"epubmaker-desktop/internal/library"
	"epubmaker-desktop/internal/logx"
)

// The AI features are grounded by design (ADR-10): every one of them hangs off
// material the app already holds — the sentence the reader selected, the word
// they tapped in it, the chapter they are reading. Nothing is generated from
// nothing, which is what keeps hallucination, cost, and the privacy question
// all bounded: the model explains what is on screen; it does not invent facts
// about a book it has not been given.
//
// Every call is an explicit reader action (red line 2a), bounded to one
// request timeout (2b), and its answer lands in ai_cache so the same question
// is never paid for twice (2c).
//
// Every call is also logged (logx, category "ai"): the request text, the
// answer, the provider's finish_reason and the elapsed time. A failed AI call
// depends on a provider the developer cannot reach, so without this record a
// bug report can only say "it didn't work".

/* ------------------------------ configuration ------------------------------ */

// GetAIConfig returns the AI settings for the settings page, with every key
// masked: the frontend never receives one, so it can only show whether a key
// is stored, never leak it into a screenshot or a bug report.
func (b *Backend) GetAIConfig() (*aiconfig.View, error) {
	s, err := aiconfig.LoadStore()
	if err != nil {
		return nil, err
	}
	v := aiconfig.NewView(s)
	return &v, nil
}

// AISaveProfile creates (blank id) or updates one provider configuration and
// returns the stored row. Profiles are what make switching cheap: a reader who
// keeps a local model for the commute and a hosted one at home edits neither
// when he moves from the train to the desk.
//
// A blank key keeps the stored one — the page never receives it — and a blank
// name resolves to the provider's name, so adding a second OpenAI key does not
// become a naming exercise.
func (b *Backend) AISaveProfile(id, name, baseURL, apiKey, model string) (*aiconfig.ProfileView, error) {
	p, err := aiconfig.SaveProfile(aiconfig.Profile{
		ID: id, Name: name, BaseURL: baseURL, APIKey: apiKey, Model: model,
	})
	if err != nil {
		logx.Event(logx.LevelWarn, "ai", "接口配置保存失败", "error", err.Error())
		return nil, err
	}
	logx.Event(logx.LevelInfo, "ai", "接口配置已保存",
		"id", p.ID, "name", p.Name, "baseUrl", p.BaseURL, "model", p.Model,
		"key", keyNote(apiKey))
	row := aiconfig.ProfileViewOf(p)
	return &row, nil
}

// keyNote says what happened to the key without ever logging it.
func keyNote(apiKey string) string {
	if strings.TrimSpace(apiKey) == "" {
		return "kept"
	}
	return "set"
}

// AIDeleteProfile removes one configuration; the active role moves to whatever
// is left.
func (b *Backend) AIDeleteProfile(id string) error {
	if err := aiconfig.DeleteProfile(id); err != nil {
		logx.Event(logx.LevelWarn, "ai", "删除接口配置失败", "id", id, "error", err.Error())
		return err
	}
	logx.Event(logx.LevelInfo, "ai", "接口配置已删除", "id", id)
	return nil
}

// AIActivateProfile switches which configuration the app calls, now and for
// every later request. The switch is the feature, so it is one call of its own
// rather than a flag on a save.
func (b *Backend) AIActivateProfile(id string) error {
	if err := aiconfig.Activate(id); err != nil {
		logx.Event(logx.LevelWarn, "ai", "切换接口配置失败", "id", id, "error", err.Error())
		return err
	}
	logx.Event(logx.LevelInfo, "ai", "已切换接口配置", "id", id)
	return nil
}

// AISaveChatSystem stores the standing prompt for hand-made conversations —
// a save that belongs to the prompt card, so it does not drag the provider
// fields along. A blank text restores the built-in default; ChatSystemFor
// resolves empty to it at every new conversation.
func (b *Backend) AISaveChatSystem(chatSystem string) error {
	cfg, err := aiconfig.Load()
	if err != nil {
		return err
	}
	cfg.ChatSystem = strings.TrimSpace(chatSystem)
	if err := aiconfig.Save(cfg); err != nil {
		logx.Event(logx.LevelWarn, "ai", "提示词保存失败", "error", err.Error())
		return err
	}
	logx.Event(logx.LevelInfo, "ai", "对话提示词已保存", "chars", itoa(len([]rune(cfg.ChatSystem))))
	return nil
}

// AITestProfile makes one tiny real call against the values in the form, so a
// key can be tested before it is saved. It is the only AI call the app makes
// without the reader asking for content — and it is still an explicit button
// press.
//
// A blank key with an id falls back to that profile's stored key: the page
// never receives the key, so "test what I typed" would otherwise fail for
// every configuration that already has one.
func (b *Backend) AITestProfile(id, baseURL, apiKey, model string) (map[string]any, error) {
	cfg := ai.Config{
		BaseURL: strings.TrimSpace(baseURL),
		APIKey:  strings.TrimSpace(apiKey),
		Model:   strings.TrimSpace(model),
	}
	if cfg.APIKey == "" && id != "" {
		if s, err := aiconfig.LoadStore(); err == nil {
			if p := s.Profile(id); p != nil {
				cfg.APIKey = p.APIKey
			}
		}
	}
	if err := aiconfig.Validate(cfg); err != nil {
		logx.Event(logx.LevelWarn, "ai", "测试连接：表单不完整", "error", err.Error())
		return map[string]any{"ok": false, "error": err.Error()}, nil
	}
	reply, err := aiAsk(context.Background(), cfg,
		"你是一个连接测试服务，只用于验证接口可用。",
		"请回复：连接正常")
	if err != nil {
		logx.Event(logx.LevelWarn, "ai", "测试连接失败",
			"baseUrl", cfg.BaseURL, "model", cfg.Model, "error", err.Error())
		return map[string]any{"ok": false, "error": "AI 请求失败：" + err.Error()}, nil
	}
	if strings.TrimSpace(reply.Content) == "" {
		logx.Event(logx.LevelWarn, "ai", "测试连接：空回答",
			"model", cfg.Model,
			"finish", reply.Finish,
			"reasoningChars", itoa(len([]rune(reply.Reasoning))))
		return map[string]any{"ok": false, "error": "接口返回了空内容，请检查模型名称"}, nil
	}
	logx.Event(logx.LevelInfo, "ai", "测试连接成功",
		"model", reply.Model, "finish", reply.Finish, "chars", itoa(len([]rune(reply.Content))))
	return map[string]any{"ok": true, "reply": reply.Content}, nil
}

/* -------------------------------- capabilities ------------------------------- */

// aiAsk is a seam for the tests: the suite must never touch the network.
var aiAsk = func(ctx context.Context, cfg ai.Config, system, user string) (ai.Reply, error) {
	return ai.NewClient(cfg).Ask(ctx, system, user)
}

// aiMu serialises AI calls. The panel disables its trigger while one runs,
// but a double-tap inside that window would otherwise queue two identical
// requests; with the mutex the second finds the first one's cache entry and
// answers for free.
var aiMu sync.Mutex

// errAINotConfigured and friends are the reader-facing failures. They are
// plain strings by the time the frontend sees them (Wails serialises the
// error), which is why they are written for the reader, not the log. Each one
// names a different cause, because "it didn't work" is not something a reader
// can act on: the fix for a missing provider is settings, the fix for a
// truncated answer is retry-or-another-model.
var (
	errAINotConfigured = errors.New("AI 未配置，请先在设置中填写接口信息")
	errAIEmptyReply    = errors.New("AI 没有返回内容，请重试")
	errAIBadReply      = errors.New("AI 返回内容无法解析，请重试")
	errAITruncated     = errors.New("AI 的回答被截断了（输出达到长度上限），请重试或换一个模型")
	errAIReasoningOnly = errors.New("AI 只输出了思考过程，没有给出回答（多为输出上限不足或该模型不支持此接口），请重试或换一个模型")
)

// aiAnswer is one completed (or cached) exchange: the text plus the facts that
// explain an empty or broken one.
type aiAnswer struct {
	Text   string
	Finish string
	Cached bool
	// ReasoningChars says the provider returned thinking without an answer —
	// the signature of a reasoning model that ran out of room mid-thought.
	ReasoningChars int
}

// noContentError turns "the provider gave us nothing" into a message that says
// which of the three ways it happened.
func noContentError(a aiAnswer) error {
	switch {
	case a.Finish == "length":
		return errAITruncated
	case a.ReasoningChars > 0:
		return errAIReasoningOnly
	case a.Finish != "" && a.Finish != "stop":
		return fmt.Errorf("AI 没有返回内容（finish_reason=%s），请重试或换一个模型", a.Finish)
	}
	return errAIEmptyReply
}

// badReplyError is noContentError for a reply that arrived but could not be
// read as JSON. A cut-off answer is the common cause, and saying so is much
// more useful than "无法解析".
func badReplyError(a aiAnswer) error {
	if a.Finish == "length" {
		return errAITruncated
	}
	return errAIBadReply
}

// cacheKey composes the ai_cache key for one ask: capability, model, prompt.
//
// Every reader and writer of the cache goes through here. Three call sites
// building the string by hand is how the word card's cached read fell out of
// step with what the ask wrote the moment the key grew a model field, and the
// symptom (a card that never shows a stored explanation) points at the cache
// rather than at the key format.
func cacheKey(kind, system, user string) string {
	model := ""
	if cfg, err := aiconfig.Load(); err == nil {
		model = cfg.Model
	}
	return aicache.Key(kind, model+"\n"+system+"\n"+user)
}

// askCached answers from ai_cache when possible and otherwise calls the
// provider, storing the answer. Only non-empty answers are stored: an empty
// reply is a soft failure the reader can retry, and a network or HTTP error is
// not an answer at all. Caching either would make the retry button a lie.
func askCached(ctx context.Context, kind, system, user string) (aiAnswer, error) {
	// The key covers the exact prompt AND the model (cacheKey): an improved
	// prompt invalidates the cache by itself, and switching to a stronger model
	// because an answer was bad must not hand that same bad answer back — with
	// switching one tap away, a shared cache would make it look broken.
	key := cacheKey(kind, system, user)
	if e, err := aicache.Get(key); err == nil && e != nil && e.Response != "" {
		logx.Event(logx.LevelDebug, "ai", "命中缓存",
			"kind", kind, "chars", itoa(len([]rune(e.Response))))
		return aiAnswer{Text: e.Response, Cached: true}, nil
	}
	cfg, err := aiconfig.Load()
	if err != nil {
		logx.Event(logx.LevelError, "ai", "读取设置失败",
			"kind", kind, "file", aiconfig.Path(), "error", err.Error())
		return aiAnswer{}, fmt.Errorf("读取 AI 设置失败（%s）：%w", aiconfig.Path(), err)
	}
	if !cfg.Configured() {
		// The path is part of the message on purpose: the usual cause of "but I
		// DID configure it" is a second settings file somewhere else (another
		// AppHome, a build run with a different EPUBMAKER_HOME), and the path
		// settles that in one glance instead of a round trip.
		logx.Event(logx.LevelWarn, "ai", "未配置", "kind", kind, "file", aiconfig.Path())
		return aiAnswer{}, fmt.Errorf("%w（配置文件：%s）", errAINotConfigured, aiconfig.Path())
	}

	// The prompt is logged in full (logx clips it at a generous cap): when an
	// answer is wrong, the question is half the evidence, and it is the half a
	// provider console does not keep.
	logx.Event(logx.LevelInfo, "ai", "请求",
		"kind", kind,
		"model", cfg.Model,
		"baseUrl", cfg.BaseURL,
		"promptChars", itoa(len([]rune(system+"\n"+user))),
		"system", system,
		"user", user,
	)
	start := time.Now()
	reply, err := aiAsk(ctx, cfg, system, user)
	ms := time.Since(start).Milliseconds()
	if err != nil {
		logx.Event(logx.LevelWarn, "ai", "请求失败",
			"kind", kind, "ms", itoa64(ms), "error", err.Error())
		return aiAnswer{}, fmt.Errorf("AI 请求失败：%w", err)
	}
	logx.Event(logx.LevelInfo, "ai", "回答",
		"kind", kind,
		"ms", itoa64(ms),
		"finish", reply.Finish,
		"chars", itoa(len([]rune(reply.Content))),
		"reasoningChars", itoa(len([]rune(reply.Reasoning))),
		"tokens", itoa(reply.Usage.CompletionTokens)+"/"+itoa(reply.Usage.PromptTokens),
		"model", reply.Model,
		"content", reply.Content,
	)

	ans := aiAnswer{
		Text:           strings.TrimSpace(reply.Content),
		Finish:         reply.Finish,
		ReasoningChars: len([]rune(reply.Reasoning)),
	}
	if ans.Text == "" {
		// A warning of its own: "empty answer" should be findable in the log
		// without reading every response.
		logx.Event(logx.LevelWarn, "ai", "空回答",
			"kind", kind,
			"finish", reply.Finish,
			"reasoningChars", itoa(ans.ReasoningChars),
			"reasoningHead", firstRunes(reply.Reasoning, 200))
		return aiAnswer{}, noContentError(ans)
	}
	// A cache write must not lose the answer the reader is waiting for; a
	// failed write only costs them a second call later.
	_ = aicache.Put(aicache.Entry{Key: key, Kind: kind, Response: ans.Text})
	return ans, nil
}

/* ---------------------------- explain in context ---------------------------- */

// ExplainResult is the reader-facing gloss for one word: what it means *here*,
// what the whole sentence says, and one thing worth noticing about it.
//
// This used to ask the model to choose among the dictionary's numbered senses.
// That looked tidier but worked worse: ECDICT packs a word's meanings into one
// line ("n. 1.儿童 2.婴儿 3.子女 …"), so the model was handed a list it could not
// pick from and often answered "none of these fit" while a perfectly good sense
// sat in the middle of the line. The model can translate; asking it to explain
// and translate directly is shorter and grounded in the sentence the reader is
// actually looking at.
type ExplainResult struct {
	Word        string `json:"word"`
	Meaning     string `json:"meaning"`
	Translation string `json:"translation"`
	POS         string `json:"pos"`
	Note        string `json:"note"`
	Cached      bool   `json:"cached"`
	// ConversationId names the transcript this answer was filed under, so the
	// reader can continue it from the AI page.
	ConversationId string `json:"conversationId,omitempty"`
}

// ExplainInContext explains one word as it is used in one sentence, and
// translates that sentence.
func (b *Backend) ExplainInContext(word, sentence string) (*ExplainResult, error) {
	word = strings.TrimSpace(word)
	sentence = strings.TrimSpace(sentence)
	if word == "" || sentence == "" {
		return nil, errors.New("缺少单词或句子，无法解释")
	}
	if len([]rune(word)) > 64 || len([]rune(sentence)) > 2000 {
		return nil, errors.New("输入过长")
	}

	aiMu.Lock()
	defer aiMu.Unlock()

	system, user := explainPrompt(word, sentence)
	ans, err := askCached(context.Background(), "explain", system, user)
	if err != nil {
		return nil, err
	}
	out, err := decodeExplain(word, ans)
	if err != nil {
		return nil, err
	}
	out.Cached = ans.Cached
	out.ConversationId = recordConversation(aichat.OriginLookup, word, "explain", system, user, ans.Text)
	return out, nil
}

func explainPrompt(word, sentence string) (string, string) {
	// The prompt lives in the library (fixed id sys-word) so the reader can
	// tune it in the settings page; ContentFor falls back to the built-in
	// text when the row is missing, and Reset puts a broken edit back.
	system := aiprompt.ContentFor(aiprompt.SysWord)
	return system, "单词：" + word + "\n句子：" + sentence
}

func decodeExplain(word string, a aiAnswer) (*ExplainResult, error) {
	out := &ExplainResult{Word: word}
	raw := jsonObject(a.Text)
	if raw == "" {
		if looksLikeJSON(a.Text) {
			return nil, badReplyError(a)
		}
		// A model that ignores the JSON instruction still answered usefully;
		// showing its prose beats showing a parse error.
		out.Meaning = strings.TrimSpace(a.Text)
		if out.Meaning == "" {
			return nil, noContentError(a)
		}
		return out, nil
	}
	var r struct {
		Meaning     string `json:"meaning"`
		Translation string `json:"translation"`
		POS         string `json:"pos"`
		Note        string `json:"note"`
	}
	if err := json.Unmarshal([]byte(raw), &r); err != nil {
		return nil, badReplyError(a)
	}
	out.Meaning = strings.TrimSpace(r.Meaning)
	out.Translation = strings.TrimSpace(r.Translation)
	out.POS = strings.TrimSpace(r.POS)
	out.Note = strings.TrimSpace(r.Note)
	if out.Meaning == "" && out.Translation == "" {
		return nil, badReplyError(a)
	}
	return out, nil
}

/* ----------------------------- parse sentence ------------------------------ */

// Segment is one slice of the sentence with its grammatical role.
type Segment struct {
	Text  string `json:"text"`
	Role  string `json:"role"`
	Gloss string `json:"gloss"`
}

// ParseResult is the merged sentence view the reader sees: the translation
// and the breakdown in one panel, because they answer the same question
// ("what does this sentence say, and how is it built") and splitting them
// across two tabs only hid half the answer.
type ParseResult struct {
	Translation string    `json:"translation"`
	Segments    []Segment `json:"segments"`
	Notes       []string  `json:"notes"`
	Cached      bool      `json:"cached"`
	// ConversationId names the transcript this answer was filed under, so the
	// panel can offer "查看对话" right where the answer appeared.
	ConversationId string `json:"conversationId,omitempty"`
}

// ParseSentence translates and dissects one sentence. The sentence is the
// grounding: it is the reader's own selection, and the answer never strays
// beyond it.
func (b *Backend) ParseSentence(sentence string) (*ParseResult, error) {
	sentence = strings.TrimSpace(sentence)
	if sentence == "" {
		return nil, errors.New("句子不能为空")
	}
	if len([]rune(sentence)) > 2000 {
		return nil, errors.New("句子过长")
	}

	aiMu.Lock()
	defer aiMu.Unlock()

	system, user := parsePrompt(sentence)
	ans, err := askCached(context.Background(), "parse", system, user)
	if err != nil {
		return nil, err
	}
	out, err := decodeParse(ans)
	if err != nil {
		return nil, err
	}
	out.Cached = ans.Cached
	out.ConversationId = recordConversation(aichat.OriginParse, sentence, "parse", system, user, ans.Text)
	return out, nil
}

func parsePrompt(sentence string) (string, string) {
	// Same deal as explainPrompt: the text lives in the library (sys-sentence)
	// and is reader-tunable there.
	system := aiprompt.ContentFor(aiprompt.SysSentence)
	return system, "句子：" + sentence
}

func decodeParse(a aiAnswer) (*ParseResult, error) {
	out := &ParseResult{}
	raw := jsonObject(a.Text)
	if raw == "" {
		if looksLikeJSON(a.Text) {
			return nil, badReplyError(a)
		}
		// A model that ignores the JSON instruction and just writes the
		// translation is still useful: show it, minus the breakdown.
		out.Translation = strings.TrimSpace(a.Text)
		if out.Translation == "" {
			return nil, noContentError(a)
		}
		return out, nil
	}
	var r struct {
		Translation string    `json:"translation"`
		Segments    []Segment `json:"segments"`
		Notes       []string  `json:"notes"`
	}
	if err := json.Unmarshal([]byte(raw), &r); err != nil {
		// The usual cause is a cut-off answer: the JSON object opens, the budget
		// runs out, the closing brackets never arrive.
		return nil, badReplyError(a)
	}
	out.Translation = strings.TrimSpace(r.Translation)
	out.Segments = r.Segments
	out.Notes = r.Notes
	if out.Translation == "" && len(out.Segments) == 0 {
		return nil, noContentError(a)
	}
	return out, nil
}

/* ---------------------------- summarize chapter ----------------------------- */

// SummaryTerm is a word worth remembering from the chapter.
type SummaryTerm struct {
	Term  string `json:"term"`
	Gloss string `json:"gloss"`
}

// SummaryResult is the chapter guide. Truncated says the chapter was longer
// than the prompt budget, so the guide covers a prefix — the panel says so
// rather than pretending it read the whole chapter.
type SummaryResult struct {
	Summary   string        `json:"summary"`
	Points    []string      `json:"points"`
	Terms     []SummaryTerm `json:"terms"`
	Truncated bool          `json:"truncated"`
	Cached    bool          `json:"cached"`
	// ConversationId names the transcript this guide was filed under, so the
	// panel can offer "查看对话" right where the guide appeared.
	ConversationId string `json:"conversationId,omitempty"`
}

// summarizeBudget caps the chapter text sent to the provider. A chapter is
// 2k–20k characters; the guide only needs the shape of it, and the budget is
// what keeps one tap from costing a novel.
const summarizeBudget = 6000

// SummarizeChapter writes a short guide for one chapter from its own text.
// This is the one capability that sends a whole chapter's content to the
// provider, which is why the reader confirms the privacy question every time
// (the frontend's dialog), not once at setup.
func (b *Backend) SummarizeChapter(bookID, chapterID string) (*SummaryResult, error) {
	src, err := library.GetChapterSource(bookID, chapterID)
	if err != nil {
		return nil, err
	}
	if src == nil {
		return nil, errors.New("章节不存在")
	}
	text, truncated := chapterText(src.HTML, summarizeBudget)
	if strings.TrimSpace(text) == "" {
		return nil, errors.New("章节正文为空，无法生成导读")
	}

	aiMu.Lock()
	defer aiMu.Unlock()

	system, user := summarizePrompt(src.Title, text)
	ans, err := askCached(context.Background(), "summarize", system, user)
	if err != nil {
		return nil, err
	}
	out, err := decodeSummarize(ans)
	if err != nil {
		return nil, err
	}
	out.Truncated = truncated
	out.Cached = ans.Cached
	title := src.Title
	if strings.TrimSpace(title) == "" {
		title = "章节导读"
	}
	out.ConversationId = recordConversation(aichat.OriginSummarize, title, "summarize", system, user, ans.Text)
	return out, nil
}

func summarizePrompt(title, text string) (string, string) {
	// The 导读 prompt lives in the library (sys-guide), reader-tunable there.
	system := aiprompt.ContentFor(aiprompt.SysGuide)
	return system, "章节标题：" + title + "\n正文：\n" + text
}

func decodeSummarize(a aiAnswer) (*SummaryResult, error) {
	out := &SummaryResult{}
	raw := jsonObject(a.Text)
	if raw == "" {
		return nil, badReplyError(a)
	}
	var r struct {
		Summary string        `json:"summary"`
		Points  []string      `json:"points"`
		Terms   []SummaryTerm `json:"terms"`
	}
	if err := json.Unmarshal([]byte(raw), &r); err != nil {
		return nil, badReplyError(a)
	}
	out.Summary = strings.TrimSpace(r.Summary)
	out.Points = r.Points
	out.Terms = r.Terms
	if out.Summary == "" {
		return nil, noContentError(a)
	}
	return out, nil
}

/* --------------------------------- helpers -------------------------------- */

// blockCloseRe marks the end of a paragraph-ish element, so the flattened
// text keeps the shape the reader saw.
var blockCloseRe = regexp.MustCompile(`(?i)</(p|div|section|h[1-6]|li|blockquote|tr|br)\s*>`)

// chapterText flattens chapter HTML into plain text for the prompt. Paragraph
// breaks are kept — a wall of text summarises worse than paragraphs — and the
// result is cut to maxChars runes, with truncated reporting the cut.
func chapterText(rawHTML string, maxChars int) (string, bool) {
	withBreaks := blockCloseRe.ReplaceAllString(rawHTML, "\n")
	lines := strings.Split(withBreaks, "\n")
	kept := make([]string, 0, len(lines))
	for _, ln := range lines {
		if t := html.StripTags(ln); t != "" {
			kept = append(kept, t)
		}
	}
	text := strings.Join(kept, "\n")
	runes := []rune(text)
	if maxChars > 0 && len(runes) > maxChars {
		return string(runes[:maxChars]), true
	}
	return text, false
}

// jsonObject pulls the first {...} span out of a model reply. Providers wrap
// JSON in prose or ```json fences often enough that "just unmarshal" fails a
// third of the time; this is the cheap fix that works for all of them.
func jsonObject(s string) string {
	start := strings.Index(s, "{")
	end := strings.LastIndex(s, "}")
	if start < 0 || end <= start {
		return ""
	}
	return s[start : end+1]
}

// looksLikeJSON reports whether a reply was trying to be the JSON object the
// prompt asked for. One that opens a brace and never closes it is not prose —
// it is an answer that ran out of room, and showing it as a translation would
// put half a JSON object in front of the reader.
func looksLikeJSON(s string) bool {
	return strings.HasPrefix(strings.TrimSpace(s), "{")
}

// firstRunes is for log fields: enough to see what the model was doing, never
// enough to bloat a log line.
func firstRunes(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n]) + "…"
}

func itoa(n int) string { return fmt.Sprintf("%d", n) }

func itoa64(n int64) string { return fmt.Sprintf("%d", n) }
