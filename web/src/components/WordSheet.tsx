import type { ReactNode } from 'react';
import { speakWord } from '../speech';

/**
 * The shell every word sheet shares: headword, phonetic, 发音, ✕, a scrolling
 * body, and a footer of quiet links.
 *
 * Two cards are built on it — the notebook's word (which has a sentence, a
 * schedule and an AI gloss) and the lookup history's word (which has none of
 * those) — and they differ only in what goes in the body and which links the
 * footer keeps. Keeping the head here means "what a word looks like when it is
 * opened" has exactly one answer, and the AI panel still stacks inside the
 * sheet rather than on top of the page.
 */
export default function WordSheet({
  word,
  phonetic,
  onClose,
  children,
  links,
  overlay,
}: {
  word: string;
  phonetic?: string;
  onClose: () => void;
  /** The scrollable middle: gloss, quote, provenance, whatever the card has. */
  children: ReactNode;
  /** The footer. Quiet links, or a note saying why there are none. */
  links?: ReactNode;
  /** Sits inside the sheet, above the footer: the AI panel lands here. */
  overlay?: ReactNode;
}) {
  return (
    <div className="sheet-mask" onClick={onClose}>
      <div className="sheet vocab-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="vocab-sheet-head">
          <span className="vocab-sheet-word">{word}</span>
          {phonetic && <span className="dict-phon">/{phonetic}/</span>}
          <button className="btn sm" onClick={() => speakWord(word)}>
            发音
          </button>
          <span style={{ flex: 1 }} />
          <button className="vocab-sheet-close" onClick={onClose} aria-label="关闭">
            ✕
          </button>
        </div>

        <div className="vocab-sheet-body">{children}</div>

        {links && <div className="vocab-sheet-links">{links}</div>}
        {overlay}
      </div>
    </div>
  );
}
