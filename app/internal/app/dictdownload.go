package app

import (
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"epubmaker-desktop/internal/config"
	"epubmaker-desktop/internal/dict"
)

// Online dictionary sources. The phone ships without a dictionary and a 66 MB
// CSV is not a one-tap download, so the app offers a curated subset instead:
// the most frequent ECDICT headwords with their translations, hosted as a
// plain CSV well under jsDelivr's 20 MB file limit (the same CDN the font
// downloads use, and the only one that is reachable from a phone in CN
// without a proxy).
//
// Keeping the catalog in code (not config) matches the font downloads: the
// URL is one git tag away, and a future source is a new struct entry.

// DictSource is one downloadable dictionary the Me page can offer.
type DictSource struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Desc string `json:"desc"`
	URL  string `json:"url"`
	// Bytes is the advertised download size, so the UI can show "约 18 MB".
	Bytes int64 `json:"bytes"`
}

var dictCatalog = []DictSource{
	{
		ID:   "ecdict-mini",
		Name: "ECDICT 精简词库",
		Desc: "约 10 万高频词，含音标与释义，适合英文阅读",
		URL:  "https://cdn.jsdelivr.net/gh/zsying/epubmaker-dict@master/ecdict-mini.csv",
		// Advertised size of the catalog csv; the UI shows "约 12 MB".
		Bytes: 12191400,
	},
}

// dictMaxBytes caps a download at 64 MB — every catalog entry must stay far
// below, and the cap stops a compromised catalog URL from filling the disk.
const dictMaxBytes = 64 << 20

// DictSources lists the dictionaries that can be downloaded in-app.
func (b *Backend) DictSources() []DictSource {
	out := make([]DictSource, len(dictCatalog))
	copy(out, dictCatalog)
	return out
}

// DownloadDict fetches the source's CSV and builds the dictionary from it, in
// one blocking call: download → import → reopen the shared handle. The file
// is cached under <dataDir>/dict/<id>.csv (staged as .part), so a re-import
// after a failed attempt does not re-download.
func (b *Backend) DownloadDict(id string) (map[string]any, error) {
	var src *DictSource
	for i := range dictCatalog {
		if dictCatalog[i].ID == strings.TrimSpace(id) {
			src = &dictCatalog[i]
			break
		}
	}
	if src == nil {
		return nil, fmt.Errorf("未知的词库: %q", id)
	}

	dir := filepath.Join(config.Get().Paths.Data, "dict")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	csvPath := filepath.Join(dir, src.ID+".csv")

	if _, err := os.Stat(csvPath); err != nil {
		// No cached copy — download one.
		resp, err := http.Get(src.URL) //nolint:noctx // a blocking binding call; the UI owns cancellation
		if err != nil {
			return nil, fmt.Errorf("下载失败: %w", err)
		}
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			return nil, fmt.Errorf("下载失败: HTTP %d", resp.StatusCode)
		}
		tmp, err := os.CreateTemp(dir, src.ID+".*.part")
		if err != nil {
			return nil, err
		}
		tmpPath := tmp.Name()
		written, err := io.Copy(tmp, io.LimitReader(resp.Body, dictMaxBytes+1))
		closeErr := tmp.Close()
		if err == nil {
			err = closeErr
		}
		if err == nil && written > dictMaxBytes {
			err = fmt.Errorf("文件超过 %d MB 上限", dictMaxBytes>>20)
		}
		if err == nil && written < 1024 {
			err = fmt.Errorf("下载内容太小，不像词库文件")
		}
		if err != nil {
			_ = os.Remove(tmpPath)
			return nil, err
		}
		if err := os.Rename(tmpPath, csvPath); err != nil {
			_ = os.Remove(tmpPath)
			return nil, err
		}
	}

	// Import replaces whatever dictionary is installed.
	closeDict()
	if err := dict.ImportCSV(csvPath, config.Get().Paths.DictDB, nil); err != nil {
		return nil, fmt.Errorf("导入失败: %w", err)
	}
	d, err := openDict()
	if err != nil {
		return nil, err
	}
	n, err := d.Count()
	if err != nil {
		return nil, err
	}
	return map[string]any{"entries": n, "source": src.ID}, nil
}
