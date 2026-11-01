package app

import (
	"encoding/base64"
	"os"
	"strings"
	"testing"
)

// TestTtsEdge talks to the real endpoint, so it is opt-in: the ordinary test
// run must not depend on Microsoft's servers being reachable, or on an
// undocumented protocol still working this month.
//
//	EPUBMAKER_TTS=1 go test ./internal/app -run TestTtsEdge -v
func TestTtsEdge(t *testing.T) {
	if os.Getenv("EPUBMAKER_TTS") == "" {
		t.Skip("set EPUBMAKER_TTS=1 to exercise the online voice")
	}
	b := &Backend{}
	for _, tc := range []struct {
		text string
		rate float64
	}{
		{"他抬起头，看见窗外的梧桐叶落了一地。", 1.0},
		{"第一章 山雨欲来", 1.25},
	} {
		b64, err := b.TtsEdge(tc.text, "zh-CN-XiaoxiaoNeural", tc.rate)
		if err != nil {
			t.Fatalf("TtsEdge(%q): %v", tc.text, err)
		}
		raw, err := base64.StdEncoding.DecodeString(b64)
		if err != nil {
			t.Fatalf("base64: %v", err)
		}
		// An mp3 frame starts with 0xFF (11 sync bits set).
		if len(raw) < 512 || raw[0] != 0xFF {
			t.Fatalf("not mp3: %d bytes, first % x", len(raw), raw[:2])
		}
		t.Logf("%q → %d bytes", tc.text, len(raw))
	}
}

func TestBuildSSML(t *testing.T) {
	got := buildSSML("zh-CN-XiaoxiaoNeural", 1.25, "a<b&c")
	want := "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='zh-CN'>" +
		"<voice name='zh-CN-XiaoxiaoNeural'><prosody rate='+25%' pitch='+0Hz'>a&lt;b&amp;c</prosody></voice></speak>"
	if got != want {
		t.Fatalf("ssml:\n got %s\nwant %s", got, want)
	}
	// Slower than normal must not grow a sign the endpoint rejects.
	slow := buildSSML("v", 0.8, "x")
	if !strings.Contains(slow, "rate='-20%'") {
		t.Fatalf("slow rate: %s", slow)
	}
}

// TestEdgeTokenV2 pins the token against values produced by edge-tts 7.3.1
// itself. This is the only way to know the port is faithful: the server answers
// a wrong token with a bare 403, so a broken port looks exactly like a blocked
// network.
func TestEdgeTokenV2(t *testing.T) {
	cases := []struct {
		unix int64
		want string
	}{
		{0, "52BC7A17B50DFEC9-28C4394775C8751CD2F6859C030C06DB1489ACAB3B3A7651831FC26895177ED6"},
		{1735689600, "54404AFE67C9B44A-E72E51D8B4F5F75E9A96B7E20D7877227455BC310433BD30C817CD54A1D9313E"},
		{1761811200, "CDBC8DA8D19264A6-B0EE9C4A551818E636FF177AD6DA9C097422EA96E81BACBF9D24B9631D0AA8EB"},
	}
	for _, c := range cases {
		if got := edgeTokenV2(c.unix, edgeTTSToken); got != c.want {
			t.Errorf("edgeTokenV2(%d):\n got %s\nwant %s", c.unix, got, c.want)
		}
	}
}
