//go:build !android

package main

// platformInit has nothing to do on a desktop: HOME exists, and
// ~/.epubmaker is where it always was. It stays in the shared entry point so
// both builds read the same startup sequence.
func platformInit() {}

// trace is the Android startup breadcrumb (see platform_android.go). Desktops
// have a real stderr, and `log` already goes there.
func trace(string) {}
