import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import FontPicker, { FONT_CATALOG } from '../components/FontPicker';
import SubHeader from '../components/SubHeader';
import { useBackClose } from '../backNav';
import { api } from '../api';
import {
  APP_THEMES,
  FONT_FAMILY_KEY,
  FONT_OVERRIDE_KEY,
  FONT_SIZE_KEY,
  MODE_KEY,
  TURN_SENSITIVITY_KEY,
  TURN_SENSITIVITY_LEVELS,
  appTheme,
  applyAppTheme,
  turnLevelPct,
  turnSensitivity,
  type AppTheme,
  type ReadMode,
  type TurnSensitivity,
} from '../readingPrefs';

/**
 * 设置 — the reading preferences the reader's Aa sheet offers, editable before
 * opening a book. Everything writes the shared localStorage keys the reader
 * reads on mount, so a change here applies to every book. The theme is
 * app-wide: picking one re-themes the whole application at once
 * (html[data-app-theme] + CSS variables), not just the reading page.
 *
 * One structure for every row (2026-10-28)
 * ---------------------------------------
 * The page used to dump the whole font catalogue inline (eight chips, with
 * "下载中…" and "↓" mixed into the page) while AI was reduced to one line
 * pointing at another page — the same kind of setting, two different depths.
 * The rule now: what needs a preview stays inline (theme swatches, the paged /
 * scroll segment, the switches); what needs browsing or typing sinks one level
 * (the font list, AI, the log). The AI row and the font row are therefore
 * siblings, each one line, each with its current value on the right.
 */

const FONT_SIZE_MIN = 13;
const FONT_SIZE_MAX = 26;

function fontLabel(file: string): string {
  if (!file || file === 'default') return '默认字体';
  return FONT_CATALOG.find((f) => f.file === file)?.label ?? '自定义字体';
}

export default function Settings() {
  const [font, setFont] = useState(() => localStorage.getItem(FONT_FAMILY_KEY) || 'default');
  const [size, setSize] = useState(() => Number(localStorage.getItem(FONT_SIZE_KEY)) || 17);
  const [mode, setMode] = useState<ReadMode>(
    () => (localStorage.getItem(MODE_KEY) as ReadMode) || 'paged',
  );
  const [theme, setTheme] = useState<AppTheme>(() => appTheme());
  const [turnSens, setTurnSens] = useState<TurnSensitivity>(turnSensitivity);
  // Default ON: without it an EPUB's own font-family beats the picked face.
  const [override, setOverride] = useState(() => localStorage.getItem(FONT_OVERRIDE_KEY) !== '0');
  // The diagnostic log's switch lives here; its entries are on their own page.
  const [logOn, setLogOn] = useState(true);
  // The font catalogue is a list, not a preview: it lives one level down.
  const [fontOpen, setFontOpen] = useState(false);
  const [ai, setAi] = useState<{ configured: boolean; model: string } | null>(null);

  useBackClose(fontOpen, () => setFontOpen(false));

  useEffect(() => {
    api
      .logState()
      .then((s) => setLogOn(s.enabled))
      .catch(() => {});
    api
      .aiConfig()
      .then((c) => setAi({ configured: c.configured, model: c.model }))
      .catch(() => {});
  }, []);

  function setSizeBy(delta: number) {
    const next = Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, size + delta));
    localStorage.setItem(FONT_SIZE_KEY, String(next));
    setSize(next);
  }

  return (
    <div className="page settings-page">
      <SubHeader title="设置" />

      <div className="st-grp">
        <div className="st-grp-title">外观</div>
        <div className="st-card">
          <div className="st-themes">
            {APP_THEMES.map((t) => (
              <button
                key={t.id}
                type="button"
                data-theme={t.id}
                aria-pressed={theme === t.id}
                className={`st-th${theme === t.id ? ' on' : ''}`}
                onClick={() => {
                  applyAppTheme(t.id);
                  setTheme(t.id);
                }}
              >
                <span className="st-th-page" />
                <span className="st-th-name">{t.label}</span>
              </button>
            ))}
          </div>
          <div className="st-themes-note">全局生效：书架、阅读页、设置一起换</div>

          <button type="button" className="st-row tap" onClick={() => setFontOpen(true)}>
            <span className="st-lb">
              阅读字体
              <small>{fontLabel(font)}</small>
            </span>
            <svg className="st-chev" width="13" height="13" viewBox="0 0 14 14" aria-hidden="true">
              <path
                d="M5 3l5 4-5 4"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>

          <div className="st-row">
            <span className="st-lb">
              字号
              <small>阅读器内的 Aa 面板同此设置</small>
            </span>
            <div className="st-step">
              <button type="button" aria-label="减小字号" onClick={() => setSizeBy(-1)}>
                A−
              </button>
              <span className="st-step-val">{size}</span>
              <button type="button" aria-label="增大字号" onClick={() => setSizeBy(1)}>
                A+
              </button>
            </div>
          </div>

          <div className="st-row">
            <span className="st-lb">
              覆盖书籍字体
              <small>忽略 EPUB 内嵌的字体设定</small>
            </span>
            <button
              type="button"
              role="switch"
              aria-checked={override}
              aria-label="覆盖书籍字体"
              className={`rd-switch${override ? ' on' : ''}`}
              onClick={() => {
                const next = !override;
                localStorage.setItem(FONT_OVERRIDE_KEY, next ? '1' : '0');
                setOverride(next);
              }}
            >
              <span className="rd-switch-knob" />
            </button>
          </div>
        </div>
      </div>

      <div className="st-grp">
        <div className="st-grp-title">阅读</div>
        <div className="st-card">
          <div className="st-row">
            <span className="st-lb">翻页模式</span>
            <div className="rd-seg">
              <button
                type="button"
                className={mode === 'paged' ? 'on' : ''}
                onClick={() => {
                  localStorage.setItem(MODE_KEY, 'paged');
                  setMode('paged');
                }}
              >
                翻页
              </button>
              <button
                type="button"
                className={mode === 'scroll' ? 'on' : ''}
                onClick={() => {
                  localStorage.setItem(MODE_KEY, 'scroll');
                  setMode('scroll');
                }}
              >
                滚动
              </button>
            </div>
          </div>

          {/* Same key and same levels as the reader's Aa sheet. The hint is a
              share of the page, not a pixel count: this page has no spread to
              measure, and the fraction is what carries across screen sizes. */}
          <div className="st-row">
            <span className="st-lb">
              翻页灵敏度
              <small>横向拖过 {turnLevelPct(turnSens)}% 页宽才翻页</small>
            </span>
            <div className="rd-seg tight">
              {TURN_SENSITIVITY_LEVELS.map((l) => (
                <button
                  key={l.id}
                  type="button"
                  className={turnSens === l.id ? 'on' : ''}
                  aria-pressed={turnSens === l.id}
                  onClick={() => {
                    // Written here rather than in an effect: the reader reads
                    // the key on mount, and the reader is not mounted while
                    // this page is.
                    localStorage.setItem(TURN_SENSITIVITY_KEY, l.id);
                    setTurnSens(l.id);
                  }}
                >
                  {l.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="st-grp">
        <div className="st-grp-title">AI</div>
        <div className="st-card">
          <Link className="st-row tap" to="/llm">
            <span className="st-tile">
              <svg width="16" height="16" viewBox="0 0 18 18" aria-hidden="true">
                <path
                  d="M9 2.4l1.6 5L15.6 9l-5 1.6L9 15.6l-1.6-5L2.4 9l5-1.6z"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinejoin="round"
                />
              </svg>
            </span>
            <span className="st-lb">
              AI 配置
              <small>接口、模型、密钥、提示词库</small>
            </span>
            {ai?.configured ? (
              <span className="st-val">{ai.model}</span>
            ) : (
              <span className="st-badge warn">未配置</span>
            )}
            <svg className="st-chev" width="13" height="13" viewBox="0 0 14 14" aria-hidden="true">
              <path
                d="M5 3l5 4-5 4"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </Link>
        </div>
      </div>

      <div className="st-grp">
        <div className="st-grp-title">诊断</div>
        <div className="st-card">
          <div className="st-row">
            <span className="st-lb">
              诊断日志
              <small>AI 请求、错误和页面跳转，只存本机，最多 50 MB</small>
            </span>
            <button
              type="button"
              role="switch"
              aria-checked={logOn}
              aria-label="记录诊断日志"
              className={`rd-switch${logOn ? ' on' : ''}`}
              onClick={() => {
                const next = !logOn;
                setLogOn(next);
                api.setLogEnabled(next).catch(() => setLogOn(!next));
              }}
            >
              <span className="rd-switch-knob" />
            </button>
          </div>
          <Link className="st-row tap" to="/logs">
            <span className="st-lb">
              查看记录
              <small>打开日志列表</small>
            </span>
            <svg className="st-chev" width="13" height="13" viewBox="0 0 14 14" aria-hidden="true">
              <path
                d="M5 3l5 4-5 4"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </Link>
        </div>
      </div>

      <p className="st-hint">
        需要即时预览的（主题、翻页、开关）就在行上改；需要浏览或输入的（字体、AI、日志）点进下一层。字体下载一次即可离线使用。
      </p>

      {fontOpen && (
        <div className="sheet-mask" onClick={() => setFontOpen(false)}>
          <div
            className="sheet font-sheet"
            role="dialog"
            aria-label="阅读字体"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="sheet-title">阅读字体</div>
            <div className="font-sheet-body">
              <FontPicker
                value={font}
                onChange={(f) => {
                  setFont(f);
                  setFontOpen(false);
                }}
              />
            </div>
            <button type="button" className="sheet-item cancel" onClick={() => setFontOpen(false)}>
              取消
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
