//go:build android

package main

import (
	"os"
	"path/filepath"
	"strings"
)

// platformInit pins the data root before anything reads config: Android gives
// a process no usable HOME, so config.appHome() would otherwise derive a path
// from an empty string.
func platformInit() {
	if os.Getenv("EPUBMAKER_HOME") != "" {
		return
	}
	home := androidAppHome()
	if home == "" {
		return
	}
	if err := os.MkdirAll(home, 0o755); err == nil {
		os.Setenv("EPUBMAKER_HOME", home)
	}
}

// trace appends a startup breadcrumb to a file inside the app's private
// directory. Android does not route a Go process's stderr into logcat in
// c-shared mode, so when the process dies before the Java layer can report
// anything this file is the only evidence of how far startup got. Read it with
//   adb shell run-as com.wails.app cat files/trace.log
// (or `adb root` + cat on an emulator). Desktop builds compile this to a no-op.
func trace(msg string) {
	dir := androidFilesDir()
	if dir == "" {
		return
	}
	f, err := os.OpenFile(dir+"/trace.log", os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return
	}
	defer f.Close()
	f.WriteString(msg + "\n")
}

// androidFilesDir returns the app's private files directory as a plain path
// (no filesystem calls, so it works even when stat is unavailable).
func androidFilesDir() string {
	raw, err := os.ReadFile("/proc/self/cmdline")
	if err != nil {
		return ""
	}
	// The first NUL-separated field is the package name; later fields are
	// process arguments that may contain slashes, so stop at the first NUL.
	pkg := string(raw)
	if i := strings.IndexByte(pkg, 0); i >= 0 {
		pkg = pkg[:i]
	}
	if pkg == "" || strings.ContainsAny(pkg, "/\x00") {
		return ""
	}
	return "/data/data/" + pkg + "/files"
}

// androidAppHome is the data root: <app files dir>/.epubmaker, or "" when the
// package name cannot be determined.
func androidAppHome() string {
	dir := androidFilesDir()
	if dir == "" {
		return ""
	}
	return filepath.Join(dir, ".epubmaker")
}
