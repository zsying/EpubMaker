import type { ReactNode } from 'react';

/**
 * Marks the headword inside its example sentence, so the row reads as a quote
 * rather than an unexplained string. Falls back to the base form when the
 * stored surface text is inflected differently.
 */
export function emphasise(text: string, candidates: string[]): ReactNode {
  const lower = text.toLowerCase();
  for (const c of candidates) {
    const needle = c.trim().toLowerCase();
    if (!needle) continue;
    const at = lower.indexOf(needle);
    if (at < 0) continue;
    return (
      <>
        {text.slice(0, at)}
        <mark className="vocab-hit">{text.slice(at, at + needle.length)}</mark>
        {text.slice(at + needle.length)}
      </>
    );
  }
  return text;
}
