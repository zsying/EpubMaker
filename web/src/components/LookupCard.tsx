import { useBackClose } from '../backNav';
import { STATUS_LABEL, whenLabel } from '../vocabLabels';
import type { LookupHit } from '../api';
import WordSheet from './WordSheet';

/**
 * One word, opened from 查词历史.
 *
 * The history row is a stub by nature: a notebook row has a sentence and a place
 * in a book, a history row has neither — it remembers *what* was looked up, not
 * where. So this is the short card: the word at reading size with 发音, the gloss
 * in full (the row clamps it to a line), how often and how long ago, and the one
 * thing the history is for — putting the word in the notebook.
 *
 * No 定位原文 (there is no page to go to) and no AI (there is no sentence to
 * explain it in); a link that cannot do anything is worse than no link.
 */
export default function LookupCard({
  hit,
  busy,
  onClose,
  onAdd,
}: {
  hit: LookupHit;
  /** The add request in flight, owned by the page so the list stays in step. */
  busy: boolean;
  onClose: () => void;
  onAdd: () => void;
}) {
  useBackClose(true, onClose);

  return (
    <WordSheet
      word={hit.term}
      phonetic={hit.phonetic}
      onClose={onClose}
      links={
        // Same rule as the word sheet's AI link: the action disappears once it
        // has nothing left to do, instead of sitting there greyed out.
        hit.inNotebook ? null : (
          <button className="vocab-sheet-link" disabled={busy} onClick={onAdd}>
            {busy ? '加入中…' : '加入生词本'}
          </button>
        )
      }
    >
      <div className={`vocab-sheet-trans${hit.translation ? '' : ' muted'}`}>
        {hit.translation || '（词库无释义）'}
      </div>

      <div className="vocab-sheet-meta">
        <span className="vocab-sheet-origin">
          查过 {hit.lookups} 次 · {whenLabel(hit.lastAt)}
        </span>
        {hit.inNotebook && (
          <span className="vocab-sheet-learn">
            已在生词本{hit.status ? ` · ${STATUS_LABEL[hit.status]}` : ''}
          </span>
        )}
      </div>
    </WordSheet>
  );
}
