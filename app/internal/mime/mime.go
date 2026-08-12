// Package mime maps file extensions to media types. Port of the small
// guessMediaType helper used for serving assets and covers.
package mime

import "strings"

var byExt = map[string]string{
	".xhtml": "application/xhtml+xml",
	".html":  "text/html",
	".htm":   "text/html",
	".css":   "text/css",
	".js":    "application/javascript",
	".json":  "application/json",
	".xml":   "application/xml",
	".ncx":   "application/x-dtbncx+xml",
	".opf":   "application/oebps-package+xml",
	".gif":   "image/gif",
	".jpg":   "image/jpeg",
	".jpeg":  "image/jpeg",
	".png":   "image/png",
	".svg":   "image/svg+xml",
	".webp":  "image/webp",
	".bmp":   "image/bmp",
	".tiff":  "image/tiff",
	".ttf":   "font/ttf",
	".otf":   "font/otf",
	".woff":  "font/woff",
	".woff2": "font/woff2",
	".mp3":   "audio/mpeg",
	".m4a":   "audio/mp4",
	".mp4":   "video/mp4",
	".pdf":   "application/pdf",
	".txt":   "text/plain",
}

// GuessMediaType returns a media type for a filename, defaulting to
// application/octet-stream.
func GuessMediaType(name string) string {
	lower := strings.ToLower(name)
	for ext, mt := range byExt {
		if strings.HasSuffix(lower, ext) {
			return mt
		}
	}
	return "application/octet-stream"
}
