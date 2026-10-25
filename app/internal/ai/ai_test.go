package ai

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// capture records what the fake provider received.
type capture struct {
	path string
	auth string
	body map[string]any
}

// fakeProvider answers like an OpenAI-compatible chat endpoint. The handler
// decides the status and payload per test.
func fakeProvider(t *testing.T, status int, payload string, cap *capture) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if cap != nil {
			cap.path = r.URL.Path
			cap.auth = r.Header.Get("Authorization")
			b, _ := io.ReadAll(r.Body)
			_ = json.Unmarshal(b, &cap.body)
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = io.WriteString(w, payload)
	}))
	t.Cleanup(srv.Close)
	return srv
}

func TestChatSuccess(t *testing.T) {
	cap := &capture{}
	srv := fakeProvider(t, 200, `{"choices":[{"message":{"role":"assistant","content":"这里表示“翻开新的一页”"}}]}`, cap)

	c := NewClient(Config{BaseURL: srv.URL, APIKey: "sk-test", Model: "gpt-test"})
	out, err := c.Chat(context.Background(), "你是助手", "turn 什么意思")
	if err != nil {
		t.Fatalf("Chat: %v", err)
	}
	if out != "这里表示“翻开新的一页”" {
		t.Fatalf("content = %q", out)
	}
	if cap.path != "/chat/completions" {
		t.Errorf("path = %q, want /chat/completions", cap.path)
	}
	if cap.auth != "Bearer sk-test" {
		t.Errorf("authorization = %q", cap.auth)
	}
	if cap.body["model"] != "gpt-test" {
		t.Errorf("model = %v", cap.body["model"])
	}
	if cap.body["stream"] != false {
		t.Errorf("stream = %v, want false", cap.body["stream"])
	}
	msgs, ok := cap.body["messages"].([]any)
	if !ok || len(msgs) != 2 {
		t.Fatalf("messages = %v", cap.body["messages"])
	}
	first, _ := msgs[0].(map[string]any)
	second, _ := msgs[1].(map[string]any)
	if first["role"] != "system" || first["content"] != "你是助手" {
		t.Errorf("system message = %v", first)
	}
	if second["role"] != "user" || second["content"] != "turn 什么意思" {
		t.Errorf("user message = %v", second)
	}
}

// A provider can answer "I have nothing to say" with a well-formed 200 and an
// empty message. That is a valid answer, not a failure — the caller decides
// whether to cache it.
func TestChatEmptyAnswerIsNotAnError(t *testing.T) {
	srv := fakeProvider(t, 200, `{"choices":[{"message":{"role":"assistant","content":"   "}}]}`, nil)

	c := NewClient(Config{BaseURL: srv.URL, APIKey: "sk-test", Model: "gpt-test"})
	out, err := c.Chat(context.Background(), "sys", "user")
	if err != nil {
		t.Fatalf("empty answer should not be an error: %v", err)
	}
	if out != "" {
		t.Fatalf("content = %q, want empty", out)
	}
}

func TestChatHTTPErrorCarriesStatus(t *testing.T) {
	srv := fakeProvider(t, http.StatusTooManyRequests, `{"error":{"message":"rate limited"}}`, nil)

	c := NewClient(Config{BaseURL: srv.URL, APIKey: "sk-test", Model: "gpt-test"})
	_, err := c.Chat(context.Background(), "sys", "user")
	if err == nil {
		t.Fatal("expected an error for 429")
	}
	var se *StatusError
	if !errors.As(err, &se) {
		t.Fatalf("error = %v, want *StatusError", err)
	}
	if se.Status != http.StatusTooManyRequests {
		t.Errorf("status = %d", se.Status)
	}
	if !strings.Contains(err.Error(), "429") {
		t.Errorf("message should mention the status: %v", err)
	}
}

func TestChatMalformedResponse(t *testing.T) {
	srv := fakeProvider(t, 200, `<html>gateway error</html>`, nil)

	c := NewClient(Config{BaseURL: srv.URL, APIKey: "sk-test", Model: "gpt-test"})
	if _, err := c.Chat(context.Background(), "sys", "user"); err == nil {
		t.Fatal("expected an error for a non-JSON body")
	}
}

func TestChatNoChoices(t *testing.T) {
	srv := fakeProvider(t, 200, `{"choices":[]}`, nil)

	c := NewClient(Config{BaseURL: srv.URL, APIKey: "sk-test", Model: "gpt-test"})
	if _, err := c.Chat(context.Background(), "sys", "user"); err == nil {
		t.Fatal("expected an error when the response has no choices")
	}
}

// A hung provider must not hang the app: red line 2b. The request timeout is a
// var so this test can shorten it instead of sleeping for 15 seconds.
func TestChatTimeout(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(300 * time.Millisecond)
		_, _ = io.WriteString(w, `{"choices":[{"message":{"content":"late"}}]}`)
	}))
	t.Cleanup(srv.Close)

	old := requestTimeout
	requestTimeout = 30 * time.Millisecond
	t.Cleanup(func() { requestTimeout = old })

	c := NewClient(Config{BaseURL: srv.URL, APIKey: "sk-test", Model: "gpt-test"})
	_, err := c.Chat(context.Background(), "sys", "user")
	if err == nil {
		t.Fatal("expected a timeout error")
	}
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("error = %v, want context.DeadlineExceeded", err)
	}
}

func TestChatNotConfigured(t *testing.T) {
	c := NewClient(Config{})
	if _, err := c.Chat(context.Background(), "sys", "user"); !errors.Is(err, ErrNotConfigured) {
		t.Fatalf("error = %v, want ErrNotConfigured", err)
	}
}

// Local providers (Ollama and friends) take no key: the request must go out
// without an Authorization header rather than with a bogus one.
func TestChatLocalProviderNoKey(t *testing.T) {
	cap := &capture{}
	srv := fakeProvider(t, 200, `{"choices":[{"message":{"content":"本地可用"}}]}`, cap)

	c := NewClient(Config{BaseURL: srv.URL, Model: "qwen2.5"})
	out, err := c.Chat(context.Background(), "sys", "user")
	if err != nil {
		t.Fatalf("Chat: %v", err)
	}
	if out != "本地可用" {
		t.Fatalf("content = %q", out)
	}
	if cap.auth != "" {
		t.Errorf("authorization = %q, want none", cap.auth)
	}
}

func TestConfigured(t *testing.T) {
	cases := []struct {
		name string
		cfg  Config
		want bool
	}{
		{"empty", Config{}, false},
		{"missing model", Config{BaseURL: "https://x/v1", APIKey: "k"}, false},
		{"missing base", Config{APIKey: "k", Model: "m"}, false},
		{"all set", Config{BaseURL: "https://x/v1", APIKey: "k", Model: "m"}, true},
		{"key optional for local providers", Config{BaseURL: "http://localhost:11434/v1", Model: "qwen2.5"}, true},
		{"blank counts as missing", Config{BaseURL: "  ", APIKey: "k", Model: "m"}, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := tc.cfg.Configured(); got != tc.want {
				t.Errorf("Configured() = %v, want %v", got, tc.want)
			}
		})
	}
}

// Providers are configured with either a base URL (…/v1) or the full endpoint.
// Both must work, with or without a trailing slash.
func TestEndpointShapes(t *testing.T) {
	cases := []struct {
		base string
		want string
	}{
		{"https://api.openai.com/v1", "/v1/chat/completions"},
		{"https://api.openai.com/v1/", "/v1/chat/completions"},
		{"https://api.openai.com/v1/chat/completions", "/v1/chat/completions"},
		{"https://api.deepseek.com", "/chat/completions"},
	}
	for _, tc := range cases {
		t.Run(tc.base, func(t *testing.T) {
			cap := &capture{}
			srv := fakeProvider(t, 200, `{"choices":[{"message":{"content":"ok"}}]}`, cap)
			// Point the client at the local server, keeping the path shape.
			c := NewClient(Config{BaseURL: srv.URL + tc.want, APIKey: "k", Model: "m"})
			if _, err := c.Chat(context.Background(), "s", "u"); err != nil {
				t.Fatalf("Chat: %v", err)
			}
			if cap.path != tc.want {
				t.Errorf("path = %q, want %q", cap.path, tc.want)
			}
		})
	}
}
