package app

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"math"
	"net/http"
	"strings"
	"time"

	"github.com/coder/websocket"
)

// 听书音色: the online "high quality" engine.
//
// The phone's own TTS engine (see TtsBridge.java on the Android side) is free,
// offline and unlimited, but it sounds like 2010. Microsoft's neural voices are
// the ones every Chinese reading app uses for 听书, and the read-aloud endpoint
// behind Edge's 大声朗读 serves them without an API key.
//
// Worth being honest about what this is: an undocumented endpoint, not a public
// API. It can start requiring a new token, or refuse the connection outright,
// with no notice — which is why it is the OPTIONAL second engine and never the
// one the reader depends on. The system engine stays the default.
const (
	edgeTTSURL     = "wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1"
	edgeTTSToken   = "6A5AA1D4EAFF4E9FB37E23D68491D6F4"
	edgeTTSOrigin  = "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold"
	edgeTTSVersion = "2-143.0.3650.75"
	edgeTTSAgent   = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
		"(KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0"
)

// EdgeVoice is one selectable online voice, as the settings sheet lists it.
type EdgeVoice struct {
	Name  string `json:"name"`
	Label string `json:"label"`
}

// edgeVoices is a curated list, not the full catalogue: the endpoint exposes
// hundreds of locales, and a picker is useful only if it is short.
var edgeVoices = []EdgeVoice{
	{"zh-CN-XiaoxiaoNeural", "晓晓 · 女声，亲和"},
	{"zh-CN-YunxiNeural", "云希 · 男声，年轻"},
	{"zh-CN-YunjianNeural", "云健 · 男声，浑厚"},
	{"zh-CN-XiaoyiNeural", "晓伊 · 女声，活泼"},
	{"zh-CN-YunyangNeural", "云扬 · 男声，播报"},
	{"zh-CN-liaoning-XiaobeiNeural", "晓北 · 女声，东北话"},
	{"zh-CN-shaanxi-XiaoniNeural", "晓妮 · 女声，陕西话"},
}

// EdgeVoices lists the online voices the settings sheet offers.
func (b *Backend) EdgeVoices() []EdgeVoice { return edgeVoices }

// TtsEdge speaks one sentence with an online neural voice and returns the audio
// as base64 mp3.
//
// Base64 rather than a file path or a URL: the caller plays it through an
// <audio> element, and a data URL keeps the whole thing inside the existing
// binding surface — no second asset server, no cache directory to clean up.
// Sentences are ~60 characters, so the payload is a few tens of KB.
//
// `rate` is a multiplier (1.0 = normal), the same unit the system engine takes.
func (b *Backend) TtsEdge(text, voice string, rate float64) (string, error) {
	text = strings.TrimSpace(text)
	if text == "" {
		return "", fmt.Errorf("没有要朗读的文字")
	}
	if voice == "" {
		voice = edgeVoices[0].Name
	}
	if rate <= 0 || rate > 3 {
		rate = 1
	}

	// 45s: a cold connection plus a long sentence. A sentence that takes longer
	// than this is not worth waiting for — the caller reports it and moves on.
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()

	conn, _, err := websocket.Dial(ctx, edgeURL(), &websocket.DialOptions{
		HTTPHeader: edgeHeaders(),
		// ProxyFromEnvironment so a desktop behind a proxy works; a phone has
		// none set and connects directly.
		HTTPClient: &http.Client{Transport: &http.Transport{Proxy: http.ProxyFromEnvironment}},
	})
	if err != nil {
		return "", fmt.Errorf("连接语音服务失败: %w", err)
	}
	defer conn.CloseNow()
	conn.SetReadLimit(8 << 20)

	reqID := randHex(16)
	if err := writeEdgeText(ctx, conn, "X-Timestamp:"+edgeStamp()+"\r\n"+
		"Content-Type:application/json; charset=utf-8\r\n"+
		"Path:speech.config\r\n\r\n"+
		`{"context":{"synthesis":{"audio":{"metadataoptions":`+
		`{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},`+
		`"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}`); err != nil {
		return "", fmt.Errorf("语音服务握手失败: %w", err)
	}

	ssml := buildSSML(voice, rate, text)
	if err := writeEdgeText(ctx, conn, "X-RequestId:"+reqID+"\r\n"+
		"Content-Type:application/ssml+xml\r\n"+
		"X-Timestamp:"+edgeStamp()+"\r\n"+
		"Path:ssml\r\n\r\n"+ssml); err != nil {
		return "", fmt.Errorf("语音服务请求失败: %w", err)
	}

	var audio []byte
	for {
		typ, data, err := conn.Read(ctx)
		if err != nil {
			if len(audio) > 0 {
				// The stream can be cut after the last audio frame; what was
				// received is still a playable mp3.
				break
			}
			return "", fmt.Errorf("语音服务无响应: %w", err)
		}
		if typ == websocket.MessageBinary {
			if chunk, ok := edgeAudioChunk(data); ok {
				audio = append(audio, chunk...)
			}
			continue
		}
		if bytesHasPath(data, "Path:turn.end") {
			break
		}
	}
	if len(audio) == 0 {
		return "", fmt.Errorf("语音服务未返回音频")
	}
	return base64.StdEncoding.EncodeToString(audio), nil
}

/* -------------------------------- protocol -------------------------------- */

func edgeURL() string {
	return fmt.Sprintf("%s?TrustedClientToken=%s&ConnectionId=%s&Sec-MS-GEC=%s&Sec-MS-GEC-Version=%s",
		edgeTTSURL, edgeTTSToken, randHex(16), edgeTokenV2(time.Now().Unix(), edgeTTSToken), edgeTTSVersion)
}

func edgeHeaders() http.Header {
	h := http.Header{}
	h.Set("Origin", edgeTTSOrigin)
	h.Set("User-Agent", edgeTTSAgent)
	h.Set("Pragma", "no-cache")
	h.Set("Cache-Control", "no-cache")
	h.Set("Accept-Encoding", "gzip, deflate, br")
	h.Set("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8")
	return h
}

func edgeStamp() string {
	return time.Now().UTC().Format("Mon Jan 02 2006 15:04:05 GMT+0000 (Coordinated Universal Time)")
}

func writeEdgeText(ctx context.Context, conn *websocket.Conn, msg string) error {
	return conn.Write(ctx, websocket.MessageText, []byte(msg))
}

// edgeAudioChunk pulls the mp3 bytes out of a binary frame: a 2-byte big-endian
// header length, the ASCII headers, then the audio.
func edgeAudioChunk(data []byte) ([]byte, bool) {
	if len(data) < 2 {
		return nil, false
	}
	hlen := int(binary.BigEndian.Uint16(data[:2]))
	if hlen <= 0 || 2+hlen > len(data) {
		return nil, false
	}
	if !strings.Contains(string(data[2:2+hlen]), "Path:audio") {
		return nil, false
	}
	return data[2+hlen:], true
}

func bytesHasPath(data []byte, path string) bool {
	// Text frames are headers + "\r\n\r\n" + body; the path marker is in the
	// headers, and the body may be large, so only the head is inspected.
	head := data
	if len(head) > 2048 {
		head = head[:2048]
	}
	return strings.Contains(string(head), path)
}

func buildSSML(voice string, rate float64, text string) string {
	pct := int(math.Round((rate - 1) * 100))
	sign := "+"
	if pct < 0 {
		sign = ""
	}
	return fmt.Sprintf(
		"<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='zh-CN'>"+
			"<voice name='%s'><prosody rate='%s%d%%' pitch='+0Hz'>%s</prosody></voice></speak>",
		voice, sign, pct, xmlEscape(text))
}

func xmlEscape(s string) string {
	r := strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;", `"`, "&quot;", "'", "&apos;")
	return r.Replace(s)
}

func randHex(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return fmt.Sprintf("%x", time.Now().UnixNano())
	}
	return hex.EncodeToString(b)
}
