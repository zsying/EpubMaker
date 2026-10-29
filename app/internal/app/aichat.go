package app

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"epubmaker-desktop/internal/ai"
	"epubmaker-desktop/internal/aicache"
	"epubmaker-desktop/internal/aichat"
	"epubmaker-desktop/internal/aiconfig"
	"epubmaker-desktop/internal/aiprompt"
	"epubmaker-desktop/internal/logx"
)

// The conversation layer sits on top of the three grounded capabilities: every
// successful explain / parse / summarize is filed as a transcript (system
// prompt, user input, assistant reply), the AI page lists and replays them,
// and any of them can be continued — the stored messages go back to the
// provider verbatim, so the model keeps the context it was originally given.
//
// Two invariants:
//
//   - One question, one transcript. A repeat lookup is an ai_cache hit, and
//     the conversation lookup by cache key keeps the repeat from doubling the
//     row. A changed prompt (a better question) is a new key and a new
//     conversation, which is the honest outcome.
//   - A failed ask records nothing. A transcript without an answer cannot be
//     continued, and a dead row in the list would read as a bug.

// aiAskMsgs is the multi-turn seam, mirroring aiAsk: the suite never touches
// the network, and tests stub this to capture the exact transcript that would
// have been sent.
var aiAskMsgs = func(ctx context.Context, cfg ai.Config, msgs []ai.Message) (ai.Reply, error) {
	return ai.NewClient(cfg).AskMessages(ctx, msgs)
}

// standingSystem resolves the standing prompt: the 对话 row (sys-chat, which
// the LLM page maintains inside the library), then the reader's configured
// text, then the built-in default. The configured text is nearly always
// shadowed — seeding copied it into the row — but it stays in the chain so an
// old config still answers even if its row vanished.
func standingSystem(cfg ai.Config) string {
	if p, err := aiprompt.Get(aiprompt.SysChat); err == nil && p != nil && strings.TrimSpace(p.Content) != "" {
		return p.Content
	}
	return aiconfig.ChatSystemFor(cfg)
}

// chatSystemFor a hand-made conversation: a prompt picked from the library
// wins; otherwise (no pick, or a picked row that has since been deleted) the
// standing prompt opens the chat. The chosen text is stored as the
// conversation's first message, so the transcript always shows what actually
// shaped the answers, and later edits to the library never reach back into it.
func chatSystemFor(promptID string, cfg ai.Config) string {
	if promptID != "" && promptID != aiprompt.SysChat {
		if p, err := aiprompt.Get(promptID); err == nil && p != nil {
			return p.Content
		}
	}
	return standingSystem(cfg)
}

// recordConversation files one completed exchange. It is idempotent per cache
// key: the conversation that already exists is returned untouched, so a
// re-asked question keeps a single transcript. Failure is logged, never
// returned — a conversation row that failed to write must not fail the answer
// the reader is already looking at.
func recordConversation(origin, title, kind, system, user, answer string) string {
	key := aicache.Key(kind, system+"\n"+user)
	if c, err := aichat.ByCacheKey(key); err == nil && c != nil {
		return c.ID
	}
	c := &aichat.Conversation{Title: aichat.TitleOf(title), Origin: origin, CacheKey: key}
	msgs := []aichat.Message{
		{Role: aichat.RoleSystem, Content: system},
		{Role: aichat.RoleUser, Content: user},
		{Role: aichat.RoleAssistant, Content: answer},
	}
	if err := aichat.Create(c, msgs); err != nil {
		logx.Event(logx.LevelWarn, "ai", "对话记录失败", "kind", kind, "error", err.Error())
		return ""
	}
	return c.ID
}

/* ------------------------------ list & detail ------------------------------ */

// AIConversationDTO is one list row: the header plus the two facts the row
// shows — how many turns it holds and the last thing said in it.
type AIConversationDTO struct {
	aichat.Conversation
	Count   int    `json:"count"`
	Preview string `json:"preview"`
}

// AIConversationPage is one slice of the list plus what it takes to ask for
// the next one. Total is counted separately so the frontend can label the
// header ("128 条") without loading all 128 rows: a year of lookups is a few
// thousand transcripts, and the page is a scrolling list, not an export.
type AIConversationPage struct {
	Items   []AIConversationDTO `json:"items"`
	Total   int                 `json:"total"`
	HasMore bool                `json:"hasMore"`
}

// defaultConvPage and maxConvPage bound one request. The page asks for 30 at a
// time; the ceiling keeps a bad caller from turning one scroll into a full
// table read.
const (
	defaultConvPage = 30
	maxConvPage     = 100
)

// AIConversations lists the transcripts, newest activity first, one page at a
// time. origin narrows the list to one kind (查词 / 拆句 / 导读 / 对话) and
// keyword searches titles and message bodies; both empty is the whole library,
// which is what the page opens on. Filtering lives here rather than in the
// page because the list is paged: a client-side filter would only ever search
// the thirty rows already on screen.
//
// A non-positive limit means "the default page", not "everything": the caller
// that genuinely wants all of them pages through.
func (b *Backend) AIConversations(origin, keyword string, offset, limit int) (*AIConversationPage, error) {
	if limit <= 0 {
		limit = defaultConvPage
	}
	if limit > maxConvPage {
		limit = maxConvPage
	}
	if offset < 0 {
		offset = 0
	}
	f := aichat.Filter{Origin: origin, Keyword: keyword}
	total, err := aichat.CountFiltered(f)
	if err != nil {
		return nil, err
	}
	items, err := aichat.ListDetailed(f, limit, offset)
	if err != nil {
		return nil, err
	}
	out := make([]AIConversationDTO, len(items))
	for i, it := range items {
		out[i] = AIConversationDTO{Conversation: it.Conversation, Count: it.Count, Preview: it.Preview}
	}
	return &AIConversationPage{
		Items:   out,
		Total:   total,
		HasMore: offset+len(out) < total,
	}, nil
}

// AIConversationDetail is the conversation page's payload: the header and the
// full transcript, system prompt included.
type AIConversationDetail struct {
	aichat.Conversation
	Messages []aichat.Message `json:"messages"`
}

// AIConversation returns one transcript in full.
func (b *Backend) AIConversation(id string) (*AIConversationDetail, error) {
	c, err := aichat.Get(id)
	if err != nil {
		return nil, err
	}
	if c == nil {
		return nil, nil
	}
	msgs, err := aichat.Messages(id)
	if err != nil {
		return nil, err
	}
	return &AIConversationDetail{Conversation: *c, Messages: msgs}, nil
}

// AIConversationDelete removes a transcript and its messages (the foreign key
// cascades).
func (b *Backend) AIConversationDelete(id string) error {
	return aichat.Delete(id)
}

/* --------------------------------- chatting -------------------------------- */

// AIChatTurn is one continuation: the question as stored, the answer as
// stored, and the conversation they belong to (a manual first message creates
// the conversation, so the frontend needs the new id back). System is the
// opening prompt of a conversation this call created, so the room can show
// the prompt it just started with instead of keeping it a surprise for the
// next visit.
type AIChatTurn struct {
	ConversationID string          `json:"conversationId"`
	System         *aichat.Message `json:"system,omitempty"`
	User           *aichat.Message `json:"user"`
	Assistant      *aichat.Message `json:"assistant"`
}

// AIChatSend continues a conversation (or starts a manual one when id is
// empty). The whole stored transcript goes back to the provider — that is
// what "continue" means: the model answers with the context it was originally
// given, not a fresh guess.
//
// promptID only matters when a conversation is being created: it names a
// library prompt to open the transcript with. A conversation that already
// exists keeps the system prompt it was born with — that is the prompt its
// earlier answers were shaped by, and swapping it mid-flight would make the
// transcript lie about what happened.
//
// A failed call rolls the user message back. The retry then re-sends the same
// question instead of stacking a second copy of it, and the transcript keeps
// saying only what actually happened.
func (b *Backend) AIChatSend(conversationID, text, promptID string) (*AIChatTurn, error) {
	text = strings.TrimSpace(text)
	if text == "" {
		return nil, errors.New("消息不能为空")
	}
	if len([]rune(text)) > 4000 {
		return nil, errors.New("消息过长，请分开发送")
	}
	cfg, err := aiconfig.Load()
	if err != nil {
		return nil, err
	}
	if !cfg.Configured() {
		return nil, fmt.Errorf("%w（配置文件：%s）", errAINotConfigured, aiconfig.Path())
	}

	aiMu.Lock()
	defer aiMu.Unlock()

	var conv *aichat.Conversation
	var opening *aichat.Message
	if conversationID == "" {
		conv = &aichat.Conversation{Title: aichat.TitleOf(text), Origin: aichat.OriginManual}
		if err := aichat.Create(conv, []aichat.Message{{Role: aichat.RoleSystem, Content: chatSystemFor(promptID, cfg)}}); err != nil {
			return nil, err
		}
		if msgs, err := aichat.Messages(conv.ID); err == nil && len(msgs) > 0 {
			opening = &msgs[0]
		}
	} else {
		conv, err = aichat.Get(conversationID)
		if err != nil {
			return nil, err
		}
		if conv == nil {
			return nil, errors.New("对话不存在")
		}
	}

	history, err := aichat.Messages(conv.ID)
	if err != nil {
		return nil, err
	}
	userMsg, err := aichat.Append(conv.ID, aichat.RoleUser, text)
	if err != nil {
		return nil, err
	}

	// The wire transcript: the stored system prompt (every conversation has
	// one — the grounded kinds store their own, manual chats got it above)
	// plus the exchange so far, ending with the new question.
	msgs := make([]ai.Message, 0, len(history)+1)
	for _, m := range history {
		if m.Role == aichat.RoleUser || m.Role == aichat.RoleAssistant || m.Role == aichat.RoleSystem {
			msgs = append(msgs, ai.Message{Role: m.Role, Content: m.Content})
		}
	}
	msgs = append(msgs, ai.Message{Role: aichat.RoleUser, Content: text})

	logx.Event(logx.LevelInfo, "ai", "继续对话",
		"conversation", conv.ID, "origin", conv.Origin, "messages", itoa(len(msgs)))

	reply, err := aiAskMsgs(context.Background(), cfg, msgs)
	if err != nil {
		_ = aichat.DeleteMessage(userMsg.ID)
		logx.Event(logx.LevelWarn, "ai", "继续对话失败", "conversation", conv.ID, "error", err.Error())
		return nil, fmt.Errorf("AI 请求失败：%w", err)
	}
	ans := aiAnswer{
		Text:           strings.TrimSpace(reply.Content),
		Finish:         reply.Finish,
		ReasoningChars: len([]rune(reply.Reasoning)),
	}
	if ans.Text == "" {
		_ = aichat.DeleteMessage(userMsg.ID)
		return nil, noContentError(ans)
	}
	asst, err := aichat.Append(conv.ID, aichat.RoleAssistant, ans.Text)
	if err != nil {
		return nil, err
	}
	return &AIChatTurn{ConversationID: conv.ID, System: opening, User: userMsg, Assistant: asst}, nil
}

/* ------------------------- cached lookup for the card ----------------------- */

// AIExplainCached answers the word card's question "has this word + sentence
// been explained by the AI already?" without touching the network. A hit
// carries the stored explanation and the conversation it came from; a miss is
// a quiet nil — the card simply keeps its dictionary view, and the ✦ button
// asks for real.
func (b *Backend) AIExplainCached(word, sentence string) (*ExplainResult, error) {
	word = strings.TrimSpace(word)
	sentence = strings.TrimSpace(sentence)
	if word == "" || sentence == "" {
		return nil, nil
	}
	system, user := explainPrompt(word, sentence)
	key := aicache.Key("explain", system+"\n"+user)
	e, err := aicache.Get(key)
	if err != nil || e == nil || e.Response == "" {
		return nil, nil
	}
	out, err := decodeExplain(word, aiAnswer{Text: e.Response, Cached: true})
	if err != nil {
		// A stored reply that no longer decodes (an older format, say) is a
		// miss for the card, not an error the reader can act on.
		return nil, nil
	}
	out.Cached = true
	if c, err := aichat.ByCacheKey(key); err == nil && c != nil {
		out.ConversationId = c.ID
	}
	return out, nil
}
