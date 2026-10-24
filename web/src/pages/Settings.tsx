import { useState } from 'react';
import FontPicker from '../components/FontPicker';
import SubHeader from '../components/SubHeader';
import {
  FONT_FAMILY_KEY,
  FONT_OVERRIDE_KEY,
  MODE_KEY,
  THEME_KEY,
  type ReadMode,
  type ReadTheme,
} from '../readingPrefs';

/**
 * The Me→设置 page: the same reading preferences the reader's Aa sheet offers,
 * editable before opening a book. Everything writes the shared localStorage
 * keys the reader reads on mount, so a change here applies to every book.
 */
export default function Settings() {
  const [font, setFont] = useState(() => localStorage.getItem(FONT_FAMILY_KEY) || 'default');
  const [mode, setMode] = useState<ReadMode>(() => (localStorage.getItem(MODE_KEY) as ReadMode) || 'paged');
  const [theme, setTheme] = useState<ReadTheme>(() => (localStorage.getItem(THEME_KEY) as ReadTheme) || 'paper');
  // Default ON: without it an EPUB's own font-family beats the picked face.
  const [override, setOverride] = useState(() => localStorage.getItem(FONT_OVERRIDE_KEY) !== '0');

  const themes: Array<{ id: ReadTheme; label: string }> = [
    { id: 'paper', label: '纸白' },
    { id: 'green', label: '护眼' },
    { id: 'dark', label: '夜间' },
  ];

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
          <span className="rd-set-label">阅读背景</span>
          <div className="rd-themes">
            {themes.map((t) => (
              <button
                key={t.id}
                className={`rd-theme t-${t.id}${theme === t.id ? ' on' : ''}`}
                onClick={() => {
                  localStorage.setItem(THEME_KEY, t.id);
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
            <small className="rd-set-desc">开启后所选字体强制应用于正文，忽略 EPUB 内嵌的字体设定</small>
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

      <p className="settings-hint">字体下载一次即可离线使用；阅读器内（Aa 面板）也可随时调整这些设置。</p>
    </div>
  );
}
