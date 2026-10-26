package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"sync"

	"epubmaker-desktop/internal/aicache"
	"epubmaker-desktop/internal/aiconfig"
	"epubmaker-desktop/internal/ai"
	"epubmaker-desktop/internal/html"
	"epubmaker-desktop/internal/library"
)

// The AI features are grounded by design (ADR-10): every one of them hangs off
// material the app already holds — the dictionary's own senses, the sentence
// the reader selected, the chapter they are reading. Nothing is generated from
// nothing, which is what keeps hallucination, cost, and the privacy question
// all bounded: the model picks, translates, or summarises; it does not invent
// facts about a book it has not been given.
//
// Every call is an explicit reader action (red line 2a), bounded to one
// request timeout (2b), and its answer lands in ai_cache so the same question
// is never paid for twice (2c).

/* ------------------------------ configuration ------------------------------ */

// GetAIConfig returns the AI settings for the settings page, with the key
// masked: the frontend never receives it, so it can only show whether one is
// stored, never leak it into a screenshot or a bug report.
func (b *Backend) GetAIConfig() (*aiconfig.View, error) {
	cfg, err := aiconfig.Load()
	if err != nil {
		return nil, err
	}
	v := aiconfig.NewView(cfg)
	return &v, nil
}

// SaveAIConfig stores the settings. A blank key keeps the stored one — the
// settings page never receives the key, so a model-only change sends a blank
// one back.
func (b *Backend) SaveAIConfig(baseURL, apiKey, model string) error {
	return aiconfig.Save(ai.Config{BaseURL: baseURL, APIKey: apiKey, Model: model})
}

// AITestConnection makes one tiny real call against the stored settings, so
// the settings page can show whether they work before the reader relies on
// them. It is the only AI call the app makes without the reader asking for
// content — and it is still an explicit button press.
func (b *Backend) AITestConnection() (map[string]any, error) {
	cfg, err := aiconfig.Load()
	if err != nil {
		return nil, err
	}
	if !cfg.Configured() {
		return map[string]any{"ok": false, "error": errAINotConfigured.Error()}, nil
	}
	reply, err := aiChat(context.Background(), cfg,
		"你是一个连接测试服务，只用于验证接口可用。",
		"请回复：连接正常")
	if err != nil {
		return map[string]any{"ok": false, "error": "AI 请求失败：" + err.Error()}, nil
	}
	if strings.TrimSpace(reply) == "" {
		return map[string]any{"ok": false, "error": "接口返回了空内容，请检查模型名称"}, nil
	}
	return map[string]any{"ok": true, "reply": reply}, nil
}

/* -------------------------------- capabilities ------------------------------- */

// aiChat is a seam for the tests: the suite must never touch the network.
var aiChat = func(ctx context.Context, cfg ai.Config, system, user string) (string, error) {
	return ai.NewClient(cfg).Chat(ctx, system, user)
}

// aiMu serialises AI calls. The panel disables its trigger while one runs,
// but a double-tap inside that window would otherwise queue two identical
// requests; with the mutex the second finds the first one's cache entry and
// answers for free.
var aiMu sync.Mutex

// errAINotConfigured and friends are the reader-facing failures. They are
// plain strings by the time the frontend sees them (Wails serialises the
// error), which is why they are written for the reader, not the log.
var (
	errAINotConfigured = errors.New("AI 未配置，请先在设置中填写接口信息")
	errAIEmptyReply    = errors.New("AI 没有返回内容，请重试")
	errAIBadReply      = errors.New("AI 返回内容无法解析，请重试")
)

// askCached answers from ai_cache when possible and otherwise calls the
// provider, storing the answer. Only non-empty answers are stored: an empty
// reply is a soft failure the reader can retry, and a network or HTTP error is
// not an answer at all. Caching either would make the retry button a lie.
func askCached(ctx context.Context, kind, system, user string) (string, bool, error) {
	// The key covers the exact prompt: an improved prompt invalidates the
	// cache by itself, which is what should happen when the questions get
	// better.
	key := aicache.Key(kind, system+"\n"+user)
	if e, err := aicache.Get(key); err == nil && e != nil && e.Response != "" {
		return e.Response, true, nil
	}
	cfg, err := aiconfig.Load()
	if err != nil {
		return "", false, fmt.Errorf("读取 AI 设置失败（%s）：%w", aiconfig.Path(), err)
	}
	if !cfg.Configured() {
		// The path is part of the message on purpose: the usual cause of "but I
		// DID configure it" is a second settings file somewhere else (another
		// AppHome, a build run with a different EPUBMAKER_HOME), and the path
		// settles that in one glance instead of a round trip.
		return "", false, fmt.Errorf("%w（配置文件：%s）", errAINotConfigured, aiconfig.Path())
	}
	reply, err := aiChat(ctx, cfg, system, user)
	if err != nil {
		return "", false, fmt.Errorf("AI 请求失败：%w", err)
	}
	if strings.TrimSpace(reply) == "" {
		return "", false, errAIEmptyReply
	}
	// A cache write must not lose the answer the reader is waiting for; a
	// failed write only costs them a second call later.
	_ = aicache.Put(aicache.Entry{Key: key, Kind: kind, Response: reply})
	return reply, false, nil
}

/* ---------------------------- explain in context ---------------------------- */

// ExplainResult is the contextual gloss for one word: which of the
// dictionary's own senses the sentence is using, plus a one-line Chinese
// explanation. Sense is 1-based, matching the numbered list the prompt shows;
// -1 means the model found none of the senses fitting.
type ExplainResult struct {
	Word      string `json:"word"`
	Sense     int    `json:"sense"`
	SenseText string `json:"senseText"`
	Note      string `json:"note"`
	Cached    bool   `json:"cached"`
}

// ExplainInContext asks the model to pick the sense a word carries in the
// sentence it appeared in — from the local dictionary's own senses, numbered.
// The senses are the grounding: the model chooses between them and explains
// the choice, so there is nothing to hallucinate and nothing to fact-check.
func (b *Backend) ExplainInContext(word, sentence string, senses []string) (*ExplainResult, error) {
	word = strings.TrimSpace(word)
	sentence = strings.TrimSpace(sentence)
	if word == "" || sentence == "" || len(senses) == 0 {
		return nil, errors.New("缺少词、句子或词典义项，无法解释")
	}
	if len(word) > 64 || len(sentence) > 2000 || len(senses) > 12 {
		return nil, errors.New("输入过长")
	}

	aiMu.Lock()
	defer aiMu.Unlock()

	system, user := explainPrompt(word, sentence, senses)
	reply, cached, err := askCached(context.Background(), "explain", system, user)
	if err != nil {
		return nil, err
	}
	out, err := decodeExplain(word, senses, reply)
	if err != nil {
		return nil, err
	}
	out.Cached = cached
	return out, nil
}

func explainPrompt(word, sentence string, senses []string) (string, string) {
	system := `你是英语阅读助手。用户会给你一个单词、它所在的句子、以及本地词典列出的义项（编号从 1 开始）。
你的任务：判断这个句子实际使用的是哪个义项，并用一句中文解释它在这里的含义。
规则：
- sense 只能取给出的义项编号；没有合适义项时填 -1。
- note 始终用一句中文（40 字以内）：解释了该词在本句中的意思；sense 为 -1 时说明为何都不贴合。
- 只输出 JSON，格式：{"sense": 编号, "note": "..."}`
	var b strings.Builder
	b.WriteString("单词：")
	b.WriteString(word)
	b.WriteString("\n句子：")
	b.WriteString(sentence)
	b.WriteString("\n义项：")
	for i, s := range senses {
		fmt.Fprintf(&b, "\n%d. %s", i+1, s)
	}
	return system, b.String()
}

func decodeExplain(word string, senses []string, reply string) (*ExplainResult, error) {
	raw := jsonObject(reply)
	if raw == "" {
		return nil, errAIBadReply
	}
	var r struct {
		Sense int    `json:"sense"`
		Note  string `json:"note"`
	}
	if err := json.Unmarshal([]byte(raw), &r); err != nil {
		return nil, errAIBadReply
	}
	out := &ExplainResult{Word: word, Sense: -1, Note: strings.TrimSpace(r.Note)}
	if r.Sense >= 1 && r.Sense <= len(senses) {
		out.Sense = r.Sense
		out.SenseText = senses[r.Sense-1]
	}
	if out.Note == "" {
		return nil, errAIEmptyReply
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
}

// ParseSentence translates and dissects one sentence. The sentence is the
// grounding: it is the reader's own selection, and the answer never strays
// beyond it.
func (b *Backend) ParseSentence(sentence string) (*ParseResult, error) {
	sentence = strings.TrimSpace(sentence)
	if sentence == "" {
		return nil, errors.New("句子不能为空")
	}
	if len(sentence) > 2000 {
		return nil, errors.New("句子过长")
	}

	aiMu.Lock()
	defer aiMu.Unlock()

	system, user := parsePrompt(sentence)
	reply, cached, err := askCached(context.Background(), "parse", system, user)
	if err != nil {
		return nil, err
	}
	out, err := decodeParse(reply)
	if err != nil {
		return nil, err
	}
	out.Cached = cached
	return out, nil
}

func parsePrompt(sentence string) (string, string) {
	system := `你是英语语法老师。用户给你一个英文句子，请翻译并拆解它。
只输出 JSON，格式：
{"translation": "整句中文翻译",
 "segments": [{"text": "原文片段", "role": "语法角色", "gloss": "该片段的中文"}],
 "notes": ["语法点提示"]}
规则：
- segments 按句子结构切分且覆盖整个句子，role 用「主语/谓语/宾语/定语/状语/补语」等中文术语。
- notes 最多 2 条，讲这个句子最值得学的语法点；没有值得讲的就给空数组。
- 不要输出 JSON 以外的任何内容。`
	return system, "句子：" + sentence
}

func decodeParse(reply string) (*ParseResult, error) {
	out := &ParseResult{}
	raw := jsonObject(reply)
	if raw == "" {
		// A model that ignores the JSON instruction and just writes the
		// translation is still useful: show it, minus the breakdown.
		out.Translation = strings.TrimSpace(reply)
		if out.Translation == "" {
			return nil, errAIEmptyReply
		}
		return out, nil
	}
	var r struct {
		Translation string    `json:"translation"`
		Segments    []Segment `json:"segments"`
		Notes       []string  `json:"notes"`
	}
	if err := json.Unmarshal([]byte(raw), &r); err != nil {
		return nil, errAIBadReply
	}
	out.Translation = strings.TrimSpace(r.Translation)
	out.Segments = r.Segments
	out.Notes = r.Notes
	if out.Translation == "" && len(out.Segments) == 0 {
		return nil, errAIEmptyReply
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
	reply, cached, err := askCached(context.Background(), "summarize", system, user)
	if err != nil {
		return nil, err
	}
	out, err := decodeSummarize(reply)
	if err != nil {
		return nil, err
	}
	out.Truncated = truncated
	out.Cached = cached
	return out, nil
}

func summarizePrompt(title, text string) (string, string) {
	system := `你是阅读伴侣。用户给你一本书某一章的标题和正文（可能被截断）。
只输出 JSON，格式：
{"summary": "本章内容的中文摘要，100 字以内",
 "points": ["本章要点，2-4 条，每条不超过 30 字"],
 "terms": [{"term": "值得记住的英文词", "gloss": "中文释义"}]}
规则：
- summary 概括本章讲了什么或发生了什么。
- points 是章节要点，按行文顺序。
- terms 挑 3-5 个值得学习的词，优先生词和反复出现的词。
- 不要输出 JSON 以外的任何内容。`
	return system, "章节标题：" + title + "\n正文：\n" + text
}

func decodeSummarize(reply string) (*SummaryResult, error) {
	out := &SummaryResult{}
	raw := jsonObject(reply)
	if raw == "" {
		return nil, errAIBadReply
	}
	var r struct {
		Summary string        `json:"summary"`
		Points  []string      `json:"points"`
		Terms   []SummaryTerm `json:"terms"`
	}
	if err := json.Unmarshal([]byte(raw), &r); err != nil {
		return nil, errAIBadReply
	}
	out.Summary = strings.TrimSpace(r.Summary)
	out.Points = r.Points
	out.Terms = r.Terms
	if out.Summary == "" {
		return nil, errAIEmptyReply
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
