import { useEffect, useState } from 'react';
import { api } from '../api';
import { toast, toastError } from '../toast';
import { FONT_FAMILY_KEY } from '../readingPrefs';

export const CUSTOM_FONT_FAMILY = 'EpubBookFont';

export interface CatalogFont {
  file: string;
  label: string;
  note: string;
  url: string;
}

/** Open-source reading faces. Every entry must be a single downloadable file
 * (an @font-face can only point at one URL): split webfont packages do not
 * qualify. All OFL. */
export const FONT_CATALOG: CatalogFont[] = [
  {
    file: 'SourceHanSerifCN-Regular.otf',
    label: '思源宋体',
    note: '正文推荐',
    url: 'https://cdn.jsdelivr.net/gh/adobe-fonts/source-han-serif@release/SubsetOTF/CN/SourceHanSerifCN-Regular.otf',
  },
  {
    file: 'SourceHanSansCN-Regular.otf',
    label: '思源黑体',
    note: '正文推荐',
    url: 'https://cdn.jsdelivr.net/gh/adobe-fonts/source-han-sans@release/SubsetOTF/CN/SourceHanSansCN-Regular.otf',
  },
  {
    // Kai style brush handwriting (Google Fonts, OFL).
    file: 'MaShanZheng-Regular.ttf',
    label: '马善政楷书',
    note: '毛笔楷体',
    url: 'https://cdn.jsdelivr.net/gh/google/fonts@main/ofl/mashanzheng/MaShanZheng-Regular.ttf',
  },
  {
    // Semi-cursive running hand (Google Fonts, OFL).
    file: 'ZhiMangXing-Regular.ttf',
    label: '志莽行书',
    note: '行书',
    url: 'https://cdn.jsdelivr.net/gh/google/fonts@main/ofl/zhimangxing/ZhiMangXing-Regular.ttf',
  },
  {
    // Loose cursive brush hand (Google Fonts, OFL).
    file: 'LiuJianMaoCao-Regular.ttf',
    label: '柳建毛草',
    note: '草书手写',
    url: 'https://cdn.jsdelivr.net/gh/google/fonts@main/ofl/liujianmaocao/LiuJianMaoCao-Regular.ttf',
  },
  {
    // Running-hand casual script (Google Fonts, OFL).
    file: 'LongCang-Regular.ttf',
    label: '龙藏行书',
    note: '行楷手写',
    url: 'https://cdn.jsdelivr.net/gh/google/fonts@main/ofl/longcang/LongCang-Regular.ttf',
  },
  {
    // Rounded playful handwriting (Google Fonts, OFL).
    file: 'ZCOOLKuaiLe-Regular.ttf',
    label: '站酷快乐体',
    note: '圆润手写',
    url: 'https://cdn.jsdelivr.net/gh/google/fonts@main/ofl/zcoolkuaile/ZCOOLKuaiLe-Regular.ttf',
  },
];

/**
 * The font chips shared by the reader's Aa sheet and the settings page.
 * `value`/`onChange` carry the stored family file ('default' or a catalogue
 * file name); persistence is handled here so both surfaces write the same key.
 * An undownloaded entry downloads on first tap (label shows ↓), then applies.
 */
export default function FontPicker({ value, onChange }: { value: string; onChange: (file: string) => void }) {
  const [fonts, setFonts] = useState<Array<{ file: string; size: number }>>([]);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = () =>
    api
      .listFonts()
      .then((list) => setFonts(list.map((f) => ({ file: f.file, size: f.size }))))
      .catch(() => {});

  useEffect(() => {
    void refresh();
  }, []);

  async function pick(f: CatalogFont) {
    if (value === f.file || busy) return;
    if (!fonts.some((x) => x.file === f.file)) {
      setBusy(f.file);
      try {
        await api.downloadFont(f.file, f.url);
        await refresh();
        toast(`已下载「${f.label}」`, 'success');
      } catch (e) {
        toastError(e);
        return;
      } finally {
        setBusy(null);
      }
    }
    localStorage.setItem(FONT_FAMILY_KEY, f.file);
    onChange(f.file);
  }

  return (
    <div className="rd-fonts">
      <button className={`rd-font${value === 'default' ? ' on' : ''}`} onClick={() => {
        localStorage.setItem(FONT_FAMILY_KEY, 'default');
        onChange('default');
      }}>
        默认
      </button>
      {FONT_CATALOG.map((f) => {
        const installed = fonts.some((x) => x.file === f.file);
        return (
          <button
            key={f.file}
            className={`rd-font${value === f.file ? ' on' : ''}`}
            disabled={busy === f.file}
            onClick={() => void pick(f)}
          >
            {busy === f.file ? (
              '下载中…'
            ) : (
              <>
                {f.label + (installed ? '' : ' ↓')}
                <small className="rd-font-note">{f.note}</small>
              </>
            )}
          </button>
        );
      })}
    </div>
  );
}
