package webdav

import "testing"

func TestResolveURL(t *testing.T) {
	cases := []struct {
		name    string
		baseURL string
		relPath string
		want    string
	}{
		{
			name:    "ascii file stays ascii",
			baseURL: "https://dav.example.com/remote.php/dav/files/u",
			relPath: "book.epub",
			want:    "https://dav.example.com/remote.php/dav/files/u/book.epub",
		},
		{
			name:    "already-encoded chinese file is not double-encoded",
			baseURL: "https://dav.example.com/remote.php/dav/files/u",
			relPath: "%E4%BD%99%E5%8D%8E%E7%9F%AD%E7%AF%87%E5%B0%8F%E8%AF%B4%E9%9B%86.epub",
			want:    "https://dav.example.com/remote.php/dav/files/u/%E4%BD%99%E5%8D%8E%E7%9F%AD%E7%AF%87%E5%B0%8F%E8%AF%B4%E9%9B%86.epub",
		},
		{
			name:    "raw utf-8 chinese file gets encoded once",
			baseURL: "https://dav.example.com/remote.php/dav/files/u",
			relPath: "余华短篇小说集.epub",
			want:    "https://dav.example.com/remote.php/dav/files/u/%E4%BD%99%E5%8D%8E%E7%9F%AD%E7%AF%87%E5%B0%8F%E8%AF%B4%E9%9B%86.epub",
		},
		{
			name:    "leading slash is trimmed",
			baseURL: "https://dav.example.com/dav/",
			relPath: "/sub/dir.epub",
			want:    "https://dav.example.com/dav/sub/dir.epub",
		},
		{
			name:    "encoded subdirectory for listing",
			baseURL: "https://dav.example.com/dav",
			relPath: "%E4%B9%A6%E7%B1%8D",
			want:    "https://dav.example.com/dav/%E4%B9%A6%E7%B1%8D",
		},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := resolveURL(c.baseURL, c.relPath)
			if got != c.want {
				t.Fatalf("resolveURL(%q,%q) = %q, want %q", c.baseURL, c.relPath, got, c.want)
			}
			// A double-encoding regression would show %25 in the output.
			if contains(got, "%25") {
				t.Fatalf("resolveURL produced a double-encoded segment: %q", got)
			}
		})
	}
}

func contains(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}
