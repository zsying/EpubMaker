// Package ai is a minimal client for OpenAI-compatible chat endpoints.
//
// The app has no server of its own (ADR-1), so AI features run on whatever
// provider the user brings: base URL + key + model, stored on the device only
// (see the config store in the app package). This package knows nothing about
// prompts or grounding rules — it carries one system+user exchange to the
// provider and returns the assistant's text. Product logic lives in the app
// package; this stays dumb on purpose.
//
// Two failure classes matter to callers:
//
//   - A well-formed 200 with an empty message is a valid answer. The caller
//     decides whether to cache it (usually yes, so the same question is not
//     paid for twice).
//   - Everything else — network down, timeout, non-2xx — is an error, and the
//     caller must not cache it, because "try again later" is the right answer.
package ai

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// chatPath is appended to a base URL that does not already name the endpoint.
const chatPath = "/chat/completions"

// requestTimeout bounds one request (red line 2b: a hung provider must not
// hang the app). It is a var so tests can shorten it.
var requestTimeout = 15 * time.Second

// ErrNotConfigured says the user has not filled in provider settings.
var ErrNotConfigured = errors.New("ai provider not configured")

// Config holds the user's BYOK settings.
type Config struct {
	BaseURL string `json:"baseUrl"`
	APIKey  string `json:"apiKey"`
	Model   string `json:"model"`
}

// Configured reports whether the config can make a call. Blank counts as
// missing: a half-filled form should read as "not configured", not crash.
// The key is optional because local providers (Ollama and friends) need none;
// the Authorization header is simply omitted when it is absent.
func (c Config) Configured() bool {
	return strings.TrimSpace(c.BaseURL) != "" &&
		strings.TrimSpace(c.Model) != ""
}

// StatusError is a non-2xx from the provider. The UI shows the status so the
// user can tell "bad key" (401) from "provider down" (5xx).
type StatusError struct {
	Status int
	Body   string
}

func (e *StatusError) Error() string {
	if body := strings.TrimSpace(e.Body); body != "" {
		if len(body) > 200 {
			body = body[:200] + "…"
		}
		return fmt.Sprintf("provider responded %d: %s", e.Status, body)
	}
	return fmt.Sprintf("provider responded %d", e.Status)
}

// Client sends chat completions to one provider.
type Client struct {
	cfg         Config
	http        *http.Client
	timeout     time.Duration
	temperature float64
	maxTokens   int
}

// DefaultMaxTokens bounds one answer. It is a cap, not a target: providers bill
// the tokens actually produced, so a generous ceiling costs nothing.
//
// 1024 was too tight for the sentence parser, whose answer is a JSON object
// with a segment per clause, and it is definitely too tight for a provider
// whose "flash" model reasons first and answers second — the whole budget can
// go to the reasoning, and the reader sees "AI 没有返回内容" for a request that
// actually succeeded. The number is high enough for the longest grounded answer
// this app asks for and still bounded (red line 2b).
const DefaultMaxTokens = 4096

// NewClient builds a client for cfg with the app's defaults.
func NewClient(cfg Config) *Client {
	return &Client{
		cfg:         cfg,
		http:        &http.Client{},
		timeout:     requestTimeout,
		temperature: 0.2, // low: these prompts pick from given material, not invent
		maxTokens:   DefaultMaxTokens,
	}
}

// Reply is one completed exchange. It carries more than the text on purpose:
// an empty Content is a real outcome that the caller has to explain to the
// reader, and Finish/Reasoning are what tell "the model had nothing to say"
// apart from "the answer was cut off" or "this model put everything in its
// reasoning channel".
type Reply struct {
	Content   string
	Reasoning string
	// Finish is the provider's finish_reason: "stop" (complete), "length"
	// (hit the token cap), "content_filter", … Empty when not reported.
	Finish string
	Model  string
	Usage  Usage
}

// Usage is the provider's own token accounting; zero when it does not report.
type Usage struct {
	PromptTokens     int `json:"prompt_tokens"`
	CompletionTokens int `json:"completion_tokens"`
	TotalTokens      int `json:"total_tokens"`
}

// Chat sends one system+user exchange and returns the assistant's text,
// trimmed. A valid empty answer returns ("", nil).
func (c *Client) Chat(ctx context.Context, system, user string) (string, error) {
	r, err := c.Ask(ctx, system, user)
	if err != nil {
		return "", err
	}
	return r.Content, nil
}

// Ask is Chat with the provider's bookkeeping attached.
func (c *Client) Ask(ctx context.Context, system, user string) (Reply, error) {
	if !c.cfg.Configured() {
		return Reply{}, ErrNotConfigured
	}
	ctx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()

	raw, err := json.Marshal(chatRequest{
		Model: strings.TrimSpace(c.cfg.Model),
		Messages: []chatMessage{
			{Role: "system", Content: content(system)},
			{Role: "user", Content: content(user)},
		},
		Temperature: c.temperature,
		MaxTokens:   c.maxTokens,
		Stream:      false,
	})
	if err != nil {
		return Reply{}, err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.endpoint(), bytes.NewReader(raw))
	if err != nil {
		return Reply{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	if key := strings.TrimSpace(c.cfg.APIKey); key != "" {
		req.Header.Set("Authorization", "Bearer "+key)
	}

	resp, err := c.http.Do(req)
	if err != nil {
		return Reply{}, err // network failure or deadline: caller may retry
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return Reply{}, err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return Reply{}, &StatusError{Status: resp.StatusCode, Body: string(body)}
	}

	var cr chatResponse
	if err := json.Unmarshal(body, &cr); err != nil {
		return Reply{}, fmt.Errorf("ai: unreadable response: %w", err)
	}
	if len(cr.Choices) == 0 || cr.Choices[0].Message == nil {
		return Reply{}, errors.New("ai: response carried no choices")
	}
	msg := cr.Choices[0].Message
	return Reply{
		Content:   strings.TrimSpace(msg.Content.String()),
		Reasoning: strings.TrimSpace(msg.ReasoningContent.String()),
		Finish:    strings.TrimSpace(cr.Choices[0].FinishReason),
		Model:     strings.TrimSpace(cr.Model),
		Usage:     cr.Usage,
	}, nil
}

// endpoint resolves the chat completions URL. Users paste either a base
// (…/v1) or the full endpoint; both are accepted, with or without a
// trailing slash.
func (c *Client) endpoint() string {
	base := strings.TrimRight(strings.TrimSpace(c.cfg.BaseURL), "/")
	if strings.HasSuffix(base, chatPath) {
		return base
	}
	return base + chatPath
}

type chatMessage struct {
	Role             string  `json:"role"`
	Content          content `json:"content"`
	ReasoningContent content `json:"reasoning_content,omitempty"`
}

type chatRequest struct {
	Model       string        `json:"model"`
	Messages    []chatMessage `json:"messages"`
	Temperature float64       `json:"temperature,omitempty"`
	MaxTokens   int           `json:"max_tokens,omitempty"`
	Stream      bool          `json:"stream"`
}

// chatResponse reads only what the app needs. Providers add a dozen more
// fields (ids, fingerprints); ignoring them is deliberate.
type chatResponse struct {
	Model   string `json:"model"`
	Choices []struct {
		Message      *chatMessage `json:"message"`
		FinishReason string       `json:"finish_reason"`
	} `json:"choices"`
	Usage Usage `json:"usage"`
}

// content is a message body as providers actually send it: a plain string, the
// array-of-parts shape newer endpoints use, or null when a reasoning model
// emitted nothing but thinking. Reading only `string` turned the last two into
// an unreadable-response error, which is one of the ways an answer that did
// arrive looked like "AI 没有返回内容".
type content string

func (c *content) UnmarshalJSON(b []byte) error {
	if len(b) == 0 || string(b) == "null" {
		*c = ""
		return nil
	}
	switch b[0] {
	case '"':
		var s string
		if err := json.Unmarshal(b, &s); err != nil {
			return err
		}
		*c = content(s)
	case '[':
		var parts []struct {
			Text string `json:"text"`
		}
		if err := json.Unmarshal(b, &parts); err != nil {
			return err
		}
		var sb strings.Builder
		for _, p := range parts {
			sb.WriteString(p.Text)
		}
		*c = content(sb.String())
	default:
		return fmt.Errorf("ai: unexpected content %q", truncate(string(b), 64))
	}
	return nil
}

func (c content) String() string { return string(c) }

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}
