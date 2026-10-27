package app

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"epubmaker-desktop/internal/ai"
	"epubmaker-desktop/internal/aichat"
	"epubmaker-desktop/internal/aiconfig"
	"epubmaker-desktop/internal/aicache"
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

// manualChatSystem is the standing prompt for conversations the reader starts
// by hand. It is stored as the first message, so the conversation page shows
// it exactly like the prompts of the grounded capabilities.
const manualChatSystem = `你是 EpubMaker 的英语阅读助手。用户正在阅读英文原版书，会问你词汇、句子和阅读相关的问题。
回答用中文，简洁清晰；英文例句和术语保留英文。`

// aiAskMsgs is the multi-turn seam, mirroring aiAsk: the suite never touches
// the network, and tests stub this to capture the exact transcript that would
// have been sent.
var aiAskMsgs = func(ctx context.Context, cfg ai.Config, msgs []ai.Message) (ai.Reply, error) {
	return ai.NewClient(cfg).AskMessages(ctx, msgs)
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

// AIConversations lists the transcripts, newest activity first.
func (b *Backend) AIConversations() ([]AIConversationDTO, error) {
	items, err := aichat.ListDetailed(200)
	if err != nil {
		return nil, err
	}
	out := make([]AIConversationDTO, len(items))
	for i, it := range items {
		out[i] = AIConversationDTO{Conversation: it.Conversation, Count: it.Count, Preview: it.Preview}
	}
	return out, nil
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
// the conversation, so the frontend needs the new id back).
type AIChatTurn struct {
	ConversationID string          `json:"conversationId"`
	User           *aichat.Message `json:"user"`
	Assistant      *aichat.Message `json:"assistant"`
}

// AIChatSend continues a conversation (or starts a manual one when id is
// empty). The whole stored transcript goes back to the provider — that is
// what "continue" means: the model answers with the context it was originally
// given, not a fresh guess.
//
// A failed call rolls the user message back. The retry then re-sends the same
// question instead of stacking a second copy of it, and the transcript keeps
// saying only what actually happened.
func (b *Backend) AIChatSend(conversationID, text string) (*AIChatTurn, error) {
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
	if conversationID == "" {
		conv = &aichat.Conversation{Title: aichat.TitleOf(text), Origin: aichat.OriginManual}
		if err := aichat.Create(conv, []aichat.Message{{Role: aichat.RoleSystem, Content: manualChatSystem}}); err != nil {
			return nil, err
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
	return &AIChatTurn{ConversationID: conv.ID, User: userMsg, Assistant: asst}, nil
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
