package com.wails.app;

import android.webkit.JavascriptInterface;

/**
 * A tiny JS surface for sharing. The wails v3 runtime assigns its own object to
 * window.wails, which shadows the host's @JavascriptInterface methods, so these
 * would be unreachable from JS on the bridge there. This interface lands on its
 * own name (EpubMakerNative, injected by MainActivity) and exposes two things:
 * handing a built EPUB to the system share sheet, and picking up an EPUB that
 * another app shared *into* this one.
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

    /**
     * Hands over the cache paths of EPUBs shared into this app, once each. JSON
     * array; "[]" when nothing is waiting.
     *
     * The page pulls instead of being pushed: a share that cold-starts the app
     * is copied ~400 ms before onPageFinished, so an event carrying the path
     * would arrive when no listener exists. The host keeps the paths queued and
     * only nudges; losing a nudge costs nothing, losing the path costs the book.
     * Called from JavaScript: EpubMakerNative.takePendingShared()
     */
    @JavascriptInterface
    public String takePendingShared() {
        return activity.takePendingSharedImports();
    }
}
