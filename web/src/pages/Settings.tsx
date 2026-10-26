import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import AISettings from '../components/AISettings';
import FontPicker from '../components/FontPicker';
import SubHeader from '../components/SubHeader';
import { api } from '../api';
import {
  APP_THEMES,
  FONT_FAMILY_KEY,
  FONT_OVERRIDE_KEY,
  MODE_KEY,
  appTheme,
  applyAppTheme,
  type AppTheme,
  type ReadMode,
} from '../readingPrefs';

/**
 * The Me→设置 page: the same reading preferences the reader's Aa sheet offers,
 * editable before opening a book. Everything writes the shared localStorage
 * keys the reader reads on mount, so a change here applies to every book.
 * The theme is app-wide: picking one re-themes the whole application at once
 * (html[data-app-theme] + CSS variables), not just the reading page.
 */
export default function Settings() {
  const [font, setFont] = useState(() => localStorage.getItem(FONT_FAMILY_KEY) || 'default');
  const [mode, setMode] = useState<ReadMode>(
    () => (localStorage.getItem(MODE_KEY) as ReadMode) || 'paged',
  );
  const [theme, setTheme] = useState<AppTheme>(() => appTheme());
  // Default ON: without it an EPUB's own font-family beats the picked face.
  const [override, setOverride] = useState(() => localStorage.getItem(FONT_OVERRIDE_KEY) !== '0');
  // The diagnostic log's switch lives here; its entries are on their own page.
  const [logOn, setLogOn] = useState(true);

  useEffect(() => {
    api
      .logState()
      .then((s) => setLogOn(s.enabled))
      .catch(() => {});
  }, []);

  return (
    <div className="page settings-page">
      <SubHeader title="设置" />

      <div className="settings-body">
        <div className="rd-set-row rd-font-row">
          <span className="rd-set-label">字体</span>
          <FontPicker value={font} onChange={setFont} />
        </div>
        <div className="rd-set-row">
          <span className="rd-set-label">翻页模式</span>
          <div className="rd-seg">
            <button
              className={mode === 'paged' ? 'on' : ''}
              onClick={() => {
                localStorage.setItem(MODE_KEY, 'paged');
                setMode('paged');
              }}
            >
              翻页
            </button>
            <button
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
        <div className="rd-set-row">
          <span className="rd-set-label">主题</span>
          <div className="rd-themes">
            {APP_THEMES.map((t) => (
              <button
                key={t.id}
                className={`rd-theme t-${t.id}${theme === t.id ? ' on' : ''}`}
                onClick={() => {
                  applyAppTheme(t.id);
                  setTheme(t.id);
                }}
              >
                <span className="rd-theme-dot" />
                <span>{t.label}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="rd-set-row last">
          <span className="rd-set-label">
            覆盖书籍字体
            <small className="rd-set-desc">
              开启后所选字体强制应用于正文，忽略 EPUB 内嵌的字体设定
            </small>
          </span>
          <button
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

      <div style={{ marginTop: 16 }}>
        <AISettings />
      </div>

      {/* Diagnostics. Next to the AI settings because almost every report that
          arrives is about an AI call or a page that went blank, and both are
          answered by the same file. */}
      <div className="settings-log">
        <div className="settings-log-text">
          <b>诊断日志</b>
          <small>记录 AI 请求与回答、错误和页面跳转，只保存在本机，最多 50 MB</small>
        </div>
        <button
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
        <Link className="btn sm" to="/logs">
          查看
        </Link>
      </div>

      <p className="settings-hint">
        主题全局生效（书架、阅读页同时切换）；字体下载一次即可离线使用，阅读器内（Aa
        面板）也可随时调整。
      </p>
    </div>
  );
}
