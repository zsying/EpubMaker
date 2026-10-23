// Command dictimport installs the local dictionary from an ECDICT csv without
// going through the UI. It uses the same code path as the app's "导入词库"
// button, so the resulting database is identical. Handy for scripted setup and
// for re-importing a newer export.
package main

import (
	"fmt"
	"os"

	"epubmaker-desktop/internal/config"
	"epubmaker-desktop/internal/dict"
)

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: dictimport <ecdict.csv>")
		os.Exit(2)
	}
	target := config.Get().Paths.DictDB
	if err := dict.ImportCSV(os.Args[1], target, nil); err != nil {
		fmt.Fprintln(os.Stderr, "import:", err)
		os.Exit(1)
	}
	d, err := dict.Open(target)
	if err != nil {
		fmt.Fprintln(os.Stderr, "open:", err)
		os.Exit(1)
	}
	defer d.Close()
	n, _ := d.Count()
	st, _ := os.Stat(target)
	fmt.Printf("entries=%d path=%s size=%.1fMB\n", n, target, float64(st.Size())/1024/1024)
}
