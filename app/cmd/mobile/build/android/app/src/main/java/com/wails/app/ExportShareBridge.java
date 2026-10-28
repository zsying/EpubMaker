package com.wails.app;

import android.webkit.JavascriptInterface;

/**
 * A tiny JS surface for 导出. The wails v3 runtime assigns its own object to
 * window.wails, which shadows the host's @JavascriptInterface methods, so a
 * shareExport added to WailsJSBridge is unreachable from JS. This interface
 * lands on its own name (EpubMakerNative, injected by MainActivity) and
 * exposes exactly one action: handing a built EPUB to the system share sheet.
 */
public class ExportShareBridge {
    private final MainActivity activity;

    public ExportShareBridge(MainActivity activity) {
        this.activity = activity;
    }

    /**
     * JS passes the absolute path returned by the ExportBookFile binding plus
     * the file name; the intent itself must start from the UI thread.
     * Called from JavaScript: EpubMakerNative.shareExport(path, filename)
     */
    @JavascriptInterface
    public void shareExport(String path, String filename) {
        activity.runOnUiThread(() -> activity.shareExportFile(path, filename));
    }
}
