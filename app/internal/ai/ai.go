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

// NewClient builds a client for cfg with the app's defaults.
func NewClient(cfg Config) *Client {
	return &Client{
		cfg:         cfg,
		http:        &http.Client{},
		timeout:     requestTimeout,
		temperature: 0.2, // low: these prompts pick from given material, not invent
		maxTokens:   1024,
	}
}

// Chat sends one system+user exchange and returns the assistant's text,
// trimmed. A valid empty answer returns ("", nil).
func (c *Client) Chat(ctx context.Context, system, user string) (string, error) {
	if !c.cfg.Configured() {
		return "", ErrNotConfigured
	}
	ctx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()

	raw, err := json.Marshal(chatRequest{
		Model: strings.TrimSpace(c.cfg.Model),
		Messages: []chatMessage{
			{Role: "system", Content: system},
			{Role: "user", Content: user},
		},
		Temperature: c.temperature,
		MaxTokens:   c.maxTokens,
		Stream:      false,
	})
	if err != nil {
		return "", err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.endpoint(), bytes.NewReader(raw))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	if key := strings.TrimSpace(c.cfg.APIKey); key != "" {
		req.Header.Set("Authorization", "Bearer "+key)
	}

	resp, err := c.http.Do(req)
	if err != nil {
		return "", err // network failure or deadline: caller may retry
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return "", err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", &StatusError{Status: resp.StatusCode, Body: string(body)}
	}

	var cr chatResponse
	if err := json.Unmarshal(body, &cr); err != nil {
		return "", fmt.Errorf("ai: unreadable response: %w", err)
	}
	if len(cr.Choices) == 0 || cr.Choices[0].Message == nil {
		return "", errors.New("ai: response carried no choices")
	}
	return strings.TrimSpace(cr.Choices[0].Message.Content), nil
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
	Role    string `json:"role"`
	Content string `json:"content"`
}

type chatRequest struct {
	Model       string        `json:"model"`
	Messages    []chatMessage `json:"messages"`
	Temperature float64       `json:"temperature,omitempty"`
	MaxTokens   int           `json:"max_tokens,omitempty"`
	Stream      bool          `json:"stream"`
}

// chatResponse reads only what the app needs. Providers add a dozen more
// fields (usage, finish_reason, ids); ignoring them is deliberate.
type chatResponse struct {
	Choices []struct {
		Message *chatMessage `json:"message"`
	} `json:"choices"`
}
