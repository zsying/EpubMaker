import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import DOMPurify from 'dompurify';
import { api, Book, Chapter, ImageAsset, TocEntry, downloadDataUrl } from '../api';
import { buildTocItems, visibleTocItems } from '../tocLayout';
import { Caret } from '../Caret';
import { toast, toastError } from '../toast';
import SubHeader from '../components/SubHeader';

type Tab = 'book' | 'chapter';

export default function Editor() {
  const { id = '' } = useParams();
  const nav = useNavigate();

  const [book, setBook] = useState<Book | null>(null);
  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [toc, setToc] = useState<TocEntry[]>([]);
  // Collapsed hierarchical-group keys in the chapter list.
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const tocItems = useMemo(() => buildTocItems(toc, chapters), [toc, chapters]);
  const toggleGroup = (key: string) =>
    setCollapsed((prev) => {
      const n = new Set(prev);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });
  const [images, setImages] = useState<ImageAsset[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>('book');

  // 书籍信息表单
  const [form, setForm] = useState({
    title: '',
    author: '',
    language: '',
    publisher: '',
    description: '',
    identifier: '',
    coverHref: null as string | null
  });

  // 章节编辑
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [chTitle, setChTitle] = useState('');
  const [chHtml, setChHtml] = useState('');
  const [chDirty, setChDirty] = useState(false);
  const [preview, setPreview] = useState(false);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const dragId = useRef<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const [b, cs, imgs, tocTree] = await Promise.all([
        api.getBook(id),
        api.listChapters(id),
        api.images(id),
        api.bookTOC(id),
      ]);
      setBook(b);
      setChapters(cs);
      setImages(imgs);
      setToc(tocTree);
      setForm({
        title: b.title,
        author: b.author,
        language: b.language,
        publisher: b.publisher,
        description: b.description,
        identifier: b.identifier,
        coverHref: b.coverHref
      });
    } catch (e) {
      toastError(e);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function openChapter(cid: string) {
    if (chDirty && !confirm('当前章节有未保存的修改，确定切换吗？')) return;
    setCurrentId(cid);
    setTab('chapter');
    setPreview(false);
    try {
      const s = await api.chapterSource(id, cid);
      setChTitle(s.title);
      setChHtml(s.html);
      setChDirty(false);
    } catch (e) {
      toastError(e);
    }
  }

  async function saveBook() {
    setSaving(true);
    try {
      const b = await api.updateBook(id, form);
      setBook(b);
      toast('书籍信息已保存', 'success');
    } catch (e) {
      toastError(e);
    } finally {
      setSaving(false);
    }
  }

  // Opens the native image picker and uploads the chosen file as the book cover.
  async function pickCover() {
    setUploading(true);
    try {
      const up = await api.uploadCover(id).catch((e) => {
        if (String((e as Error)?.message ?? e).includes('未选择')) return null;
        throw e;
      });
      if (!up) return; // user cancelled the dialog
      const asset: ImageAsset = { href: up.href, size: 0, url: up.url };
      setImages((prev) => [...prev.filter((i) => i.href !== up.href), asset]);
      setForm((f) => ({ ...f, coverHref: up.href }));
      toast('已上传并设为封面', 'success');
    } catch (err) {
      toastError(err);
    } finally {
      setUploading(false);
    }
  }

  async function saveChapter() {
    if (!currentId) return;
    setSaving(true);
    try {
      await api.updateChapter(id, currentId, { title: chTitle, html: chHtml });
      setChDirty(false);
      setChapters(await api.listChapters(id));
      toast('章节已保存', 'success');
    } catch (e) {
      toastError(e);
    } finally {
      setSaving(false);
    }
  }

  async function move(cid: string, delta: number) {
    const list = [...chapters];
    const i = list.findIndex((c) => c.id === cid);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    setChapters(list);
    try {
      setChapters(await api.reorderChapters(id, list.map((c) => c.id)));
    } catch (e) {
      toastError(e);
      void reload();
    }
  }

  async function dropOn(targetId: string) {
    const from = dragId.current;
    dragId.current = null;
    if (!from || from === targetId) return;
    const list = [...chapters];
    const fi = list.findIndex((c) => c.id === from);
    const ti = list.findIndex((c) => c.id === targetId);
    if (fi < 0 || ti < 0) return;
    const [moved] = list.splice(fi, 1);
    list.splice(ti, 0, moved);
    setChapters(list);
    try {
      setChapters(await api.reorderChapters(id, list.map((c) => c.id)));
    } catch (e) {
      toastError(e);
      void reload();
    }
  }

  async function renameChapter(c: Chapter) {
    const t = prompt('章节标题', c.title);
    if (t === null || t.trim() === c.title) return;
    try {
      await api.updateChapter(id, c.id, { title: t.trim() });
      setChapters(await api.listChapters(id));
      if (c.id === currentId) setChTitle(t.trim());
    } catch (e) {
      toastError(e);
    }
  }

  async function removeChapter(c: Chapter) {
    if (!confirm(`从目录中移除「${c.title}」？`)) return;
    try {
      await api.deleteChapter(id, c.id);
      const cs = await api.listChapters(id);
      setChapters(cs);
      if (currentId === c.id) {
        setCurrentId(null);
        setTab('book');
      }
    } catch (e) {
      toastError(e);
    }
  }

  async function addChapter() {
    try {
      const ch = await api.createChapter(id, { title: '新章节', afterChapterId: currentId });
      setChapters(await api.listChapters(id));
      await openChapter(ch.id);
      toast('已新增章节', 'success');
    } catch (e) {
      toastError(e);
    }
  }

  async function mergeSelected() {
    const ordered = chapters.filter((c) => selected.has(c.id));
    if (ordered.length < 2) return;
    if (!confirm(`把后 ${ordered.length - 1} 章的正文合并到「${ordered[0].title}」？被合并的章节会从目录移除。`)) return;
    try {
      const cs = await api.mergeChapters(id, ordered[0].id, ordered.slice(1).map((c) => c.id));
      setChapters(cs);
      setSelected(new Set());
      toast('已合并', 'success');
      if (currentId) await openChapter(ordered[0].id);
    } catch (e) {
      toastError(e);
    }
  }

  const safePreview = useMemo(() => DOMPurify.sanitize(chHtml), [chHtml]);

  async function exportBook() {
    try {
      const { filename, dataUrl } = await api.exportBook(id);
      downloadDataUrl(filename, dataUrl);
    } catch (e) {
      toastError(e);
    }
  }

  if (loading) return <div className="loading">加载中…</div>;
  if (!book) return <div className="page empty">书籍不存在</div>;

  return (
    <div className="page wide">
      <SubHeader title={`整理 · ${book.title}`}>
        <Link className="btn" to={`/books/${id}/read`}>
          阅读
        </Link>
        <Link className="btn" to={`/books/${id}/split`}>
          拆分
        </Link>
        <button className="btn primary" onClick={() => void exportBook()}>
          导出 EPUB
        </button>
      </SubHeader>

      <div className="editor-grid">
        {/* 章节列表 */}
        <div className="pane">
          <div className="section-title">
            目录
            <span className="tag">{chapters.length}</span>
            <span style={{ flex: 1 }} />
            <button className="btn sm" onClick={() => void addChapter()}>
              + 新增
            </button>
          </div>

          {selected.size >= 2 && (
            <div className="toolbar" style={{ marginBottom: 10 }}>
              <span className="muted" style={{ fontSize: 12 }}>
                已选 {selected.size} 章
              </span>
              <button className="btn sm" onClick={() => void mergeSelected()}>
                合并
              </button>
              <button className="btn sm ghost" onClick={() => setSelected(new Set())}>
                取消
              </button>
            </div>
          )}

          <div className="list-scroll">
            {visibleTocItems(tocItems, collapsed).map((it) =>
              it.kind === 'group' ? (
                <div
                  key={it.key}
                  className="hier-group"
                  style={{ paddingLeft: 8 + it.level * 16 }}
                  onClick={() => toggleGroup(it.key)}
                >
                  <button
                    type="button"
                    className="toc-caret"
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleGroup(it.key);
                    }}
                    aria-label={collapsed.has(it.key) ? '展开' : '折叠'}
                  >
                    <Caret open={!collapsed.has(it.key)} />
                  </button>
                  <span className="g-title" title={it.title}>
                    {it.title}
                  </span>
                </div>
              ) : (
                <div
                  key={it.chapter.id}
                  className={`chapter-row${it.chapter.id === currentId ? ' active' : ''}`}
                  style={{ paddingLeft: 8 + it.level * 16 }}
                  draggable
                  onDragStart={() => (dragId.current = it.chapter.id)}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={() => void dropOn(it.chapter.id)}
                  onClick={() => void openChapter(it.chapter.id)}
                >
                  <input
                    type="checkbox"
                    checked={selected.has(it.chapter.id)}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => {
                      const s = new Set(selected);
                      e.target.checked ? s.add(it.chapter.id) : s.delete(it.chapter.id);
                      setSelected(s);
                    }}
                  />
                  <span className="idx">{it.chapter.index + 1}</span>
                  <span className="name" title={it.chapter.title}>
                    {it.chapter.title}
                  </span>
                  <span className="ops" onClick={(e) => e.stopPropagation()}>
                    <button className="icon-btn" title="上移" onClick={() => void move(it.chapter.id, -1)}>
                      ↑
                    </button>
                    <button className="icon-btn" title="下移" onClick={() => void move(it.chapter.id, 1)}>
                      ↓
                    </button>
                    <button className="icon-btn" title="重命名" onClick={() => void renameChapter(it.chapter)}>
                      ✎
                    </button>
                    <button className="icon-btn danger" title="移除" onClick={() => void removeChapter(it.chapter)}>
                      ✕
                    </button>
                  </span>
                </div>
              ),
            )}
            {!chapters.length && <div className="empty">还没有章节</div>}
          </div>
          <div className="muted" style={{ fontSize: 11.5, marginTop: 10 }}>
            提示：可直接拖拽章节调整顺序
          </div>
        </div>

        {/* 右侧 */}
        <div className="pane">
          <div className="tabs">
            <button className={`tab${tab === 'book' ? ' active' : ''}`} onClick={() => setTab('book')}>
              书籍信息
            </button>
            <button
              className={`tab${tab === 'chapter' ? ' active' : ''}`}
              onClick={() => setTab('chapter')}
              disabled={!currentId}
            >
              章节内容{chDirty ? ' •' : ''}
            </button>
          </div>

          {tab === 'book' && (
            <div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 16px' }}>
                <div className="field">
                  <label>书名</label>
                  <input
                    className="input"
                    value={form.title}
                    onChange={(e) => setForm({ ...form, title: e.target.value })}
                  />
                </div>
                <div className="field">
                  <label>作者（多个用「、」分隔）</label>
                  <input
                    className="input"
                    value={form.author}
                    onChange={(e) => setForm({ ...form, author: e.target.value })}
                  />
                </div>
                <div className="field">
                  <label>语言</label>
                  <input
                    className="input"
                    value={form.language}
                    placeholder="zh"
                    onChange={(e) => setForm({ ...form, language: e.target.value })}
                  />
                </div>
                <div className="field">
                  <label>出版方</label>
                  <input
                    className="input"
                    value={form.publisher}
                    onChange={(e) => setForm({ ...form, publisher: e.target.value })}
                  />
                </div>
              </div>
              <div className="field">
                <label>标识符 ISBN / UUID（留空则导出时自动生成）</label>
                <input
                  className="input"
                  value={form.identifier}
                  onChange={(e) => setForm({ ...form, identifier: e.target.value })}
                />
              </div>
              <div className="field">
                <label>简介</label>
                <textarea
                  className="textarea"
                  rows={4}
                  style={{ fontFamily: 'inherit', fontSize: 13 }}
                  value={form.description}
                  onChange={(e) => setForm({ ...form, description: e.target.value })}
                />
              </div>

              <div className="field">
                <label>
                  封面
                  <button
                    className="btn sm"
                    style={{ marginLeft: 8 }}
                    disabled={uploading}
                    onClick={() => void pickCover()}
                  >
                    {uploading ? '上传中…' : '+ 上传外部封面'}
                  </button>
                </label>
                {images.length ? (
                  <div className="cover-picker">
                    <button
                      className={`cover-pick${!form.coverHref ? ' active' : ''}`}
                      onClick={() => setForm({ ...form, coverHref: null })}
                      title="不使用封面"
                      style={{ display: 'grid', placeItems: 'center', fontSize: 11, color: 'var(--text-3)' }}
                    >
                      无
                    </button>
                    {images.map((img) => (
                      <button
                        key={img.href}
                        className={`cover-pick${form.coverHref === img.href ? ' active' : ''}`}
                        onClick={() => setForm({ ...form, coverHref: img.href })}
                        title={img.href}
                      >
                        <img src={img.url} alt="" loading="lazy" />
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className="muted" style={{ fontSize: 12 }}>
                    这本书里没有图片资源，可点击上方「上传外部封面」
                  </div>
                )}
              </div>

              <div className="toolbar">
                <button className="btn primary" disabled={saving} onClick={() => void saveBook()}>
                  {saving ? '保存中…' : '保存书籍信息'}
                </button>
                <button
                  className="btn danger"
                  onClick={async () => {
                    if (!confirm(`删除《${book.title}》？不可恢复。`)) return;
                    await api.deleteBook(id);
                    nav('/');
                  }}
                >
                  删除书籍
                </button>
              </div>
            </div>
          )}

          {tab === 'chapter' &&
            (currentId ? (
              <div>
                <div className="field">
                  <label>章节标题</label>
                  <input
                    className="input"
                    value={chTitle}
                    onChange={(e) => {
                      setChTitle(e.target.value);
                      setChDirty(true);
                    }}
                  />
                </div>
                <div className="toolbar" style={{ marginBottom: 8 }}>
                  <span className="section-title" style={{ margin: 0 }}>
                    正文（HTML 源码）
                  </span>
                  <span style={{ flex: 1 }} />
                  <button className="btn sm" onClick={() => setPreview((p) => !p)}>
                    {preview ? '编辑源码' : '预览'}
                  </button>
                </div>
                {preview ? (
                  <div className="preview-box reader-content" dangerouslySetInnerHTML={{ __html: safePreview }} />
                ) : (
                  <textarea
                    className="textarea"
                    rows={22}
                    value={chHtml}
                    onChange={(e) => {
                      setChHtml(e.target.value);
                      setChDirty(true);
                    }}
                  />
                )}
                <div className="toolbar" style={{ marginTop: 12 }}>
                  <button className="btn primary" disabled={saving || !chDirty} onClick={() => void saveChapter()}>
                    {saving ? '保存中…' : chDirty ? '保存章节' : '已保存'}
                  </button>
                  <Link className="btn" to={`/books/${id}/read/${currentId}`}>
                    在阅读器中查看
                  </Link>
                </div>
              </div>
            ) : (
              <div className="empty">从左侧选择一个章节开始编辑</div>
            ))}
        </div>
      </div>
    </div>
  );
}
