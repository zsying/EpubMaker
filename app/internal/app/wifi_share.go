package app

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"epubmaker-desktop/internal/config"
	"epubmaker-desktop/internal/library"
)

// Wi-Fi 传书: the phone runs a tiny HTTP server on the LAN, and any browser on
// the same Wi-Fi (typically a computer) opens the printed URL / scans the QR
// code and drops EPUB files onto the upload page. Kindle push, minus the
// cloud: the books land directly in the local library, no account needed.
//
// Scope is deliberately narrow — one page, one upload endpoint — and it is
// meant to be switched on for the duration of a transfer, not run forever.

const (
	wifiSharePortBase   = 8787
	wifiSharePortRange  = 10
	wifiShareMaxRequest = 1 << 29 // 512 MB, generous room for several large epubs
)

type wifiShareState struct {
	mu      sync.Mutex
	srv     *http.Server
	port    int
	url     string
	imports int
	dups    int
	fails   []string
	lastAt  time.Time
	// Imports are serialized: the library engine touches sqlite and the books
	// directory, and two simultaneous multipart imports would race.
	importMu sync.Mutex
}

var wifiShare wifiShareState

// WifiShareStart opens the LAN upload server and returns the address to show.
func (b *Backend) WifiShareStart() (map[string]any, error) {
	wifiShare.mu.Lock()
	defer wifiShare.mu.Unlock()
	if wifiShare.srv != nil {
		return wifiShare.snapshotLocked(), nil
	}

	ip, err := lanIPv4()
	if err != nil {
		return nil, errors.New("没有找到局域网 IP，请先连接 Wi-Fi（" + err.Error() + "）")
	}
	ips := []string{ip}

	mux := http.NewServeMux()
	mux.HandleFunc("/", wifiShareIndex)
	mux.HandleFunc("/upload", wifiShareUpload)

	var lastErr error
	for offset := 0; offset < wifiSharePortRange; offset++ {
		port := wifiSharePortBase + offset
		// tcp4, deliberately: Android defaults net.ipv6.bindv6only=1, so a
		// wildcard tcp listen lands on [::] only and never accepts the IPv4
		// connections a LAN browser makes.
		ln, err := net.Listen("tcp4", fmt.Sprintf(":%d", port))
		if err != nil {
			lastErr = err
			continue
		}
		srv := &http.Server{Handler: mux, ReadHeaderTimeout: 15 * time.Second}
		wifiShare.srv = srv
		wifiShare.port = port
		wifiShare.url = fmt.Sprintf("http://%s:%d", ips[0], port)
		go func() {
			_ = srv.Serve(ln)
		}()
		out := wifiShare.snapshotLocked()
		out["ips"] = ips
		return out, nil
	}
	return nil, fmt.Errorf("端口 %d-%d 均被占用: %w", wifiSharePortBase, wifiSharePortBase+wifiSharePortRange-1, lastErr)
}

// WifiShareStop shuts the server down. Stopping an idle server is not an error.
func (b *Backend) WifiShareStop() (map[string]any, error) {
	wifiShare.mu.Lock()
	srv := wifiShare.srv
	wifiShare.srv = nil
	wifiShare.port = 0
	wifiShare.url = ""
	wifiShare.mu.Unlock()
	if srv != nil {
		_ = srv.Close()
	}
	return map[string]any{"running": false}, nil
}

// WifiShareStatus reports whether the server is up plus transfer counters, so
// the phone UI can show progress while the browser uploads.
func (b *Backend) WifiShareStatus() (map[string]any, error) {
	wifiShare.mu.Lock()
	defer wifiShare.mu.Unlock()
	return wifiShare.snapshotLocked(), nil
}

func (s *wifiShareState) snapshotLocked() map[string]any {
	out := map[string]any{
		"running":    s.srv != nil,
		"port":       s.port,
		"url":        s.url,
		"imports":    s.imports,
		"duplicates": s.dups,
		"failures":   append([]string(nil), s.fails...),
	}
	if !s.lastAt.IsZero() {
		// Raw seconds again: the phone formats it, Go's time.Local cannot be
		// trusted inside the Android c-shared runtime.
		out["lastImportUnix"] = s.lastAt.Unix()
	}
	return out
}

// lanIPv4 finds the outbound IPv4 address the LAN transfer should advertise.
//
// net.Interfaces() is unusable here: Android 11+ SELinux denies untrusted apps
// the netlink route query it needs ("netlinkrib: permission denied"), so the
// interface walk dies before it lists anything. The classic workaround dials a
// UDP socket (no packets are sent — connect() just consults the routing
// table) and reads back the local address of the default route, which on a
// phone is exactly the Wi-Fi interface a computer would reach.
func lanIPv4() (string, error) {
	conn, err := net.Dial("udp", "8.8.8.8:53")
	if err != nil {
		return "", fmt.Errorf("网络未连接: %w", err)
	}
	defer conn.Close()
	ip, ok := conn.LocalAddr().(*net.UDPAddr)
	if !ok || ip.IP == nil {
		return "", errors.New("无法确定本机局域网地址")
	}
	ip4 := ip.IP.To4()
	if ip4 == nil || ip4.IsLoopback() {
		return "", errors.New("本机地址不是局域网 IPv4，请确认已连接 Wi-Fi")
	}
	return ip4.String(), nil
}

func wifiShareIndex(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/" {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	_, _ = w.Write([]byte(wifiShareUploadPage))
}

func wifiShareUpload(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST only", http.StatusMethodNotAllowed)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, wifiShareMaxRequest)
	if err := r.ParseMultipartForm(32 << 20); err != nil {
		http.Error(w, "请求体过大或格式错误", http.StatusRequestEntityTooLarge)
		return
	}

	wifiShare.importMu.Lock()
	defer wifiShare.importMu.Unlock()

	out := map[string]any{"imported": 0, "duplicates": 0, "skipped": []string{}, "errors": []string{}}
	for _, fh := range r.MultipartForm.File["files"] {
		name := filepath.Base(fh.Filename)
		if !strings.EqualFold(filepath.Ext(name), ".epub") {
			out["skipped"] = append(out["skipped"].([]string), name+"（不是 .epub 文件）")
			continue
		}
		// os.CreateTemp("") lands in /data/local/tmp on Android, which the app
		// cannot write to — stage uploads inside the app's own data dir.
		tmpDir := filepath.Join(config.Get().AppHome, "tmp")
		if err := os.MkdirAll(tmpDir, 0o755); err != nil {
			out["errors"] = append(out["errors"].([]string), name+": "+err.Error())
			continue
		}
		tmp, err := os.CreateTemp(tmpDir, "upload-*.epub")
		if err != nil {
			out["errors"] = append(out["errors"].([]string), name+": "+err.Error())
			continue
		}
		tmpPath := tmp.Name()
		err = copyMultipart(tmp, fh)
		tmp.Close()
		if err != nil {
			os.Remove(tmpPath)
			out["errors"] = append(out["errors"].([]string), name+": "+err.Error())
			continue
		}
		book, err := library.ImportEpub(tmpPath, name)
		os.Remove(tmpPath)
		if errors.Is(err, library.ErrDuplicate) {
			wifiShare.mu.Lock()
			wifiShare.dups++
			wifiShare.mu.Unlock()
			out["duplicates"] = out["duplicates"].(int) + 1
			out["skipped"] = append(out["skipped"].([]string),
				name+"（已有《"+strings.TrimPrefix(err.Error(), "duplicate:")+"》）")
			continue
		}
		if err != nil {
			wifiShare.mu.Lock()
			wifiShare.fails = append(wifiShare.fails, name)
			wifiShare.mu.Unlock()
			out["errors"] = append(out["errors"].([]string), name+": "+err.Error())
			continue
		}
		wifiShare.mu.Lock()
		wifiShare.imports++
		wifiShare.lastAt = time.Now()
		wifiShare.mu.Unlock()
		out["imported"] = out["imported"].(int) + 1
		out["lastTitle"] = book.Title
	}
	writeJSON(w, out)
}

func copyMultipart(dst *os.File, fh *multipart.FileHeader) error {
	src, err := fh.Open()
	if err != nil {
		return err
	}
	defer src.Close()
	_, err = io.Copy(dst, src)
	return err
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(w).Encode(v)
}

// wifiShareUploadPage is the browser-side upload UI served to the computer.
// Plain HTML+JS, no build step: it must work from any device that can reach
// the phone, including old browsers.
const wifiShareUploadPage = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>EpubMaker · Wi-Fi 传书</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; font: 15px/1.6 system-ui, sans-serif; background: #f6f6f4; color: #333; }
  main { max-width: 560px; margin: 0 auto; padding: 24px 16px 48px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .sub { color: #888; font-size: 13px; margin-bottom: 20px; }
  #drop { border: 2px dashed #bbb; border-radius: 12px; padding: 36px 16px; text-align: center;
          background: #fff; cursor: pointer; transition: background .15s, border-color .15s; }
  #drop.over { background: #eef6ee; border-color: #4a9; }
  #drop p { margin: 6px 0 0; color: #999; font-size: 13px; }
  ul { list-style: none; margin: 16px 0 0; padding: 0; }
  li { background: #fff; border: 1px solid #e5e5e2; border-radius: 8px; padding: 10px 12px;
       margin-bottom: 8px; font-size: 13.5px; }
  li .bar { height: 4px; background: #eee; border-radius: 2px; margin-top: 8px; overflow: hidden; }
  li .bar i { display: block; height: 100%; width: 0; background: #4a9; transition: width .2s; }
  li.ok { border-color: #4a9; } li.dup { border-color: #db8; } li.err { border-color: #d66; }
  li small { color: #888; display: block; margin-top: 2px; }
</style>
</head>
<body>
<main>
  <h1>Wi-Fi 传书</h1>
  <p class="sub">选择或拖入 .epub 文件，它们会直接导入手机上的 EpubMaker 书架。传输只在局域网内进行。</p>
  <div id="drop">
    <strong>点按选择文件，或把 EPUB 拖到这里</strong>
    <p>可一次选择多个文件</p>
    <input id="file" type="file" multiple accept=".epub,application/epub+zip" style="display:none">
  </div>
  <ul id="list"></ul>
</main>
<script>
const drop = document.getElementById('drop');
const fileInput = document.getElementById('file');
const list = document.getElementById('list');
drop.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => send([...fileInput.files]));
['dragover', 'dragenter'].forEach((ev) => drop.addEventListener(ev, (e) => {
  e.preventDefault(); drop.classList.add('over');
}));
['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => {
  e.preventDefault(); drop.classList.remove('over');
}));
drop.addEventListener('drop', (e) => send([...e.dataTransfer.files]));

function row(name) {
  const li = document.createElement('li');
  li.innerHTML = '<span></span><div class="bar"><i></i></div><small>等待上传…</small>';
  li.firstChild.textContent = name;
  list.appendChild(li);
  return li;
}

function send(files) {
  for (const f of files) {
    if (!/\.epub$/i.test(f.name)) { note(f.name, '跳过：不是 .epub 文件', 'err'); continue; }
    upload(f);
  }
}

function upload(f) {
  const li = row(f.name);
  const small = li.querySelector('small');
  const bar = li.querySelector('.bar i');
  const fd = new FormData();
  fd.append('files', f, f.name);
  const xhr = new XMLHttpRequest();
  xhr.open('POST', '/upload');
  xhr.upload.addEventListener('progress', (e) => {
    if (e.lengthComputable) bar.style.width = Math.round((e.loaded / e.total) * 100) + '%';
  });
  xhr.addEventListener('load', () => {
    li.querySelector('.bar').remove();
    if (xhr.status !== 200) { li.classList.add('err'); small.textContent = '上传失败（HTTP ' + xhr.status + '）'; return; }
    let res = {};
    try { res = JSON.parse(xhr.responseText); } catch (ignored) {}
    const errs = (res.errors || []).filter((s) => s.startsWith(f.name));
    if (errs.length) { li.classList.add('err'); small.textContent = errs[0]; return; }
    const dups = (res.skipped || []).filter((s) => s.startsWith(f.name));
    if (dups.length) { li.classList.add('dup'); small.textContent = dups[0]; return; }
    li.classList.add('ok'); small.textContent = '已导入书架' + (res.lastTitle ? '：《' + res.lastTitle + '》' : '');
  });
  xhr.addEventListener('error', () => { li.classList.add('err'); small.textContent = '网络错误'; });
  xhr.send(fd);
}

function note(name, msg, cls) {
  const li = document.createElement('li');
  li.className = cls;
  li.textContent = name + ' — ' + msg;
  list.appendChild(li);
}
</script>
</body>
</html>`
