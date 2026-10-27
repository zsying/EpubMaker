// Package aiprompt stores the reader's saved system prompts: named templates
// the LLM settings page maintains and a hand-made conversation picks from when
// it starts.
//
// The library lives in the library database next to ai_conversations, but it
// is a library and not a source of truth: the prompt a conversation actually
// used is stored as that conversation's first message, so editing or deleting
// a prompt here never rewrites an existing transcript. A deleted prompt only
// stops being offered to conversations that have not started yet.
package aiprompt

import (
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"strings"
	"time"

	"epubmaker-desktop/internal/db"
)

// nameRunes caps what a list row can show; contentRunes caps the prompt at a
// size that is generous for a system prompt and harmless to store.
const (
	nameRunes    = 40
	contentRunes = 8000
)

// Prompt is one saved system prompt.
type Prompt struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Content   string `json:"content"`
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

// List returns every saved prompt, most recently touched first — the order a
// picker wants, since the prompt edited last is the one likely wanted next.
func List() ([]Prompt, error) {
	d, err := db.Open()
	if err != nil {
		return nil, err
	}
	rows, err := d.Query(
		`SELECT id, name, content, created_at, updated_at FROM ai_prompts ORDER BY updated_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Prompt{}
	for rows.Next() {
		var p Prompt
		if err := rows.Scan(&p.ID, &p.Name, &p.Content, &p.CreatedAt, &p.UpdatedAt); err != nil {
			return nil, err
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
	d, err := db.Open()
	if err != nil {
		return nil, err
	}
	var p Prompt
	err = d.QueryRow(
		`SELECT id, name, content, created_at, updated_at FROM ai_prompts WHERE id = ?`, id).
		Scan(&p.ID, &p.Name, &p.Content, &p.CreatedAt, &p.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &p, nil
}

// Save creates (blank id) or updates a prompt. The clamps are silent because
// they only bite on absurd input the form already discourages.
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
		_, err = d.Exec(
			`INSERT INTO ai_prompts (id, name, content, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?)`,
			p.ID, p.Name, p.Content, p.CreatedAt, p.UpdatedAt)
		return err
	}
	p.UpdatedAt = nowIso()
	_, err = d.Exec(
		`UPDATE ai_prompts SET name = ?, content = ?, updated_at = ? WHERE id = ?`,
		p.Name, p.Content, p.UpdatedAt, p.ID)
	return err
}

// Delete removes one prompt. Existing conversations keep the copy of the text
// they stored when they started.
func Delete(id string) error {
	d, err := db.Open()
	if err != nil {
		return err
	}
	_, err = d.Exec(`DELETE FROM ai_prompts WHERE id = ?`, id)
	return err
}
