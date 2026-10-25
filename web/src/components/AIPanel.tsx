import { useEffect, useRef, useState, type ReactNode } from 'react';

/**
 * The bottom panel every AI answer lands in (0.4, C 方案).
 *
 * One surface, three callers — the word card's contextual gloss, the sentence
 * parse, the chapter guide — because they share the same four states (asking,
 * failed, answered, cached) and splitting them would triplicate the state
 * machine for no gain.
 *
 * The class names are load-bearing beyond styling: `.sheet-mask` and `.ai-sheet`
 * are on the reader's gesture exemption list (see isNativeTarget in Reader.tsx),
 * so a touch that starts inside the panel scrolls the panel and never turns the
 * page behind it.
 *
 * Retry always re-asks: only completed answers are cached (see askCached on the
 * Go side), so an error state can never be answered from the cache.
 */
interface AIPanelProps<T> {
  title: string;
  /** The call to make. Runs once on open, and again on every retry. */
  run: () => Promise<T>;
  render: (result: T) => ReactNode;
  onClose: () => void;
  /** Offered in the error state: a failed call is often a settings problem. */
  onGoSettings?: () => void;
}

type PanelState<T> =
  { kind: 'loading' } | { kind: 'done'; result: T } | { kind: 'error'; message: string };

export default function AIPanel<T>({ title, run, render, onClose, onGoSettings }: AIPanelProps<T>) {
  const [state, setState] = useState<PanelState<T>>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  // Held in a ref so a parent re-render (which makes a new `run` closure every
  // time) cannot restart the call — only an explicit retry does.
  const runRef = useRef(run);
  runRef.current = run;

  useEffect(() => {
    let alive = true;
    setState({ kind: 'loading' });
    runRef.current().then(
      (result) => {
        if (alive) setState({ kind: 'done', result });
      },
      (e: unknown) => {
        if (alive) {
          setState({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
        }
      },
    );
    return () => {
      alive = false;
    };
  }, [attempt]);

  return (
    <div className="sheet-mask ai-mask" onClick={onClose}>
      <div className="ai-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="ai-sheet-grip" />
        <div className="ai-sheet-head">
          <span className="ai-sheet-title">{title}</span>
          <button className="ai-sheet-close" onClick={onClose} aria-label="关闭">
            ✕
          </button>
        </div>
        <div className="ai-sheet-body">
          {state.kind === 'loading' && (
            <div className="ai-loading">
              <span className="ai-spinner" />
              AI 思考中…
            </div>
          )}
          {state.kind === 'error' && (
            <div className="ai-error">
              <p className="ai-error-msg">{state.message}</p>
              <div className="ai-error-actions">
                <button className="btn sm primary" onClick={() => setAttempt((a) => a + 1)}>
                  重试
                </button>
                {onGoSettings && (
                  <button className="btn sm" onClick={onGoSettings}>
                    去设置
                  </button>
                )}
              </div>
            </div>
          )}
          {state.kind === 'done' && render(state.result)}
        </div>
      </div>
    </div>
  );
}
