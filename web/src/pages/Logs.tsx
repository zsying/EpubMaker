import { useCallback, useEffect, useMemo, useState } from 'react';
import SubHeader from '../components/SubHeader';
import { api, isDesktopHost, type LogEntry, type LogState } from '../api';
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
type CatFilter = '' | 'ai' | 'ui' | 'nav' | 'tts';
type LevelFilter = '' | 'warn';

const CATS: { id: CatFilter; label: string }[] = [
  { id: '', label: '全部' },
  { id: 'ai', label: 'AI' },
  { id: 'ui', label: '界面' },
  { id: 'nav', label: '跳转' },
  // 听书: the session's own operations plus the online voice's timings. Its own
  // chip because that is the one category the reader scrolls back through to
  // decide whether the reading keeps stalling.
  { id: 'tts', label: '听书' },
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

  // Newest first: what just happened is what a reader is looking for when the
  // page opens. 复制全部 follows the same order so a handover matches the
  // screen; the file itself keeps chronological order.
  const shown = useMemo(() => [...entries].reverse(), [entries]);

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
    return shown
      .map((e) => {
        const head = `[${localTime(e.time)}] ${e.level.toUpperCase()} ${e.cat} ${e.msg}`;
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

  // Sizes are read by a human here, so the ceiling is shown in the same unit as
  // the file: "512.0 KB / 50 MB" says more than a byte count.
  const human = (n: number) =>
    !n || n < 0
      ? '—'
      : n >= 1 << 20
        ? `${(n / (1 << 20)).toFixed(0)} MB`
        : `${(n / 1024).toFixed(1)} KB`;
  const sizeText = state ? `${human(state.size)} / ${human(state.max)}` : '';

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
          {state && state.max > 0 && (
            <div className="logs-cap">
              超过 {human(state.max)} 后自动删除最早的 {human(state.trim)}，不会无限增长
            </div>
          )}
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
        {shown.map((e, i) => (
          <div className={`log-item lv-${e.level}`} key={`${e.time}-${i}`}>
            <div className="log-head">
              <span className="log-time">{localTime(e.time)}</span>
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

/**
 * Renders a stored timestamp in the device's own clock: "10-30 16:57:24".
 *
 * New entries carry an explicit UTC offset (logx stamps "+08:00"), so they
 * convert exactly. Older Android entries are bare UTC — the Go process had no
 * zoneinfo until SetTimezone landed — and bare desktop entries are local wall
 * clock from the start, hence the host split for the suffix-less case.
 */
function localTime(t: string): string {
  const bare = !/(?:Z|[+-]\d{2}:?\d{2})$/.test(t);
  const d = new Date(t.replace(' ', 'T') + (bare && !isDesktopHost() ? 'Z' : ''));
  if (isNaN(d.getTime())) return t;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
