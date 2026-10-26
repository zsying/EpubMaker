import { useCallback, useEffect, useState } from 'react';
import SubHeader from '../components/SubHeader';
import { api, type LogEntry, type LogState } from '../api';
import { toast, toastError } from '../toast';

/**
 * 我的 → 设置 → 诊断日志.
 *
 * The log is the only thing a reader can hand over when something goes wrong:
 * the AI features talk to a provider the developer cannot reach, and the
 * failures that blank the screen leave no trace in the packaged app. It is
 * local (never uploaded), switchable, and clearable — the three promises the
 * heading makes, all enforced by the Go side (internal/logx).
 *
 * Refresh is manual rather than polled: the interesting entries are the ones
 * written while the reader was doing something else, and a list that reorders
 * itself under a thumb is worse than a button.
 */
type CatFilter = '' | 'ai' | 'ui' | 'nav';
type LevelFilter = '' | 'warn';

const CATS: { id: CatFilter; label: string }[] = [
  { id: '', label: '全部' },
  { id: 'ai', label: 'AI' },
  { id: 'ui', label: '界面' },
  { id: 'nav', label: '跳转' },
];

export default function Logs() {
  const [state, setState] = useState<LogState | null>(null);
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [cat, setCat] = useState<CatFilter>('');
  const [level, setLevel] = useState<LevelFilter>('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setError('');
    try {
      const [st, list] = await Promise.all([api.logState(), api.logEntries(0, cat, level)]);
      setState(st);
      setEntries(list);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [cat, level]);

  useEffect(() => {
    void load();
  }, [load]);

  async function toggle() {
    if (!state) return;
    setBusy(true);
    try {
      await api.setLogEnabled(!state.enabled);
      await load();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  }

  async function clear() {
    if (!window.confirm('清空所有日志？此操作不可撤销。')) return;
    setBusy(true);
    try {
      await api.clearLog();
      await load();
      toast('日志已清空', 'success');
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  }

  /** Plain-text dump for a bug report. Long fields are kept as-is: the whole
   * point of copying is to hand over the prompt that produced a bad answer. */
  function asText(): string {
    return entries
      .map((e) => {
        const head = `[${e.time}] ${e.level.toUpperCase()} ${e.cat} ${e.msg}`;
        const data = e.data
          ? Object.entries(e.data)
              .map(([k, v]) => `    ${k}: ${v}`)
              .join('\n')
          : '';
        return data ? `${head}\n${data}` : head;
      })
      .join('\n\n');
  }

  async function copyAll() {
    const text = asText();
    if (!text) {
      toast('没有可复制的日志', 'info');
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      toast('已复制到剪贴板', 'success');
    } catch {
      // WebView clipboard access is not guaranteed; a hidden textarea plus
      // execCommand is the fallback that still works there.
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand('copy');
        toast('已复制到剪贴板', 'success');
      } catch {
        toast('复制失败，可长按选择文本', 'error');
      } finally {
        document.body.removeChild(ta);
      }
    }
  }

  const sizeText = state ? `${(state.size / 1024).toFixed(1)} KB` : '';

  return (
    <div className="page logs-page">
      <SubHeader title="诊断日志">
        <button className="btn sm" onClick={() => void load()} disabled={busy}>
          刷新
        </button>
      </SubHeader>

      <div className="logs-panel">
        <div className="logs-row">
          <div className="logs-row-text">
            <b>记录日志</b>
            <small>AI 请求与回答、错误和页面跳转，只保存在本机，不会上传</small>
          </div>
          <button
            role="switch"
            aria-checked={!!state?.enabled}
            aria-label="记录日志"
            className={`rd-switch${state?.enabled ? ' on' : ''}`}
            disabled={busy || !state}
            onClick={() => void toggle()}
          >
            <span className="rd-switch-knob" />
          </button>
        </div>

        <div className="logs-meta">
          <span>{state ? `${state.count} 条` : '…'}</span>
          <span className="logs-dot">·</span>
          <span>{sizeText}</span>
          {state?.path && <div className="logs-path">{state.path}</div>}
        </div>

        <div className="logs-filters">
          {CATS.map((c) => (
            <button
              key={c.id || 'all'}
              className={`logs-chip${cat === c.id ? ' on' : ''}`}
              onClick={() => setCat(c.id)}
            >
              {c.label}
            </button>
          ))}
          <span className="logs-gap" />
          <button
            className={`logs-chip${level === 'warn' ? ' on' : ''}`}
            onClick={() => setLevel(level === 'warn' ? '' : 'warn')}
          >
            只看警告与错误
          </button>
        </div>

        <div className="logs-actions">
          <button className="btn sm" onClick={() => void copyAll()} disabled={entries.length === 0}>
            复制全部
          </button>
          <button className="btn sm danger" onClick={() => void clear()} disabled={busy}>
            清空
          </button>
        </div>
      </div>

      {error && <div className="logs-error">读取日志失败：{error}</div>}

      {entries.length === 0 && !error && (
        <div className="logs-empty">
          {state?.enabled
            ? '还没有记录。用一会儿再回来看。'
            : '日志已关闭，打开上面的开关即可开始记录。'}
        </div>
      )}

      <div className="logs-list">
        {entries.map((e, i) => (
          <div className={`log-item lv-${e.level}`} key={`${e.time}-${i}`}>
            <div className="log-head">
              <span className="log-time">{e.time.slice(11)}</span>
              <span className={`log-cat cat-${e.cat}`}>{catLabel(e.cat)}</span>
              {e.data?.kind && <span className="log-kind">{e.data.kind}</span>}
              <span className="log-msg">{e.msg}</span>
            </div>
            {e.data && (
              <details className="log-data">
                <summary>详情</summary>
                <pre>
                  {Object.entries(e.data)
                    .map(([k, v]) => `${k}: ${v}`)
                    .join('\n')}
                </pre>
              </details>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function catLabel(cat: string): string {
  switch (cat) {
    case 'ai':
      return 'AI';
    case 'ui':
      return '界面';
    case 'nav':
      return '跳转';
    case 'app':
      return '应用';
  }
  return cat;
}
