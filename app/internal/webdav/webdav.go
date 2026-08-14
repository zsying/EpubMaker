// Package webdav implements a minimal WebDAV client used to browse a remote
// server and import EPUB files directly. Port of server/src/services/webdav.ts.
package webdav

import (
	"bytes"
	"crypto/rand"
	"crypto/tls"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"epubmaker-desktop/internal/config"
	"epubmaker-desktop/internal/epub"
	"epubmaker-desktop/internal/storage"
)

// Connection holds a normalized WebDAV connection.
type Connection struct {
	BaseURL   string
	Username  string
	Password  string
	Insecure  bool
}

// Entry is one file or directory returned by a PROPFIND listing.
type Entry struct {
	Name         string `json:"name"`
	Path         string `json:"path"`
	IsDirectory  bool   `json:"isDirectory"`
	Size         int64  `json:"size"`
	LastModified string `json:"lastModified"`
}

// TestResult is the outcome of a connectivity probe.
type TestResult struct {
	Connected bool   `json:"connected"`
	Server    string `json:"server,omitempty"`
	Error     string `json:"error,omitempty"`
}

// ErrInvalidConn indicates a malformed connection parameter.
type ErrInvalidConn struct{ Msg string }

func (e *ErrInvalidConn) Error() string { return e.Msg }

const propfindBody = `<?xml version="1.0" encoding="utf-8"?>
<D:propfind xmlns:D="DAV:">
  <D:prop>
    <D:resourcetype/>
    <D:getcontentlength/>
    <D:getlastmodified/>
    <D:displayname/>
  </D:prop>
</D:propfind>`

// NormalizeConn validates and normalizes a raw connection object.
func NormalizeConn(input map[string]any) (Connection, error) {
	obj := map[string]any{}
	if input != nil {
		obj = input
	}
	baseURL, _ := obj["baseUrl"].(string)
	baseURL = strings.TrimSpace(baseURL)
	if baseURL == "" {
		return Connection{}, &ErrInvalidConn{Msg: "请填写 WebDAV 服务器地址"}
	}
	u, err := url.Parse(baseURL)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") {
		return Connection{}, &ErrInvalidConn{Msg: "服务器地址格式不正确（需为完整 http(s) URL）"}
	}
	conn := Connection{
		BaseURL:  u.String(),
		Insecure: asBool(obj["insecure"]),
	}
	if user, ok := obj["username"].(string); ok && user != "" {
		conn.Username = user
	}
	if pass, ok := obj["password"].(string); ok {
		conn.Password = pass
	}
	return conn, nil
}

func asBool(v any) bool {
	switch t := v.(type) {
	case bool:
		return t
	case string:
		return t == "true" || t == "1"
	}
	return false
}

func resolveURL(baseURL, relPath string) string {
	rel := relPath
	if strings.HasPrefix(rel, "/") {
		rel = rel[1:]
	}
	base, err := url.Parse(baseURL)
	if err != nil {
		return baseURL
	}
	basePath := base.Path
	if !strings.HasSuffix(basePath, "/") {
		basePath += "/"
	}
	// Join the base path and the (already percent-encoded or raw UTF-8) rel as
	// a string, then re-parse so that any already-encoded segment survives in
	// RawPath while raw multibyte bytes get escaped by String(). Setting
	// u.Path directly would double-encode existing %XX sequences (e.g. a server
	// href "/dav/%E4%BD%99.epub" would become "/dav/%25E4%25BD%2599.epub" and 404).
	joined, err := url.Parse(basePath + rel)
	if err != nil {
		return baseURL
	}
	joined.Scheme = base.Scheme
	joined.Host = base.Host
	joined.User = base.User
	return joined.String()
}

func relativize(href, baseURL string) string {
	abs := href
	if parsed, err := url.Parse(href); err == nil && parsed.IsAbs() {
		abs = parsed.String()
	} else if parsed, err := url.Parse(href); err == nil {
		if joined, err := url.Parse(baseURL); err == nil {
			abs = joined.ResolveReference(parsed).String()
		}
	}
	base, err := url.Parse(baseURL)
	if err != nil {
		return href
	}
	basePath := base.Path
	if !strings.HasSuffix(basePath, "/") {
		basePath += "/"
	}
	rel := abs
	if base.Host != "" && strings.HasPrefix(abs, "http://"+base.Host) {
		rel = strings.TrimPrefix(abs, "http://"+base.Host)
	} else if base.Host != "" && strings.HasPrefix(abs, "https://"+base.Host) {
		rel = strings.TrimPrefix(abs, "https://"+base.Host)
	}
	if strings.HasPrefix(rel, basePath) {
		rel = strings.TrimPrefix(rel, basePath)
	}
	rel = strings.TrimPrefix(rel, "/")
	return rel
}

func basenameOf(rel string) string {
	trimmed := rel
	if strings.HasSuffix(trimmed, "/") {
		trimmed = trimmed[:len(trimmed)-1]
	}
	i := strings.LastIndex(trimmed, "/")
	name := trimmed
	if i >= 0 {
		name = trimmed[i+1:]
	}
	if name == "" {
		return trimmed
	}
	if decoded, err := url.PathUnescape(name); err == nil {
		return decoded
	}
	return name
}

func authHeader(conn Connection) map[string]string {
	if conn.Username != "" {
		token := basicAuth(conn.Username, conn.Password)
		return map[string]string{"Authorization": "Basic " + token}
	}
	return map[string]string{}
}

func basicAuth(user, pass string) string {
	raw := user + ":" + pass
	return base64Encode([]byte(raw))
}

func base64Encode(b []byte) string {
	const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
	var out strings.Builder
	for i := 0; i < len(b); i += 3 {
		var n uint32
		for j := 0; j < 3; j++ {
			n <<= 8
			if i+j < len(b) {
				n |= uint32(b[i+j])
			}
		}
		out.WriteByte(chars[(n>>18)&0x3f])
		out.WriteByte(chars[(n>>12)&0x3f])
		if i+1 < len(b) {
			out.WriteByte(chars[(n>>6)&0x3f])
		} else {
			out.WriteByte('=')
		}
		if i+2 < len(b) {
			out.WriteByte(chars[n&0x3f])
		} else {
			out.WriteByte('=')
		}
	}
	return out.String()
}

func httpClient(conn Connection) *http.Client {
	if conn.Insecure {
		return &http.Client{
			Transport: &http.Transport{
				TLSClientConfig: &tls.Config{InsecureSkipVerify: true},
			},
		}
	}
	return http.DefaultClient
}

func doRequest(conn Connection, method, target string, body io.Reader, headers map[string]string) (*http.Response, error) {
	req, err := http.NewRequest(method, target, body)
	if err != nil {
		return nil, err
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	for k, v := range authHeader(conn) {
		req.Header.Set(k, v)
	}
	return httpClient(conn).Do(req)
}

func parsePropfind(xmlStr, baseURL, requestedPath string) []Entry {
	root, err := epub.ParseXMLString(xmlStr)
	if err != nil {
		return nil
	}
	var responses []*epub.XMLNode
	if root != nil {
		for _, r := range root.FindAll("response") {
			responses = append(responses, r)
		}
	}
	out := []Entry{}
	for _, r := range responses {
		var href string
		if h := r.Find("href"); h != nil {
			href = strings.TrimSpace(h.Text)
		}
		if href == "" {
			continue
		}
		rel := relativize(href, baseURL)
		if rel == requestedPath {
			continue
		}
		prop := pickProp(r)
		isDir := false
		if prop != nil {
			if rt := prop.Find("resourcetype"); rt != nil {
				for _, c := range rt.Children {
					if c.Local == "collection" {
						isDir = true
						break
					}
				}
			}
		}
		p := rel
		if isDir && !strings.HasSuffix(p, "/") {
			p += "/"
		}
		var size int64
		if prop != nil && prop.Find("getcontentlength") != nil {
			fmt.Sscanf(strings.TrimSpace(prop.Find("getcontentlength").Text), "%d", &size)
		}
		var lastModified string
		if prop != nil && prop.Find("getlastmodified") != nil {
			raw := strings.TrimSpace(prop.Find("getlastmodified").Text)
			if t, e := time.Parse(time.RFC1123, raw); e == nil {
				lastModified = t.UTC().Format(time.RFC3339)
			} else {
				lastModified = raw
			}
		}
		name := ""
		if prop != nil && prop.Find("displayname") != nil {
			name = strings.TrimSpace(prop.Find("displayname").Text)
		}
		if name == "" {
			name = basenameOf(p)
		}
		out = append(out, Entry{Name: name, Path: p, IsDirectory: isDir, Size: size, LastModified: lastModified})
	}
	sortEntries(out)
	return out
}

func pickProp(response *epub.XMLNode) *epub.XMLNode {
	if response == nil {
		return nil
	}
	var propstats []*epub.XMLNode
	for _, c := range response.Children {
		if c.Local == "propstat" {
			propstats = append(propstats, c)
		}
	}
	var chosen *epub.XMLNode
	for _, ps := range propstats {
		status := ""
		for _, c := range ps.Children {
			if c.Local == "status" {
				status = strings.TrimSpace(c.Text)
			}
		}
		if regexp.MustCompile(`200`).MatchString(status) {
			chosen = ps
			break
		}
	}
	if chosen == nil && len(propstats) > 0 {
		chosen = propstats[0]
	}
	if chosen == nil {
		return nil
	}
	for _, c := range chosen.Children {
		if c.Local == "prop" {
			return c
		}
	}
	return nil
}

func sortEntries(entries []Entry) {
	// directory first, then by name (locale-insensitive stable order).
	for i := 0; i < len(entries); i++ {
		for j := i + 1; j < len(entries); j++ {
			if entries[i].IsDirectory != entries[j].IsDirectory {
				if !entries[i].IsDirectory {
					entries[i], entries[j] = entries[j], entries[i]
				}
			} else if entries[i].Name > entries[j].Name {
				entries[i], entries[j] = entries[j], entries[i]
			}
		}
	}
}

// TestWebDav probes connectivity with a Depth:0 PROPFIND.
func TestWebDav(conn Connection) (TestResult, error) {
	target := resolveURL(conn.BaseURL, "")
	res, err := doRequest(conn, "PROPFIND", target, bytes.NewReader([]byte(propfindBody)), map[string]string{
		"Depth":        "0",
		"Content-Type": "application/xml; charset=utf-8",
	})
	if err != nil {
		return TestResult{}, &ErrInvalidConn{Msg: fmt.Sprintf("无法连接服务器：%s", err.Error())}
	}
	defer res.Body.Close()
	if res.StatusCode == 401 {
		return TestResult{}, &ErrInvalidConn{Msg: "认证失败：用户名或密码错误"}
	}
	if res.StatusCode == 403 {
		return TestResult{}, &ErrInvalidConn{Msg: "服务器拒绝访问（403 Forbidden）"}
	}
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return TestResult{}, &ErrInvalidConn{Msg: fmt.Sprintf("服务器返回错误 (%d %s)", res.StatusCode, res.Status)}
	}
	server := res.Header.Get("server")
	if res.StatusCode != 207 && res.Header.Get("dav") == "" {
		// Acceptable, but log a soft warning upstream if needed.
		_ = server
	}
	return TestResult{Connected: true, Server: server}, nil
}

// ListWebDav lists the entries of a remote directory (Depth:1).
func ListWebDav(conn Connection, dirPath string) ([]Entry, error) {
	target := resolveURL(conn.BaseURL, dirPath)
	res, err := doRequest(conn, "PROPFIND", target, bytes.NewReader([]byte(propfindBody)), map[string]string{
		"Depth":        "1",
		"Content-Type": "application/xml; charset=utf-8",
	})
	if err != nil {
		return nil, &ErrInvalidConn{Msg: fmt.Sprintf("无法列出目录：%s", err.Error())}
	}
	defer res.Body.Close()
	if res.StatusCode == 401 {
		return nil, &ErrInvalidConn{Msg: "认证失败：用户名或密码错误"}
	}
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return nil, &ErrInvalidConn{Msg: fmt.Sprintf("列出目录失败 (%d %s)", res.StatusCode, res.Status)}
	}
	body, err := io.ReadAll(res.Body)
	if err != nil {
		return nil, err
	}
	return parsePropfind(string(body), conn.BaseURL, dirPath), nil
}

// DownloadWebDavFile streams a remote file to destPath on disk.
func DownloadWebDavFile(conn Connection, filePath, destPath string) error {
	target := resolveURL(conn.BaseURL, filePath)
	res, err := doRequest(conn, "GET", target, nil, nil)
	if err != nil {
		return &ErrInvalidConn{Msg: fmt.Sprintf("下载失败：%s", err.Error())}
	}
	defer res.Body.Close()
	if res.StatusCode == 401 {
		return &ErrInvalidConn{Msg: "认证失败：用户名或密码错误"}
	}
	if res.StatusCode < 200 || res.StatusCode >= 300 || res.Body == nil {
		return &ErrInvalidConn{Msg: fmt.Sprintf("下载失败 (%d %s)", res.StatusCode, res.Status)}
	}
	if err := os.MkdirAll(filepath.Dir(destPath), 0o755); err != nil {
		return err
	}
	out, err := os.Create(destPath)
	if err != nil {
		return err
	}
	defer out.Close()
	if _, err := io.Copy(out, res.Body); err != nil {
		return err
	}
	return nil
}

// TempPath returns a temp file path for a downloaded WebDAV file.
func TempPath(name string) string {
	base := storage.SanitizeFileName(name)
	if base == "" {
		base = "book.epub"
	}
	return filepath.Join(config.Get().Paths.Tmp,
		fmt.Sprintf("%d-%s-%s", time.Now().UnixNano(), randStr(6), base))
}

var tmpRand = regexp.MustCompile(`[^a-z0-9]`)

func randStr(n int) string {
	b := make([]byte, n)
	if _, err := io.ReadFull(rand.Reader, b); err != nil {
		return "tmp"
	}
	const chars = "abcdefghijklmnopqrstuvwxyz0123456789"
	for i := range b {
		b[i] = chars[int(b[i])%len(chars)]
	}
	return string(b)
}
