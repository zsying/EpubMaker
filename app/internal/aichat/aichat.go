// Package aichat stores AI conversations: every explain / parse / summarize
// answer is one transcript (system prompt, user input, assistant reply), and
// the reader can continue any of them or start a fresh manual chat.
//
// The tables live in the library database next to ai_cache, and a
// conversation carries the cache key of the call that created it: the same
// word tapped twice must not grow two identical transcripts, so recording
// looks the key up first and skips when the exchange is already on file.
//
// Deletion is a UI affordance, not data hygiene — the transcripts are small
// (a few KB each) and the reader, not a retention job, decides what stays.
package aichat

import (
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"epubmaker-desktop/internal/db"
)

// Roles as the provider protocol spells them; system is stored, not just
// replayed, because the reader asked to see the full transcript — the prompt
// that shaped every answer is part of what happened.
const (
	RoleSystem    = "system"
	RoleUser      = "user"
	RoleAssistant = "assistant"
)

// Origins tell the list page where a conversation came from: a lookup, a
// sentence parse, a chapter guide, or a chat the reader started by hand.
const (
	OriginLookup    = "lookup"
	OriginParse     = "parse"
	OriginSummarize = "summarize"
	OriginManual    = "manual"
)

// titleRunes caps the auto-generated title. It is a list-page label, not the
// content: forty runes is enough to recognise "Melissa … 那个句子" and keeps a
// pasted paragraph from becoming a four-line row.
const titleRunes = 40

// Conversation is one transcript.
type Conversation struct {
	ID        string `json:"id"`
	Title     string `json:"title"`
	Origin    string `json:"origin"`
	CacheKey  string `json:"cacheKey"`
	CreatedAt string `json:"createdAt"`
	UpdatedAt string `json:"updatedAt"`
}

// Message is one turn inside a transcript.
type Message struct {
	ID             string `json:"id"`
	ConversationID string `json:"conversationId"`
	Role           string `json:"role"`
	Content        string `json:"content"`
	CreatedAt      string `json:"createdAt"`
}

// TitleOf clamps a title to what a list row can show. Empty input (a manual
// chat opened before the first message) still needs a label.
func TitleOf(s string) string {
	s = strings.TrimSpace(strings.Join(strings.Fields(s), " "))
	if s == "" {
		return "新对话"
	}
	r := []rune(s)
	if len(r) > titleRunes {
		// The ellipsis is part of the cap: a row that renders one rune wider
		// than promised is the kind of off-by-one that wraps on a narrow phone.
		return string(r[:titleRunes-1]) + "…"
	}
	return s
}

func uid() string {
	b := make([]byte, 12)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// nowIso is RFC3339Nano in UTC, which sorts lexically — the list page orders
// by string comparison and gets recency for free.
func nowIso() string { return time.Now().UTC().Format(time.RFC3339Nano) }

// Create stores a conversation and its opening transcript in one transaction:
// a crash between the two writes would leave a header with no messages, which
// the list page would render as a conversation that cannot be opened.
func Create(c *Conversation, msgs []Message) error {
	if c.ID == "" {
		c.ID = uid()
	}
	now := nowIso()
	c.CreatedAt = now
	c.UpdatedAt = now
	return db.Tx(func() error {
		d, err := db.Open()
		if err != nil {
			return err
		}
		if _, err := d.Exec(`INSERT INTO ai_conversations (id, title, origin, cache_key, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?)`,
			c.ID, c.Title, c.Origin, c.CacheKey, c.CreatedAt, c.UpdatedAt); err != nil {
			return err
		}
		for i := range msgs {
			if err := insertMessage(d, c.ID, &msgs[i], now); err != nil {
				return err
			}
		}
		return nil
	})
}

func insertMessage(d *sql.DB, convID string, m *Message, now string) error {
	m.ID = uid()
	m.ConversationID = convID
	if m.CreatedAt == "" {
		m.CreatedAt = now
	}
	_, err := d.Exec(`INSERT INTO ai_messages (id, conversation_id, role, content, created_at)
		VALUES (?, ?, ?, ?, ?)`,
		m.ID, m.ConversationID, m.Role, m.Content, m.CreatedAt)
	return err
}

// Append adds one turn and bumps the conversation to the top of the list.
// The timestamp is nudged forward if the clock has not ticked since the last
// write — same-nanosecond appends would otherwise tie and reorder by rowid,
// which is fine internally but makes the list's updated_at look stale.
func Append(convID, role, content string) (*Message, error) {
	d, err := db.Open()
	if err != nil {
		return nil, err
	}
	var prev string
	if err := d.QueryRow(`SELECT updated_at FROM ai_conversations WHERE id = ?`, convID).Scan(&prev); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, errors.New("对话不存在")
		}
		return nil, err
	}
	now := nowIso()
	if now <= prev {
		// One tick past the previous write, whatever the clock granularity did.
		now = bumpNano(prev)
	}
	m := &Message{Role: role, Content: content, CreatedAt: now}
	if _, err := d.Exec(`BEGIN`); err != nil {
		return nil, err
	}
	if err := insertMessage(d, convID, m, now); err != nil {
		_, _ = d.Exec("ROLLBACK")
		return nil, err
	}
	if _, err := d.Exec(`UPDATE ai_conversations SET updated_at = ? WHERE id = ?`, now, convID); err != nil {
		_, _ = d.Exec("ROLLBACK")
		return nil, err
	}
	if _, err := d.Exec("COMMIT"); err != nil {
		return nil, err
	}
	return m, nil
}

// bumpNano returns the RFC3339Nano string one nanosecond after prev. The
// format carries a variable-precision fraction, so the safe move is to parse
// it back and re-format.
func bumpNano(prev string) string {
	t, err := time.Parse(time.RFC3339Nano, prev)
	if err != nil {
		return nowIso()
	}
	return t.Add(time.Nanosecond).UTC().Format(time.RFC3339Nano)
}

// List returns the conversations for the list page, newest activity first.
// A limit of zero means "no cap"; the page asks for a bounded number because
// a year of lookups should not render in one go.
func List(limit int) ([]Conversation, error) {
	d, err := db.Open()
	if err != nil {
		return nil, err
	}
	q := `SELECT id, title, origin, cache_key, created_at, updated_at
	      FROM ai_conversations ORDER BY updated_at DESC`
	args := []any{}
	if limit > 0 {
		q += ` LIMIT ?`
		args = append(args, limit)
	}
	rows, err := d.Query(q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Conversation
	for rows.Next() {
		var c Conversation
		if err := rows.Scan(&c.ID, &c.Title, &c.Origin, &c.CacheKey, &c.CreatedAt, &c.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// Get returns the conversation header, or nil when there is none.
func Get(id string) (*Conversation, error) {
	d, err := db.Open()
	if err != nil {
		return nil, err
	}
	var c Conversation
	err = d.QueryRow(`SELECT id, title, origin, cache_key, created_at, updated_at
	    FROM ai_conversations WHERE id = ?`, id).
		Scan(&c.ID, &c.Title, &c.Origin, &c.CacheKey, &c.CreatedAt, &c.UpdatedAt)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	return &c, nil
}

// ByCacheKey finds the conversation recorded for one cached call, so a
// repeated lookup appends nothing and duplicates nothing.
func ByCacheKey(key string) (*Conversation, error) {
	key = strings.TrimSpace(key)
	if key == "" {
		return nil, nil
	}
	d, err := db.Open()
	if err != nil {
		return nil, err
	}
	var c Conversation
	err = d.QueryRow(`SELECT id, title, origin, cache_key, created_at, updated_at
	    FROM ai_conversations WHERE cache_key = ?`, key).
		Scan(&c.ID, &c.Title, &c.Origin, &c.CacheKey, &c.CreatedAt, &c.UpdatedAt)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	return &c, nil
}

// Messages returns the transcript in the order it happened. rowid is the tie
// breaker: messages appended within the same rendered timestamp must stay in
// write order.
func Messages(convID string) ([]Message, error) {
	d, err := db.Open()
	if err != nil {
		return nil, err
	}
	rows, err := d.Query(`SELECT id, conversation_id, role, content, created_at
	    FROM ai_messages WHERE conversation_id = ? ORDER BY rowid`, convID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Message
	for rows.Next() {
		var m Message
		if err := rows.Scan(&m.ID, &m.ConversationID, &m.Role, &m.Content, &m.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// Delete removes the conversation and, via the foreign key, its messages.
func Delete(id string) error {
	d, err := db.Open()
	if err != nil {
		return err
	}
	_, err = d.Exec(`DELETE FROM ai_conversations WHERE id = ?`, id)
	return err
}

// Count is the list page's subtitle: how many turns a conversation holds.
func Count(convID string) (int, error) {
	d, err := db.Open()
	if err != nil {
		return 0, err
	}
	var n int
	err = d.QueryRow(`SELECT COUNT(*) FROM ai_messages WHERE conversation_id = ?`, convID).Scan(&n)
	return n, err
}

// DeleteMessage removes one turn. Deleting a row that is already gone is a
// no-op: the rollback path in the app layer races a user who deleted the
// whole conversation, and an error there would turn a success into a lie.
func DeleteMessage(id string) error {
	d, err := db.Open()
	if err != nil {
		return err
	}
	_, err = d.Exec(`DELETE FROM ai_messages WHERE id = ?`, id)
	return err
}

// ListItem is one row of the list page: the header plus the two facts the row
// shows — how many turns it holds and what was last said in it. System
// prompts are excluded from the preview: the row quotes the conversation, not
// the boilerplate that shaped it.
type ListItem struct {
	Conversation
	Count   int    `json:"count"`
	Preview string `json:"preview"`
}

// ListDetailed fetches one page in a single query. The subqueries are per-row
// but the table is small and indexed; N+1 round trips through database/sql
// would be slower than one scan with subselects.
//
// Paging is by offset because the order key (updated_at) is unique per row:
// appends nudge the timestamp forward, so no two rows tie, and a page boundary
// cannot skip or repeat an entry. A limit of zero means "to the end", which is
// only for tests and export — the page always asks for a bounded slice.
func ListDetailed(limit, offset int) ([]ListItem, error) {
	d, err := db.Open()
	if err != nil {
		return nil, err
	}
	q := `SELECT c.id, c.title, c.origin, c.cache_key, c.created_at, c.updated_at,
	          (SELECT COUNT(*) FROM ai_messages m WHERE m.conversation_id = c.id),
	          (SELECT m.content FROM ai_messages m
	            WHERE m.conversation_id = c.id AND m.role != 'system'
	            ORDER BY m.rowid DESC LIMIT 1)
	      FROM ai_conversations c ORDER BY c.updated_at DESC`
	args := []any{}
	if limit > 0 {
		q += ` LIMIT ? OFFSET ?`
		args = append(args, limit, offset)
	} else if offset > 0 {
		// SQLite spells "no cap" as a negative limit; OFFSET alone needs one.
		q += ` LIMIT -1 OFFSET ?`
		args = append(args, offset)
	}
	rows, err := d.Query(q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []ListItem
	for rows.Next() {
		var it ListItem
		var preview sql.NullString
		if err := rows.Scan(&it.ID, &it.Title, &it.Origin, &it.CacheKey, &it.CreatedAt,
			&it.UpdatedAt, &it.Count, &preview); err != nil {
			return nil, err
		}
		it.Preview = previewOf(preview.String)
		out = append(out, it)
	}
	return out, rows.Err()
}

// previewOf makes a row's preview readable. A grounded answer is JSON — that
// is what the prompt asked for — and quoting it verbatim puts `{"summary":"…`
// on the list page instead of the answer. The transcript itself still shows
// the raw object (behind a tap); only the one-line preview is humanised.
func previewOf(content string) string {
	s := strings.TrimSpace(content)
	if strings.HasPrefix(s, "{") {
		var m map[string]any
		if err := json.Unmarshal([]byte(s), &m); err == nil {
			// Priority: what the reader would say if asked what the answer
			// was. meaning (查词) → summary (导读) → translation (拆句).
			for _, k := range []string{"meaning", "summary", "translation", "text", "note", "gloss"} {
				if v, ok := m[k].(string); ok && strings.TrimSpace(v) != "" {
					return oneLine(v)
				}
			}
			for _, v := range m {
				if str, ok := v.(string); ok && strings.TrimSpace(str) != "" {
					return oneLine(str)
				}
			}
			return ""
		}
	}
	return oneLine(s)
}

// oneLine collapses the newlines a prompt or a model reply carries: the row
// clamps to two lines anyway, and a raw "\n" in a preview makes the card jump
// in height while the list loads.
func oneLine(s string) string {
	return strings.Join(strings.Fields(s), " ")
}

// Total is how many conversations exist, independent of the page in hand: the
// list page needs it to decide whether there is a next page and to label the
// header without loading everything.
func Total() (int, error) {
	d, err := db.Open()
	if err != nil {
		return 0, err
	}
	var n int
	err = d.QueryRow(`SELECT COUNT(*) FROM ai_conversations`).Scan(&n)
	return n, err
}
