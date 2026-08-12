import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import DOMPurify from 'dompurify';
import { api, Book, Chapter, ImageAsset } from '../api';
import { toast, toastError } from '../toast';

const COLORS = ['#2f6bff', '#e2725b', '#1a9c62', '#a05ce0', '#d9a12b', '#0e9ba8', '#d94f8a', '#6b7a90'];

interface Part {
  title: string;
  author: string;
  /** 封面选择：'' = 沿用原书封面；'__none__' = 不使用封面；其余为图片 href */
  coverHref: string;
}

/** 封面选项中表示“不使用封面”的哨兵值 */
const NO_COVER = '__none__';

/** 封面相册选择器：缩略图 + 名称，点选即生效 */
function CoverGallery({
  part,
  images,
  inheritUrl,
  onPick
}: {
  part: Part;
  images: ImageAsset[];
  inheritUrl: string | null;
  onPick: (href: string) => void;
}) {
  const items: { key: string; label: string; href: string; thumb: string | null }[] = [
    { key: '__inherit', label: '原书封面', href: '', thumb: inheritUrl },
    { key: '__none', label: '不使用', href: NO_COVER, thumb: null }
  ];
  for (const img of images) {
    items.push({ key: img.href, label: img.href.split('/').pop() || img.href, href: img.href, thumb: img.url });
  }

  return (
    <div className="split-cover-picker">
      {items.map((it) => {
        const active = it.href === '' ? part.coverHref === '' : part.coverHref === it.href;
        const placeholder = !it.thumb;
        const phText = it.key === '__none' ? '✕' : '原';
        return (
          <button
            type="button"
            key={it.key}
            className={`split-cover-pick${active ? ' active' : ''}${placeholder ? ' is-ph' : ''}`}
            title={it.label}
            onClick={() => onPick(it.href)}
          >
            <span className="thumb">{it.thumb ? <img src={it.thumb} alt={it.label} /> : <span>{phText}</span>}</span>
            <span className="label">{it.label}</span>
          </button>
        );
      })}
    </div>
  );
}

/** 计算某分卷当前封面的缩略图与文案 */
function describeCover(part: Part, images: ImageAsset[], inheritUrl: string | null) {
  if (part.coverHref === '') return { label: '原书封面', thumb: inheritUrl, ph: '原' };
  if (part.coverHref === NO_COVER) return { label: '不使用封面', thumb: null, ph: '✕' };
  const img = images.find((i) => i.href === part.coverHref);
  return {
    label: img ? img.href.split('/').pop() || img.href : part.coverHref,
    thumb: img?.url ?? null,
    ph: '图'
  };
}

/**
 * 封面选择字段：未展开时只显示当前封面缩略图与「更换封面」按钮；
 * 点击展开预览相册，选完即收起。
 */
function CoverField({
  part,
  images,
  inheritUrl,
  open,
  onToggle,
  onPick
}: {
  part: Part;
  images: ImageAsset[];
  inheritUrl: string | null;
  open: boolean;
  onToggle: () => void;
  onPick: (href: string) => void;
}) {
  const cur = describeCover(part, images, inheritUrl);
  if (!open) {
    return (
      <div className="cover-field">
        <span className={`cover-thumb${cur.thumb ? '' : ' is-ph'}`}>
          {cur.thumb ? <img src={cur.thumb} alt={cur.label} /> : <span>{cur.ph}</span>}
        </span>
        <div className="cover-meta">
          <div className="muted" style={{ fontSize: 11.5 }}>封面</div>
          <div className="cover-cur" title={cur.label}>{cur.label}</div>
        </div>
        <button className="btn sm" onClick={onToggle}>更换封面</button>
      </div>
    );
  }
  return (
    <div className="cover-field open">
      <div className="cover-field-head">
        <span className="muted" style={{ fontSize: 11.5 }}>选择封面（点击缩略图）</span>
        <button className="btn sm ghost" onClick={onToggle}>收起</button>
      </div>
      <CoverGallery
        part={part}
        images={images}
        inheritUrl={inheritUrl}
        onPick={(href) => {
          onPick(href);
          onToggle();
        }}
      />
    </div>
  );
}

/** 章节预览弹窗：调 renderChapter 拿已重写图片的 HTML，净化后展示 */
function ChapterPreview({
  bookId,
  chapter,
  onClose
}: {
  bookId: string;
  chapter: Chapter;
  onClose: () => void;
}) {
  const [html, setHtml] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await api.renderChapter(bookId, chapter.id);
        if (alive) setHtml(r.html);
      } catch (e) {
        if (alive) setHtml('<p class="muted">章节内容读取失败</p>');
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [bookId, chapter.id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const safeHtml = useMemo(
    () => DOMPurify.sanitize(html, { ADD_ATTR: ['target'], FORBID_TAGS: ['script', 'style', 'link'] }),
    [html]
  );

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <strong className="modal-title" title={chapter.title}>
            {chapter.title}
          </strong>
          <span className="muted" style={{ fontSize: 12, flex: 'none' }}>#{chapter.index + 1}</span>
          <span style={{ flex: 1 }} />
          <button className="icon-btn" title="关闭" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="modal-body">
          {loading ? (
            <div className="loading">加载中…</div>
          ) : (
            <div className="reader-content" dangerouslySetInnerHTML={{ __html: safeHtml }} />
          )}
        </div>
      </div>
    </div>
  );
}

export default function Split() {
  const { id = '' } = useParams();
  const nav = useNavigate();
  const [book, setBook] = useState<Book | null>(null);
  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [images, setImages] = useState<ImageAsset[]>([]);
  const [loading, setLoading] = useState(true);
  const [parts, setParts] = useState<Part[]>([]);
  /** chapterId -> partIndex（-1 表示不包含） */
  const [assign, setAssign] = useState<Record<string, number>>({});
  const [deleteSource, setDeleteSource] = useState(false);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [openCoverFor, setOpenCoverFor] = useState<number | null>(null);
  const [preview, setPreview] = useState<Chapter | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const [b, cs, imgs] = await Promise.all([
          api.getBook(id),
          api.listChapters(id),
          api.images(id)
        ]);
        setBook(b);
        setChapters(cs);
        setImages(imgs);
        setParts([
          { title: `${b.title} 上`, author: b.author, coverHref: '' },
          { title: `${b.title} 下`, author: b.author, coverHref: '' }
        ]);
        const half = Math.ceil(cs.length / 2);
        const a: Record<string, number> = {};
        cs.forEach((c, i) => (a[c.id] = i < half ? 0 : 1));
        setAssign(a);
      } catch (e) {
        toastError(e);
      } finally {
        setLoading(false);
      }
    })();
  }, [id]);

  const counts = useMemo(() => {
    const m = parts.map(() => 0);
    for (const c of chapters) {
      const p = assign[c.id];
      if (p >= 0 && p < m.length) m[p]++;
    }
    return m;
  }, [parts, chapters, assign]);

  function evenSplit(n: number) {
    if (!book || n < 1) return;
    const size = Math.ceil(chapters.length / n);
    const next: Part[] = Array.from({ length: n }, (_, i) => ({
      title: `${book.title} 第${i + 1}卷`,
      author: book.author,
      coverHref: ''
    }));
    const a: Record<string, number> = {};
    chapters.forEach((c, i) => (a[c.id] = Math.min(n - 1, Math.floor(i / size))));
    setParts(next);
    setAssign(a);
  }

  function setPart(cid: string, p: number) {
    setAssign((prev) => ({ ...prev, [cid]: p }));
  }

  function setPartField(i: number, patch: Partial<Part>) {
    setParts((prev) => prev.map((p, k) => (k === i ? { ...p, ...patch } : p)));
  }

  /** 从当前章节开始，到下一个分卷起点之前，全部划入同一卷 */
  function assignFrom(cid: string, p: number) {
    const i = chapters.findIndex((c) => c.id === cid);
    if (i < 0) return;
    const a = { ...assign };
    for (let k = i; k < chapters.length; k++) a[chapters[k].id] = p;
    setAssign(a);
  }

  // Opens the native image picker and uploads the chosen file as a cover.
  async function pickCover() {
    setUploading(true);
    try {
      const up = await api.uploadCover(id).catch((e) => {
        if (String((e as Error)?.message ?? e).includes('未选择')) return null;
        throw e;
      });
      if (!up) return; // user cancelled the dialog
      const asset: ImageAsset = { href: up.href, size: 0, url: up.url };
      setImages((prev) => [...prev, asset]);
      // 自动把新封面上到所有分卷（用户可单独覆盖）
      setParts((prev) => prev.map((p) => ({ ...p, coverHref: up.href })));
      toast('已上传并应用到各分卷封面', 'success');
    } catch (err) {
      toastError(err);
    } finally {
      setUploading(false);
    }
  }

  async function run() {
    const payload = parts
      .map((p, i) => ({
        title: p.title.trim() || `分卷 ${i + 1}`,
        author: p.author,
        chapterIds: chapters.filter((c) => assign[c.id] === i).map((c) => c.id),
        coverHref: p.coverHref === '' ? undefined : p.coverHref === NO_COVER ? null : p.coverHref
      }))
      .filter((p) => p.chapterIds.length > 0);

    if (!payload.length) return toast('每个分卷都为空，无法拆分', 'error');
    if (
      deleteSource &&
      !confirm('拆分完成后将删除原书籍，且不可恢复。确定继续吗？')
    )
      return;

    setBusy(true);
    try {
      const created = await api.split(id, payload, deleteSource);
      toast(`已生成 ${created.length} 本新书籍`, 'success');
      nav('/');
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <div className="loading">加载中…</div>;
  if (!book) return <div className="page empty">书籍不存在</div>;

  return (
    <div className="page wide split-page">
      <div className="lib-head">
        <h1 style={{ fontSize: 18 }}>拆分 · {book.title}</h1>
        <span className="tag">{chapters.length} 章</span>
        <span style={{ flex: 1 }} />
        <Link className="btn" to={`/books/${id}/edit`}>
          返回整理
        </Link>
      </div>

      <div className="split-grid">
        {/* 左栏：章节列表，独立滚动 */}
        <div className="pane split-left" style={{ padding: 8 }}>
          {chapters.map((c, i) => {
            const p = assign[c.id] ?? -1;
            return (
              <div className="split-row" key={c.id}>
                <span className="idx muted" style={{ width: 30, textAlign: 'right', fontSize: 11.5 }}>
                  {i + 1}
                </span>
                <button
                  type="button"
                  className="swatch swatch-btn"
                  title={p >= 0 ? '点击设为「不包含」' : '当前未包含，点下拉框选择分卷'}
                  style={{ background: p >= 0 ? COLORS[p % COLORS.length] : '#dfe3ea' }}
                  onClick={() => setPart(c.id, -1)}
                />
                <span className="name" title={c.title}>
                  {c.title}
                </span>
                <button
                  className="icon-btn preview-btn"
                  title="预览本章"
                  onClick={() => setPreview(c)}
                >
                  <svg
                    viewBox="0 0 24 24"
                    width="15"
                    height="15"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                    <circle cx="12" cy="12" r="3" />
                  </svg>
                </button>
                <select
                  className="select"
                  style={{ width: 130 }}
                  value={p}
                  onChange={(e) => setPart(c.id, Number(e.target.value))}
                >
                  <option value={-1}>不包含</option>
                  {parts.map((pt, k) => (
                    <option key={k} value={k}>
                      {pt.title || `分卷 ${k + 1}`}
                    </option>
                  ))}
                </select>
                <button
                  className="btn sm ghost"
                  title={
                    p >= 0
                      ? '从这一章起，后面全部归入当前分卷'
                      : '从这一章起，后面全部设为「不包含」'
                  }
                  onClick={() => assignFrom(c.id, p)}
                >
                  往下同卷
                </button>
              </div>
            );
          })}
        </div>

        {/* 右栏：分卷设置，独立滚动 */}
        <div className="split-right">
          <div className="pane" style={{ marginBottom: 14 }}>
            <div className="section-title">
              分卷设置
              <span style={{ flex: 1 }} />
              <button
                className="btn sm"
                onClick={() =>
                  setParts([...parts, { title: `分卷 ${parts.length + 1}`, author: book.author, coverHref: '' }])
                }
              >
                + 分卷
              </button>
            </div>

            {parts.map((p, i) => (
              <div className="part-card" key={i}>
                <div className="head">
                  <span className="swatch" style={{ background: COLORS[i % COLORS.length] }} />
                  <span className="part-chip">{counts[i] ?? 0} 章</span>
                  <span style={{ flex: 1 }} />
                  <button
                    className="icon-btn danger"
                    title="删除分卷"
                    onClick={() => {
                      const next = parts.filter((_, k) => k !== i);
                      const a: Record<string, number> = {};
                      for (const [cid, v] of Object.entries(assign)) {
                        a[cid] = v === i ? -1 : v > i ? v - 1 : v;
                      }
                      setParts(next);
                      setAssign(a);
                      setOpenCoverFor((prev) =>
                        prev === null ? null : prev === i ? null : prev > i ? prev - 1 : prev
                      );
                    }}
                  >
                    ✕
                  </button>
                </div>
                <input
                  className="input"
                  style={{ marginBottom: 6 }}
                  placeholder="分卷书名"
                  value={p.title}
                  onChange={(e) => setPartField(i, { title: e.target.value })}
                />
                <input
                  className="input"
                  placeholder="作者"
                  value={p.author}
                  onChange={(e) => setPartField(i, { author: e.target.value })}
                />

                <div style={{ marginTop: 8, borderTop: '1px dashed #e3e7ee', paddingTop: 8 }}>
                  <CoverField
                    part={p}
                    images={images}
                    inheritUrl={book?.coverUrl ?? null}
                    open={openCoverFor === i}
                    onToggle={() => setOpenCoverFor((prev) => (prev === i ? null : i))}
                    onPick={(href) => setPartField(i, { coverHref: href })}
                  />
                </div>
              </div>
            ))}

            <button
              className="add-part-btn"
              onClick={() =>
                setParts([...parts, { title: `分卷 ${parts.length + 1}`, author: book.author, coverHref: '' }])
              }
            >
              + 添加分卷
            </button>

            <div className="toolbar" style={{ marginTop: 10 }}>
              <span className="muted" style={{ fontSize: 12 }}>快速平均拆分：</span>
              {[2, 3, 4, 5].map((n) => (
                <button key={n} className="btn sm" onClick={() => evenSplit(n)}>
                  {n} 卷
                </button>
              ))}
            </div>

            <div className="toolbar" style={{ marginTop: 8 }}>
              <button className="btn sm" disabled={uploading} onClick={() => void pickCover()}>
                {uploading ? '上传中…' : '+ 上传新封面'}
              </button>
              <span className="muted" style={{ fontSize: 11.5 }}>
                上传后自动应用到各分卷，可单独改；原书图片也在相册中可选
              </span>
            </div>
          </div>

          <div className="pane">
            <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, marginBottom: 12 }}>
              <input type="checkbox" checked={deleteSource} onChange={(e) => setDeleteSource(e.target.checked)} />
              拆分成功后删除原书籍
            </label>
            <button className="btn primary" style={{ width: '100%', height: 36 }} disabled={busy} onClick={() => void run()}>
              {busy ? '拆分中…' : '开始拆分'}
            </button>
            <div className="muted" style={{ fontSize: 11.5, marginTop: 10, lineHeight: 1.7 }}>
              拆分会为每个分卷创建一本新书籍，自动携带其章节引用到的图片、样式与字体，原书籍默认保留。每卷可单独选封面：沿用原书、不用封面、或相册里任选原书图片、或上传新封面。
            </div>
          </div>
        </div>
      </div>

      {preview && <ChapterPreview bookId={id} chapter={preview} onClose={() => setPreview(null)} />}
    </div>
  );
}
