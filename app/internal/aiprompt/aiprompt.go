// Package aiprompt stores the reader's saved system prompts: named templates
// the LLM settings page maintains and a hand-made conversation picks from when
// it starts.
//
// The library lives in the library database next to ai_conversations, but it
// is a library and not a source of truth: the prompt a conversation actually
// used is stored as that conversation's first message, so editing or deleting
// a prompt here never rewrites an existing transcript. A deleted prompt only
// stops being offered to conversations that have not started yet.
//
// Seeded system prompts (对话 / 查词 / 拆句 / 导读) carry fixed ids. They are
// the built-in prompts the app itself ships with: they cannot be deleted,
// editing them is allowed but discouraged (the JSON-shaped ones feed the
// lookup / parse / guide features directly), and 恢复默认 puts the built-in
// text back in one tap.
package aiprompt

import (
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"strings"
	"time"

	"epubmaker-desktop/internal/aiconfig"
	"epubmaker-desktop/internal/db"
)

// nameRunes caps what a list row can show; contentRunes caps the prompt at a
// size that is generous for a system prompt and harmless to store.
const (
	nameRunes    = 40
	contentRunes = 8000
)

// Fixed ids of the seeded system prompts. A reset and the feature lookups
// resolve by these, so they must never change once shipped.
const (
	SysChat     = "sys-chat"     // the standing prompt hand-made chats open with
	SysWord     = "sys-word"     // 查词: explains a word in its sentence
	SysSentence = "sys-sentence" // 拆句: translates and parses a sentence
	SysGuide    = "sys-guide"    // 导读: summarizes a chapter
)

// BuiltinWord is the 查词 prompt: explainPrompt sends it verbatim, so the
// JSON contract here and in decodeExplain must stay in step.
const BuiltinWord = `你是英语阅读助手。读者正在读原版书，遇到了一个词，给你这个词和它所在的句子。
请结合句子回答三件事：
1. 这个词在本句中的意思；
2. 整句的中文翻译；
3. 一条最值得注意的用法、搭配或语法点，没有就留空。
只输出 JSON，格式：
{"meaning":"本句中的意思","translation":"整句翻译","pos":"n./v./adj. 这样的词性","note":"用法提示"}
规则：
- meaning 用一句中文说清「在这个句子里它是什么意思」，不要罗列词典释义。
- translation 要通顺自然，像人话，不要逐词直译。
- pos 只填词性缩写，拿不准就填空字符串。
- note 最多一条，不要重复 meaning 的内容。
- 不要输出 JSON 以外的任何内容。`

// BuiltinSentence is the 拆句 prompt; decodeParse reads its JSON back.
const BuiltinSentence = `你是英语语法老师。用户给你一个英文句子，请翻译并拆解它。
只输出 JSON，格式：
{"translation": "整句中文翻译",
 "segments": [{"text": "原文片段", "role": "语法角色", "gloss": "该片段的中文"}],
 "notes": ["语法点提示"]}
规则：
- translation 在前，要通顺自然，像人话。
- segments 按句子结构切分且覆盖整个句子，role 用「主语/谓语/宾语/定语/状语/补语」等中文术语。
- notes 最多 2 条，讲这个句子最值得学的语法点；没有值得讲的就给空数组。
- 不要输出 JSON 以外的任何内容。`

// BuiltinGuide is the 导读 prompt; decodeSummarize reads its JSON back.
const BuiltinGuide = `你是阅读伴侣。用户给你一本书某一章的标题和正文（可能被截断）。
只输出 JSON，格式：
{"summary": "本章内容的中文摘要，100 字以内",
 "points": ["本章要点，2-4 条，每条不超过 30 字"],
 "terms": [{"term": "值得记住的英文词", "gloss": "中文释义"}]}
规则：
- summary 概括本章讲了什么或发生了什么。
- points 是章节要点，按行文顺序。
- terms 挑 3-5 个值得学习的词，优先生词和反复出现的词。
- 不要输出 JSON 以外的任何内容。`

// builtinFor maps a system id to its built-in name and text. A system row
// always has an entry here — the flag alone does not make a prompt resettable.
func builtinFor(id string) (name, content string, ok bool) {
	switch id {
	case SysChat:
		return "对话", aiconfig.DefaultChatSystem, true
	case SysWord:
		return "查词", BuiltinWord, true
	case SysSentence:
		return "拆句", BuiltinSentence, true
	case SysGuide:
		return "导读", BuiltinGuide, true
	}
	return "", "", false
}

// Prompt is one saved system prompt.
type Prompt struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Content   string `json:"content"`
	System    bool   `json:"system"`
	// Default is the built-in text of a system prompt, carried so the form
	// can show 恢复默认 only when the text has drifted. Empty for user rows.
	Default   string `json:"default,omitempty"`
	CreatedAt string `json:"createdAt"`
	UpdatedAt string `json:"updatedAt"`
}

func uid() string {
	b := make([]byte, 12)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func nowIso() string { return time.Now().UTC().Format(time.RFC3339Nano) }

func clamp(s string, n int) string {
	r := []rune(strings.TrimSpace(s))
	if len(r) > n {
		return string(r[:n])
	}
	return string(r)
}

// Validate reports what the form can get wrong. The name is what a picker row
// shows, so an empty one has nothing to show; the content is the whole point.
func Validate(name, content string) error {
	if strings.TrimSpace(name) == "" {
		return errors.New("请填写提示词名称")
	}
	if strings.TrimSpace(content) == "" {
		return errors.New("请填写提示词内容")
	}
	return nil
}

// seed inserts any missing system prompt. Not a sync.Once: a cheap COUNT
// decides, which both keeps the per-call cost negligible and heals a database
// whose system rows were wiped by hand — they are part of the app, not data.
// The 对话 row starts from the reader's configured standing prompt when one
// exists — the library absorbed the old 对话提示词 setting (AISaveChatSystem),
// and this is the one-time migration. INSERT OR IGNORE means a reader's edits
// are never overwritten by an upgrade or a later start.
func seed() {
	d, err := db.Open()
	if err != nil {
		return // List/Get will surface the broken database on their own
	}
	var n int
	if err := d.QueryRow(`SELECT COUNT(*) FROM ai_prompts WHERE is_system = 1`).Scan(&n); err != nil || n >= 4 {
		return
	}
	chat := aiconfig.DefaultChatSystem
	if cfg, err := aiconfig.Load(); err == nil && strings.TrimSpace(cfg.ChatSystem) != "" {
		chat = cfg.ChatSystem
	}
	for _, p := range []Prompt{
		{ID: SysChat, Name: "对话", Content: chat, System: true},
		{ID: SysWord, Name: "查词", Content: BuiltinWord, System: true},
		{ID: SysSentence, Name: "拆句", Content: BuiltinSentence, System: true},
		{ID: SysGuide, Name: "导读", Content: BuiltinGuide, System: true},
	} {
		_, _ = d.Exec(
			`INSERT OR IGNORE INTO ai_prompts (id, name, content, is_system, created_at, updated_at)
			 VALUES (?, ?, ?, 1, ?, ?)`,
			p.ID, p.Name, p.Content, nowIso(), nowIso())
	}
}

// List returns every saved prompt, most recently touched first — the order a
// picker wants, since the prompt edited last is the one likely wanted next.
func List() ([]Prompt, error) {
	seed()
	d, err := db.Open()
	if err != nil {
		return nil, err
	}
	rows, err := d.Query(
		`SELECT id, name, content, is_system, created_at, updated_at FROM ai_prompts ORDER BY updated_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Prompt{}
	for rows.Next() {
		var p Prompt
		var sys int
		if err := rows.Scan(&p.ID, &p.Name, &p.Content, &sys, &p.CreatedAt, &p.UpdatedAt); err != nil {
			return nil, err
		}
		p.System = sys != 0
		if _, builtin, ok := builtinFor(p.ID); ok {
			p.Default = builtin
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// Get returns one prompt, or nil when the id is unknown — a picker row can
// outlive its prompt (deleted on another window), and that is a fallback to
// the default, not an error dialog.
func Get(id string) (*Prompt, error) {
	if strings.TrimSpace(id) == "" {
		return nil, nil
	}
	seed()
	d, err := db.Open()
	if err != nil {
		return nil, err
	}
	var p Prompt
	var sys int
	err = d.QueryRow(
		`SELECT id, name, content, is_system, created_at, updated_at FROM ai_prompts WHERE id = ?`, id).
		Scan(&p.ID, &p.Name, &p.Content, &sys, &p.CreatedAt, &p.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	p.System = sys != 0
	if _, builtin, ok := builtinFor(p.ID); ok {
		p.Default = builtin
	}
	return &p, nil
}

// ContentFor resolves what a feature should actually send: the library row's
// text when it exists, else the built-in text for a system id, else "". The
// feature prompts (查词 / 拆句 / 导读) read through this, which is what makes
// editing them in the settings page real; a missing row degrades to the
// built-in instead of breaking the feature.
func ContentFor(id string) string {
	if p, err := Get(id); err == nil && p != nil && strings.TrimSpace(p.Content) != "" {
		return p.Content
	}
	if _, builtin, ok := builtinFor(id); ok {
		return builtin
	}
	return ""
}

// systemRow reports whether the given id is a seeded system prompt. The flag
// travels with the row, but the fixed ids are the authority: a user prompt
// cannot be named into existence as a system prompt.
func isSystemRow(d *sql.DB, id string) bool {
	var sys int
	if err := d.QueryRow(`SELECT is_system FROM ai_prompts WHERE id = ?`, id).Scan(&sys); err != nil {
		_, _, ok := builtinFor(id)
		return ok // a row that is not there yet but is a fixed id stays system
	}
	return sys != 0
}

// Save creates (blank id) or updates a prompt. The clamps are silent because
// they only bite on absurd input the form already discourages. A system row
// may be edited (its name and text are the reader's to tune) but the system
// flag itself is not writable: a save on a fixed id stays system, and a blank
// id always creates a user prompt.
func Save(p *Prompt) error {
	p.Name = clamp(p.Name, nameRunes)
	p.Content = clamp(p.Content, contentRunes)
	if err := Validate(p.Name, p.Content); err != nil {
		return err
	}
	d, err := db.Open()
	if err != nil {
		return err
	}
	if p.ID == "" {
		p.ID = uid()
		p.CreatedAt = nowIso()
		p.UpdatedAt = p.CreatedAt
		p.System = false
		_, err = d.Exec(
			`INSERT INTO ai_prompts (id, name, content, is_system, created_at, updated_at)
			 VALUES (?, ?, ?, 0, ?, ?)`,
			p.ID, p.Name, p.Content, p.CreatedAt, p.UpdatedAt)
		return err
	}
	p.System = isSystemRow(d, p.ID)
	p.UpdatedAt = nowIso()
	_, err = d.Exec(
		`UPDATE ai_prompts SET name = ?, content = ?, updated_at = ? WHERE id = ?`,
		p.Name, p.Content, p.UpdatedAt, p.ID)
	return err
}

// Delete removes one prompt. System prompts are part of the app: they seed on
// every start, so deleting one would be a lie — refuse instead. Existing
// conversations keep the copy of the text they stored when they started.
func Delete(id string) error {
	d, err := db.Open()
	if err != nil {
		return err
	}
	if isSystemRow(d, id) {
		return errors.New("系统提示词不能删除")
	}
	_, err = d.Exec(`DELETE FROM ai_prompts WHERE id = ?`, id)
	return err
}

// Reset puts a system prompt back to its built-in name and text. Only fixed
// ids qualify; anything else is a caller bug, not a user action.
func Reset(id string) error {
	name, content, ok := builtinFor(id)
	if !ok {
		return errors.New("只有系统提示词可以恢复默认")
	}
	d, err := db.Open()
	if err != nil {
		return err
	}
	res, err := d.Exec(
		`UPDATE ai_prompts SET name = ?, content = ?, updated_at = ? WHERE id = ?`,
		name, content, nowIso(), id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return errors.New("系统提示词不存在")
	}
	return nil
}
