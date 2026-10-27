import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ExplainResult, VocabItem } from '../api';
import { useBackClose } from '../backNav';
import { emphasise } from '../highlight';
import { speakWord } from '../speech';
import { STATUS_HINT, STATUS_LABEL, scheduleLine } from '../vocabLabels';
import AIPanel from './AIPanel';

/**
 * One word, opened from the notebook list.
 *
 * The list row is a preview: a headword, a gloss and the sentence the word was
 * met in, squeezed onto a card. Tapping it used to throw the reader back into
 * the book, which answered a different question than the one the tap asked ("what
 * was this?" not "where was this?") and, on a page-turn layout, also lost their
 * place-in-the-chapter nothing but a highlight could restore.
 *
 * So the tap opens this sheet instead — the word at reading size, the whole
 * sentence, and the two things a row cannot offer: an AI explanation of this word
 * in this sentence, and the way back to the page it came from. Leaving for the
 * book is a deliberate second tap, and it is the only thing here that leaves.
 */
export default function VocabCard({
  item,
  onClose,
  onLocate,
}: {
  item: VocabItem;
  onClose: () => void;
  /** "定位原文": open the chapter at the word. The parent closes the sheet first. */
  onLocate: () => void;
}) {
  const nav = useNavigate();
  // The answer to this exact question, if it was ever asked: a cache read only,
  // so the sheet can show it without a tap and without a network call.
  const [cached, setCached] = useState<ExplainResult | null>(null);
  const [asking, setAsking] = useState(false);

  const sentence = (item.context || '').trim();
  const atPage = Boolean(item.bookId && item.chapterId);

  // A hook, and it lives above the early returns: this component always renders,
  // but the rule is the same everywhere — no conditional hooks.
  useBackClose(asking, () => setAsking(false));

  useEffect(() => {
    setCached(null);
    if (!sentence) return;
    let alive = true;
    api
      .aiExplainCached(item.term, sentence)
      .then((r) => {
        if (alive) setCached(r ?? null);
      })
      .catch(() => {
        /* a cache read failure is a miss, not a problem for the reader */
      });
    return () => {
      alive = false;
    };
  }, [item.id, item.term, sentence]);

  // One line of provenance and one line of study state. Both are the same facts
  // the row showed, spelled out here because this is where there is room for
  // them.
  const origin = item.bookTitle
    ? `${item.bookTitle} · ${item.chapterTitle || '未知章节'}`
    : '原书已删除';
  const counts = [
    item.lookups > 1 ? `查过 ${item.lookups} 次` : '',
    item.reviews > 0 ? `复习 ${item.reviews} 次` : '',
    item.lapses > 0 ? `忘过 ${item.lapses} 次` : '',
  ]
    .filter(Boolean)
    .join(' · ');

  const closeThen = (fn: () => void) => {
    onClose();
    fn();
  };

  return (
    <div className="sheet-mask" onClick={onClose}>
      <div className="sheet vocab-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="vocab-sheet-head">
          <span className="vocab-sheet-word">{item.term}</span>
          {item.phonetic && <span className="dict-phon">/{item.phonetic}/</span>}
          <button className="btn sm" onClick={() => speakWord(item.term)}>
            发音
          </button>
          <span style={{ flex: 1 }} />
          <button className="vocab-sheet-close" onClick={onClose} aria-label="关闭">
            ✕
          </button>
        </div>

        <div className="vocab-sheet-body">
          <div className={`vocab-sheet-trans${item.translation ? '' : ' muted'}`}>
            {item.translation || '（词库无释义）'}
          </div>

          {sentence && (
            <div className="vocab-sheet-quote">
              <div className="vocab-sheet-label">原文句子</div>
              <p>{emphasise(sentence, [item.surface, item.term])}</p>
            </div>
          )}

          <div className="vocab-sheet-meta">
            <span className="vocab-sheet-origin">{origin}</span>
            <span className="vocab-sheet-learn">{scheduleLine(item.dueAt)}</span>
            {item.status !== 'new' && (
              <span className={`vocab-status s-${item.status}`} title={STATUS_HINT[item.status]}>
                {STATUS_LABEL[item.status]}
              </span>
            )}
          </div>
          {counts && <div className="vocab-sheet-counts">{counts}</div>}

          {/* Already explained before? Then the answer is on the device and it
              belongs on the card, not behind a button. */}
          {cached && (
            <div className="dict-ai">
              <div className="dict-ai-head">
                <span className="dict-ai-star" aria-hidden="true">
                  ✦
                </span>
                AI 解释 · 本句
              </div>
              {cached.meaning && <div className="dict-ai-meaning">{cached.meaning}</div>}
              {cached.translation && (
                <div className="dict-ai-trans">整句：{cached.translation}</div>
              )}
              {cached.note && <div className="dict-ai-note">{cached.note}</div>}
              {cached.conversationId && (
                <button
                  className="dict-ai-open"
                  onClick={() => closeThen(() => nav(`/ai/${cached.conversationId}`))}
                >
                  查看对话 <span aria-hidden="true">›</span>
                </button>
              )}
            </div>
          )}
        </div>

        <div className="vocab-sheet-actions">
          <button
            className="btn"
            onClick={onLocate}
            disabled={!atPage}
            title={atPage ? '回到这个词出现的地方' : '原书已删除，找不到原文了'}
          >
            定位原文
          </button>
          <button
            className="btn primary"
            disabled={!sentence}
            title={sentence ? '结合这一句解释这个词，并翻译整句' : '没有原句，无法结合上下文解释'}
            onClick={() => setAsking(true)}
          >
            <span aria-hidden="true">✦</span> AI 解释
          </button>
        </div>

        {/* The panel over the sheet, exactly as the reader stacks them: the sheet
            stays underneath, so closing the answer returns to the word rather
            than to the list. */}
        {asking && sentence && (
          <AIPanel<ExplainResult>
            title={`✦ AI 释义 · ${item.term}`}
            run={() => api.explainInContext(item.term, sentence)}
            render={(r) => (
              <>
                {r.cached && <span className="ai-cache-badge">缓存结果</span>}
                <p className="ai-sentence">
                  {emphasise(sentence, [item.surface, item.term], 'ai-hl')}
                </p>
                {r.meaning && (
                  <>
                    <div className="ai-label">
                      在本句中
                      {r.pos && <span className="ai-pos">{r.pos}</span>}
                    </div>
                    <p className="ai-explain">{r.meaning}</p>
                  </>
                )}
                {r.note && <p className="ai-note">{r.note}</p>}
                {r.translation && (
                  <>
                    <div className="ai-label">整句翻译</div>
                    <p className="ai-trans">{r.translation}</p>
                  </>
                )}
              </>
            )}
            onClose={() => setAsking(false)}
            onGoSettings={() => closeThen(() => nav('/settings'))}
            chatId={(r) => r.conversationId}
            onOpenChat={(id) => closeThen(() => nav(`/ai/${id}`))}
          />
        )}
      </div>
    </div>
  );
}
