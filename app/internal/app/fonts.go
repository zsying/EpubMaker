package app

import (
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"epubmaker-desktop/internal/config"
)

// Reading fonts: optional, user-downloaded typefaces stored under
// <dataDir>/fonts and served back to the WebView at /fonts/<file> (desktop via
// the asset-server branch in main.go, Android via MainActivity). Keeping them
// out of the binary is the whole point — a CJK font runs 8-20 MB, and the APK
// must stay lean.

// FontInfo describes one downloaded font file.
type FontInfo struct {
	/** File name on disk (also the /fonts/ URL segment). */
	File string `json:"file"`
	Size int64  `json:"size"`
}

// fontFileRe pins downloads to flat, safe file names with a font extension —
// the same name is later used in a URL path and a filesystem join.
var fontFileRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]*\.(ttf|otf|woff2|woff)$`)

// IsFontFileName reports whether name is a safe font file name.
func IsFontFileName(name string) bool {
	return fontFileRe.MatchString(name)
}

// FontsDir is where downloaded fonts live.
func FontsDir() string {
	return filepath.Join(config.Get().Paths.Data, "fonts")
}

// fontMaxBytes caps a download: 80 MB is generous for any single open-source
// face and stops a hostile URL from filling the disk.
const fontMaxBytes = 80 << 20

// ListFonts returns the downloaded fonts, if any. A missing directory just
// means nothing was downloaded yet.
func (b *Backend) ListFonts() ([]FontInfo, error) {
	entries, err := os.ReadDir(FontsDir())
	if err != nil {
		if os.IsNotExist(err) {
			return []FontInfo{}, nil
		}
		return nil, err
	}
	out := []FontInfo{}
	for _, e := range entries {
		if e.IsDir() || !IsFontFileName(e.Name()) {
			continue
		}
		st, err := e.Info()
		if err != nil {
			continue
		}
		out = append(out, FontInfo{File: e.Name(), Size: st.Size()})
	}
	return out, nil
}

// DownloadFont fetches url into <dataDir>/fonts/<file>. The file is staged
// with a .part suffix and renamed only after the full body has been written,
// so a failed download never leaves a truncated font that ListFonts would
// happily offer. Blocking call; the UI shows a progress state around it.
func (b *Backend) DownloadFont(file, url string) (*FontInfo, error) {
	file = strings.TrimSpace(file)
	if !IsFontFileName(file) {
		return nil, fmt.Errorf("非法的字体文件名: %q", file)
	}
	url = strings.TrimSpace(url)
	if !strings.HasPrefix(url, "http://") && !strings.HasPrefix(url, "https://") {
		return nil, fmt.Errorf("仅支持 http(s) 下载地址")
	}

	dir := FontsDir()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}

	resp, err := http.Get(url) //nolint:noctx // a blocking binding call; the UI owns cancellation
	if err != nil {
		return nil, fmt.Errorf("下载失败: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("下载失败: HTTP %d", resp.StatusCode)
	}

	tmp, err := os.CreateTemp(dir, file+".*.part")
	if err != nil {
		return nil, err
	}
	tmpPath := tmp.Name()
	written, err := io.Copy(tmp, io.LimitReader(resp.Body, fontMaxBytes+1))
	closeErr := tmp.Close()
	if err == nil {
		err = closeErr
	}
	if err == nil && written > fontMaxBytes {
		err = fmt.Errorf("文件超过 %d MB 上限", fontMaxBytes>>20)
	}
	if err == nil && written < 1024 {
		err = fmt.Errorf("下载内容太小，不像字体文件")
	}
	if err != nil {
		_ = os.Remove(tmpPath)
		return nil, err
	}

	final := filepath.Join(dir, file)
	if err := os.Rename(tmpPath, final); err != nil {
		_ = os.Remove(tmpPath)
		return nil, err
	}
	return &FontInfo{File: file, Size: written}, nil
}

// DeleteFont removes a downloaded font file. The frontend falls back to the
// default family on its own when the selected file disappears.
func (b *Backend) DeleteFont(file string) (bool, error) {
	if !IsFontFileName(file) {
		return false, fmt.Errorf("非法的字体文件名: %q", file)
	}
	if err := os.Remove(filepath.Join(FontsDir(), file)); err != nil {
		if os.IsNotExist(err) {
			return false, nil
		}
		return false, err
	}
	return true, nil
}
