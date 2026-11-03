import { api, canShareEpubFile, shareEpubFile } from './api';
import { toast, toastError } from './toast';

/**
 * The one 导出 action, shared by the shelf card and the editor header.
 *
 * A built EPUB can end up in two places, and only the host knows which:
 *
 *   - The phone has no save dialog. The file is written to the export staging
 *     directory and handed to the system share sheet, which needs a real file
 *     behind a FileProvider — a download or a data URL is no use there.
 *   - The desktop opens the native save dialog, and the builder writes straight
 *     to the chosen path. The bytes never pass through the WebView, so a big
 *     book costs no base64 copy.
 *
 * Closing the desktop dialog is a decision, not a failure: it says nothing.
 * Every caller used to spell this out on its own, which is how the editor's
 * button ended up asking Android for a save dialog.
 */
export async function exportBookToHost(bookId: string): Promise<void> {
  try {
    if (canShareEpubFile()) {
      toast('正在生成 EPUB…');
      const { path, filename } = await api.exportBookFile(bookId);
      shareEpubFile(path, filename);
      return;
    }
    const res = await api.exportBookTo(bookId);
    if (res.cancelled) return;
    toast(`已导出到 ${res.filename}`, 'success');
  } catch (e) {
    toastError(e);
  }
}
