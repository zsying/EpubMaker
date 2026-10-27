import { useState, type ReactNode } from 'react';

/**
 * The sentence the answer is about, shown above it.
 *
 * It has to be there — "这里的 would 是过去将来时" is only followable if you can
 * see the clause it talks about — but it cannot be shown at any length: the
 * opening of *Lessons in Chemistry* is one 583-character semicolon-chained
 * sentence, and laid out in full it filled the panel, leaving the explanation
 * the reader tapped for sitting on the bottom edge of the screen.
 *
 * So past four lines it folds, and the fold says so. Nothing is lost: the
 * sentence of record is complete (that is what `sentenceAt` guarantees), and the
 * word sheet underneath the panel shows all of it.
 */
export default function AISentence({
  text,
  children,
  className = 'ai-sentence',
}: {
  /** The plain sentence. Length, not markup, decides whether it folds. */
  text: string;
  /** The same sentence, rendered — usually with the headword marked. */
  children: ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  // Four lines at 15px inside the sheet is roughly this much; below it the fold
  // would cost a tap and save nothing.
  const long = text.trim().length > 240;
  const folded = long && !open;
  return (
    <>
      <p className={`${className}${folded ? ' is-folded' : ''}`}>{children}</p>
      {long && (
        <button className="ai-sentence-more" onClick={() => setOpen((v) => !v)}>
          {open ? '收起整句' : '展开整句'}
        </button>
      )}
    </>
  );
}
