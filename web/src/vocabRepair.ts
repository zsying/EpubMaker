import { api, VocabItem } from './api';
import { chapterHost, looksLikeFragment, sentenceAt } from './sentence';

/** Words already looked at this session, so switching a filter does not redo the
 *  same work over and over. */
const attempted = new Set<string>();

/** How many rows one pass may touch: this is a repair, not a migration that
 *  should scan a whole notebook on a phone. */
const REPAIR_LIMIT = 12;

/** Comparison form: invisible characters out, case folded. */
function squash(s: string): string {
  return (s || '').replace(/[\u00AD\u200B-\u200D\uFEFF]/g, '').toLowerCase();
}

/**
 * Re-cut the example sentence of entries whose stored context is a fragment.
 *
 * The context is derived — the sentence around the word, sliced out of the
 * chapter when it was looked up. Entries captured before the extraction stopped
 * treating a source line wrap as the end of a sentence hold things like
 * "compensation." instead of the sentence it sits in. Since the chapter is
 * still there, the sentence can simply be cut again with today's rule.
 *
 * Everything here is guarded: the stored offset must still land on the word, and
 * the new sentence must be longer than the old one and still contain the word.
 * A row that fails any of that is left exactly as it was.
 *
 * @returns the new sentences by entry id, already saved.
 */
export async function repairContexts(items: VocabItem[]): Promise<Map<string, string>> {
  const fixed = new Map<string, string>();
  const candidates = items
    .filter(
      (it) =>
        !!it.bookId &&
        !!it.chapterId &&
        !attempted.has(it.id) &&
        looksLikeFragment(it.context, it.term),
    )
    .slice(0, REPAIR_LIMIT);
  if (candidates.length === 0) return fixed;

  const chapters = new Map<string, HTMLElement>();
  for (const it of candidates) {
    attempted.add(it.id);
    // The word as it was met — inflected forms are what the offset points at.
    const surface = (it.surface || it.term || '').trim();
    if (!surface) continue;
    try {
      let host = chapters.get(it.chapterId);
      if (!host) {
        const rendered = await api.renderChapter(it.bookId, it.chapterId);
        host = chapterHost(rendered?.html ?? '');
        chapters.set(it.chapterId, host);
      }
      const text = host.textContent || '';
      if (it.offset < 0 || it.offset + surface.length > text.length) continue;
      // The offset is the anchor for everything else: if the chapter no longer
      // has this word there, the sentence would be cut around the wrong place.
      if (squash(text.slice(it.offset, it.offset + surface.length)) !== squash(surface)) continue;
      const next = sentenceAt(host, it.offset, it.offset + surface.length);
      if (!next || next.length <= (it.context || '').trim().length) continue;
      if (!squash(next).includes(squash(surface))) continue;
      await api.setVocabContext(it.id, next);
      fixed.set(it.id, next);
    } catch (e) {
      // A book that was deleted, a chapter that no longer parses: the stored
      // context stays. This is a repair, not an obligation — but it should not
      // fail in silence either, so one line goes to the console.
      console.warn('[vocab] 例句重切失败', it.term, e);
    }
  }
  return fixed;
}
