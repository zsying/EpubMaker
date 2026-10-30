import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api, OpdsEntry, OpdsFeed, OpdsLink, OpdsSource } from '../api';
import { useBackClose } from '../backNav';
import { toast } from '../toast';
import SubHeader from '../components/SubHeader';

const LS_LAST = 'epubmaker.opds.last';
const LS_CUSTOM = 'epubmaker.opds.custom';

/**
 * Path shapes for the servers people actually self-host. The host is a
 * placeholder on purpose: it is the one part only the reader knows.
 */
const SELF_HOSTED = [
  { name: 'Calibre-Web', url: 'http://192.168.1.10:8083/opds' },
  { name: 'Komga', url: 'http://192.168.1.10:25600/opds/v1.2/catalog' },
  { name: 'Kavita', url: 'http://192.168.1.10:5000/api/opds/你的API密钥' },
  { name: 'COPS', url: 'http://192.168.1.10/cops/index.php/opds' },
];

function errText(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  // The host wraps every failed Go call: "Binding call failed: Bound method
  // returned an error: <what actually went wrong>". Only the tail is the
  // reader's business — "duplicate:西遊記" is not a sentence anyone should see.
  return raw
    .replace(/^Binding call failed:\s*/i, '')
    .replace(/^Bound method returned an error:\s*/i, '')
    .trim();
}

function fmtSize(n: number): string {
  if (!n) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** The EPUB this row would download, or null when the row is not a book. */
function epubLink(e: OpdsEntry) {
  return (e.downloads ?? []).find((d) => /^application\/epub\+zip/i.test(d.type)) ?? null;
}

/** One work, however many files it ships under. */
type Work = { name: string; downloads: OpdsLink[] };

/** The biggest of a row's files: what the confirm line should promise. */
function largest(downloads: OpdsLink[]): number {
  return downloads.reduce((n, d) => Math.max(n, d.length || 0), 0);
}

/** Best-effort file size from the entry's acquisition links. */
function entrySize(e: OpdsEntry): string {
  const epub = epubLink(e);
  return epub ? fmtSize(epub.length) : '';
}

/** How many entries of the history stack lead back to `/opds` (the source
 * picker). It rides in the router state, because the URL cannot know it: the
 * same `?src=…&at=…` is reachable in one step or in five. */
function opsDepth(): number {
  const st = window.history.state as { usr?: { opsDepth?: number } } | null;
  return st?.usr?.opsDepth ?? 0;
}

function historyIdx(): number {
  const st = window.history.state as { idx?: number } | null;
  return st?.idx ?? 0;
}

/**
 * OPDS catalog browser.
 *
 * Every level of the tree is a history entry, not React state. That is the whole
 * point: on Android a hardware back / edge swipe *is* history.back(), so a
 * `useState` stack cannot be walked by it — one swipe threw the reader out of
 * the page and back onto the shelf from any depth. With the catalog position in
 * the URL (`?src=…&at=…&q=…`), the browser's own stack is the navigation stack,
 * and one press is one level; the in-app arrow and the system gesture finally
 * mean the same thing.
 *
 * The shape of a catalog is a tree: a search result usually carries no
 * acquisition link at all, only a link to a per-book page where the files live.
 * So a row either leads somewhere (navHref) or is a book (an EPUB acquisition
 * link) — and the tap means the obvious thing in both cases: a book downloads
 * and imports, a folder opens. There is no second step for a book. It used to
 * need 进入 → 导入 inside, which made the fast path (tap the book you already
 * picked) the slow one, and left folder rows showing a 进入 button for a move
 * the whole row already makes.
 *
 * A row does not always say which it is: Project Gutenberg's search results
 * publish one entry per book with a single `rel="subsection"` link to the book's
 * own page, which is structurally the same thing its category rows carry. So the
 * trailing mark cannot promise "a level": a tap on such a row would download.
 * The download is therefore announced before it starts (`ask`), which is where
 * the reader learns what the tap meant — and gets to say no.
 *
 * Only a row that is a book can be imported. A folder offered 导入 would have to
 * pick a book for the reader out of whatever sorted first.
 */
export default function Opds() {
  const nav = useNavigate();
  const [sp] = useSearchParams();
  const srcURL = sp.get('src') ?? '';
  const at = sp.get('at') ?? '';
  const q = sp.get('q') ?? '';

  const [builtin, setBuiltin] = useState<OpdsSource[]>([]);
  const [custom, setCustom] = useState<OpdsSource[]>([]);
  const [ready, setReady] = useState(false);
  const [feed, setFeed] = useState<OpdsFeed | null>(null);
  const [typed, setTyped] = useState(q);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Rows with work in flight, by row key. Several at once is the point: a fat
   * EPUB must not lock the catalog — the reader starts the next one while it
   * transfers. `check` is still working out what the row is, `get` is
   * transferring. */
  const [busyRows, setBusyRows] = useState<Record<string, 'check' | 'get'>>({});
  /** The same thing as a ref, for the guard that must not wait a paint. */
  const busyRef = useRef<Record<string, true>>({});
  /** A download waiting for the reader's yes. If the trailing › was ambiguous,
   * this is where the row says what it actually does. */
  const [ask, setAsk] = useState<{ key: string; work: Work; size: number } | null>(null);
  const [result, setResult] = useState<{ ok: number; errors: string[]; dups: string[] } | null>(
    null,
  );
  const [showForm, setShowForm] = useState(false);

  // Guards against a slow page landing after a newer one (tapping through a
  // catalog on a phone is faster than the network).
  const reqSeq = useRef(0);

  /** A level that was already fetched while deciding what a tap meant, so
   * opening it does not fetch the same page twice. Keyed by its URL. */
  const prefetched = useRef<{ at: string; feed: OpdsFeed } | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const list = await api.opdsSources();
        setBuiltin(list);
      } catch {
        /* no backend (web-only dev) — the custom form still renders */
      }
      try {
        const raw = localStorage.getItem(LS_CUSTOM);
        if (raw) setCustom(JSON.parse(raw) as OpdsSource[]);
      } catch {
        /* ignore a corrupt entry rather than block the page */
      }
      setReady(true);
    })();
  }, []);

  const allSources = useMemo(() => [...builtin, ...custom], [builtin, custom]);
  const source = useMemo(
    () => allSources.find((s) => s.url === srcURL) ?? null,
    [allSources, srcURL],
  );

  // A source's own page must not be shown while another source is still on
  // screen; the URL is the truth, the feed is only its rendering.
  const lastSrc = useRef('');
  useEffect(() => {
    if (!source) return;
    if (lastSrc.current !== source.url) {
      lastSrc.current = source.url;
      setFeed(null);
      prefetched.current = null;
    }
    // A tap that had to fetch a page to learn whether it was a book or a folder
    // hands that page over here: same request, no second round trip.
    const hit = prefetched.current;
    if (hit && hit.at === at && !q) {
      prefetched.current = null;
      reqSeq.current++;
      setFeed(hit.feed);
      setLoading(false);
      setError(null);
      setResult(null);
      localStorage.setItem(LS_LAST, JSON.stringify(source));
      return;
    }
    prefetched.current = null;
    const seq = ++reqSeq.current;
    setLoading(true);
    setError(null);
    setResult(null);
    void (async () => {
      try {
        const f = await api.opdsBrowse(source, at ? '' : q, at);
        if (seq !== reqSeq.current) return;
        setFeed(f);
        localStorage.setItem(LS_LAST, JSON.stringify(source));
      } catch (e) {
        if (seq !== reqSeq.current) return;
        setError(errText(e));
        setFeed(null);
      } finally {
        if (seq === reqSeq.current) setLoading(false);
      }
    })();
    // `source` is memoised on [allSources, srcURL]; depending on it directly
    // would re-fetch whenever the custom list is re-read.
  }, [source, at, q]);

  // The search box follows the URL, so coming back from a book lands on the
  // query that produced it. Typing does not touch the URL, so this never
  // fights the keyboard.
  useEffect(() => setTyped(q), [q]);

  // The confirm is a layer of its own: back closes it instead of leaving the
  // level — the same rule every other overlay in the app follows.
  useBackClose(!!ask, () => setAsk(null));

  function openSource(src: OpdsSource) {
    nav(`/opds?src=${encodeURIComponent(src.url)}`, { state: { opsDepth: 1 } });
  }

  function pageURL(target: string): string {
    const p = new URLSearchParams({ src: srcURL, at: target });
    if (q) p.set('q', q);
    return `/opds?${p.toString()}`;
  }

  function stepInto(e: OpdsEntry) {
    if (!e.navHref || !source) return;
    nav(pageURL(e.navHref), { state: { opsDepth: opsDepth() + 1 } });
  }

  function search() {
    if (!source) return;
    if (!source.searchUrl?.includes('{search}')) {
      toast('这个书源没有配置搜索地址', 'error');
      return;
    }
    const p = new URLSearchParams({ src: srcURL, q: typed });
    nav(`/opds?${p.toString()}`, { state: { opsDepth: opsDepth() + 1 } });
  }

  /** Paging is a sibling, not a level: it replaces, so ten pages do not become
   * ten presses to get back. */
  function nextPage() {
    if (!source || !feed?.next) return;
    nav(pageURL(feed.next), { replace: true, state: window.history.state?.usr ?? null });
  }

  /** Back to the picker in one move. This is a deliberate exit, not a level, so
   * it rewinds the entries the catalog pushed instead of burying them. */
  function switchSource() {
    const depth = opsDepth();
    if (depth > 0 && historyIdx() >= depth) nav(-depth);
    else nav('/opds', { replace: true });
  }

  /** Marks one row as working, without touching the others: two copies of this
   * page state at once is exactly what makes parallel downloads possible. */
  function mark(key: string, state: 'check' | 'get') {
    busyRef.current[key] = true;
    setBusyRows((prev) => ({ ...prev, [key]: state }));
  }

  /** Frees a row. Other rows keep working: they were never waiting on this one. */
  function done(key: string) {
    delete busyRef.current[key];
    setBusyRows((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }

  /** The reader said yes. The row goes busy only now — until this point nothing
   * was transferred, and the catalog stayed usable. */
  function confirmDownload() {
    if (!ask) return;
    const { key, work } = ask;
    setAsk(null);
    void download(key, work);
  }

  /** What a tap on a row means: a book downloads (after asking), a folder opens.
   *
   * The catch is that a row does not always say which it is. Project Gutenberg
   * publishes its search results as one entry per book with a single
   * `rel="subsection"` link to `/ebooks/<id>.opds` — the book's own page, not a
   * level — so the only honest answer is to look: fetch the target once and ask
   * whether it holds exactly one bookable entry. If it does, that is the book
   * this row stands for and the download is offered now; if it holds anything
   * else it is a level, and the page we already fetched is handed to the view so
   * the tap still costs one request. */
  async function activate(e: OpdsEntry, book: OpdsLink | null) {
    if (!source || busyRef.current[e.id]) return;
    if (book) {
      setAsk({
        key: e.id,
        work: { name: e.title, downloads: e.downloads ?? [] },
        size: book.length,
      });
      return;
    }
    if (!e.navHref) return;
    mark(e.id, 'check');
    try {
      const f = await api.opdsBrowse(source, '', e.navHref);
      const only = f.entries.length === 1 ? f.entries[0] : null;
      if (only && epubLink(only)) {
        const downloads = only.downloads ?? [];
        setAsk({
          key: e.id,
          work: { name: only.title, downloads },
          size: largest(downloads),
        });
        return;
      }
      prefetched.current = { at: e.navHref, feed: f };
      stepInto(e);
    } catch {
      // Not readable as a catalog page (an HTML detail page, a 404). Let the
      // level itself report it, the way it always has.
      stepInto(e);
    } finally {
      done(e.id);
    }
  }

  /** One transfer. Several may run at once: the reader who queued three books
   * should not wait out the first to queue the third. Nothing downstream needs a
   * lock — the temp file name carries a timestamp and a random suffix, and the
   * library is a single SQLite connection with a busy timeout. */
  async function download(key: string, work: Work) {
    if (!source) return;
    mark(key, 'get');
    try {
      const res = await api.opdsImport(source, [{ downloads: work.downloads, name: work.name }]);
      const ok = res.books?.length ?? 0;
      const errors = res.errors ?? [];
      const dups = res.duplicates ?? [];
      // Transfers land in any order; the line counts what this level did, not
      // whichever one finished last.
      setResult((prev) => ({
        ok: (prev?.ok ?? 0) + ok,
        errors: [...(prev?.errors ?? []), ...errors],
        dups: [...(prev?.dups ?? []), ...dups],
      }));
      if (ok > 0) toast(`已下载《${work.name}》`, 'success');
      // A second tap on a book already on the shelf is the reader being unsure
      // whether the first one worked, not a failure.
      else if (dups.length) toast(`${dups.join('、')} 已经在书库里`, 'info', 4000);
      if (errors.length) toast(errors.join('\n'), 'error', 6000);
    } catch (err) {
      toast(errText(err), 'error', 6000);
    } finally {
      done(key);
    }
  }

  function addCustom(form: OpdsSource) {
    if (!form.url.trim()) {
      toast('请填写 OPDS 地址', 'error');
      return;
    }
    const next = [...custom.filter((c) => c.url !== form.url), form];
    setCustom(next);
    localStorage.setItem(LS_CUSTOM, JSON.stringify(next));
    setShowForm(false);
    openSource(form);
  }

  function forget(src: OpdsSource) {
    const next = custom.filter((c) => c.url !== src.url);
    setCustom(next);
    localStorage.setItem(LS_CUSTOM, JSON.stringify(next));
  }

  /* ---------- 未选源：源列表 + 自定义表单 ---------- */
  if (!srcURL || !source) {
    // A deep link to a source that is gone (a deleted custom catalog) is not an
    // error page: the picker is the honest answer.
    return (
      <div className="page" style={{ maxWidth: 720 }}>
        <SubHeader title="在线书库" />
        <p
          className="muted"
          style={{ marginTop: -6, marginBottom: 14, fontSize: 12.5, lineHeight: 1.7 }}
        >
          OPDS 是电子书目录的标准协议，Calibre-Web、Komga、Kavita 和大多数自建书库都支持。
          这里只做「浏览 + 下载导入」，不抓取网页正文。
        </p>

        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          {builtin.map((s) => (
            <div key={s.url} className="opds-src" onClick={() => openSource(s)}>
              <div className="opds-src-main">
                <div className="opds-src-name">{s.name || s.url}</div>
                <div className="opds-src-desc">{s.desc || s.url}</div>
                {/* The address itself, so it can be read out or pasted into
                    another reader. It is the row's identity, not decoration. */}
                <div className="opds-src-url">{s.url}</div>
              </div>
              <span className="opds-chev">›</span>
            </div>
          ))}
          {custom.map((s) => (
            <div key={s.url} className="opds-src" onClick={() => openSource(s)}>
              <div className="opds-src-main">
                <div className="opds-src-name">{s.name || '自定义书库'}</div>
                <div className="opds-src-desc">{s.url}</div>
              </div>
              <button
                className="btn sm ghost"
                onClick={(ev) => {
                  ev.stopPropagation();
                  forget(s);
                }}
              >
                删除
              </button>
              <span className="opds-chev">›</span>
            </div>
          ))}
          {ready && builtin.length === 0 && custom.length === 0 && (
            <div className="empty" style={{ padding: 24 }}>
              <p>还没有可用的书库</p>
            </div>
          )}
        </div>

        {showForm ? (
          <CustomForm onCancel={() => setShowForm(false)} onSubmit={addCustom} />
        ) : (
          <div className="toolbar" style={{ marginTop: 14 }}>
            <button className="btn" onClick={() => setShowForm(true)}>
              添加自定义书库
            </button>
          </div>
        )}

        <div className="muted" style={{ marginTop: 16, fontSize: 12, lineHeight: 1.8 }}>
          内置的都是公版书库：不登录、不付费，但也不会有新书和中文当代作品。 想要自己的藏书，加一台
          Calibre-Web 或任意私有 OPDS 地址即可，凭据只保存在本机。
        </div>
      </div>
    );
  }

  /* ---------- 已选源：目录浏览 ---------- */
  const canSearch = !!source.searchUrl?.includes('{search}');
  return (
    <div className="page">
      <SubHeader
        title={feed?.title || source.name || '目录'}
        tag={at || q ? source.name : undefined}
        hideTagOnPhone
      >
        {/* The bar's arrow is a phone affordance (`.sub-back` is display:none
            above 640px). A desktop reader stepping through a catalog used to
            have this page's own 返回 for that; the level is a history entry now,
            so it is one and the same move, just drawn where the arrow is not. */}
        {at || q ? (
          <button className="btn ghost opds-up" onClick={() => nav(-1)}>
            ← 上一级
          </button>
        ) : null}
        <button className="btn ghost" onClick={switchSource}>
          换源
        </button>
      </SubHeader>

      {canSearch && (
        <div className="opds-search">
          <input
            className="input"
            placeholder="搜索书名或作者"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') search();
            }}
          />
          <button className="btn" disabled={loading} onClick={search}>
            搜索
          </button>
        </div>
      )}

      {error && <div className="wd-error">{error}</div>}

      {result && (
        <div className={`wd-result${result.errors.length ? ' has-fail' : ' ok'}`}>
          <span className="wd-result-msg">
            <ResultLine r={result} />
          </span>
          <span style={{ flex: 1 }} />
          <button className="btn sm ghost" onClick={() => setResult(null)}>
            关闭
          </button>
          {result.errors.length > 0 && (
            <ul className="wd-result-list">
              {result.errors.map((er, i) => (
                <li key={i}>{er}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {loading && !feed ? (
        <div className="loading">加载中…</div>
      ) : !feed || feed.entries.length === 0 ? (
        <div className="empty">
          <p>这里没有内容</p>
        </div>
      ) : (
        <>
          <div className="opds-list">
            {feed.entries.map((e) => {
              const book = epubLink(e);
              const row = !!book || !!e.navHref;
              const state = busyRows[e.id];
              // A row that is only being asked about is not working yet; the
              // row currently transferring is the one that shows it.
              const working = state === 'get' || state === 'check';
              return (
                <div
                  className={`opds-row${row ? ' is-link' : ''}${working ? ' is-busy' : ''}`}
                  key={e.id}
                  onClick={row ? () => void activate(e, book) : undefined}
                  // A row with no file of its own has nothing else to press, so
                  // the row itself is the control — that is also what keeps the
                  // markup honest: no button inside a button. A book row instead
                  // keeps its real button (below) as the accessible action, and
                  // the tap on the row is just a shortcut to the same thing.
                  role={row && !book ? 'button' : undefined}
                  tabIndex={row && !book ? 0 : undefined}
                  onKeyDown={
                    row && !book
                      ? (ev) => {
                          if (ev.key !== 'Enter' && ev.key !== ' ') return;
                          ev.preventDefault();
                          void activate(e, null);
                        }
                      : undefined
                  }
                >
                  <div className={`opds-cover${e.thumbnail ? '' : ' none'}`}>
                    {e.thumbnail && (
                      <img
                        src={e.thumbnail}
                        alt=""
                        loading="lazy"
                        onError={(ev) => {
                          ev.currentTarget.style.display = 'none';
                        }}
                      />
                    )}
                  </div>
                  <div className="opds-info">
                    <div className="opds-title">{e.title}</div>
                    <div className="opds-sub">
                      {[e.author, e.language, entrySize(e)].filter(Boolean).join(' · ')}
                    </div>
                    {e.summary && <div className="opds-summary">{e.summary}</div>}
                  </div>
                  <div className="opds-act">
                    {book ? (
                      <button
                        className="btn sm primary"
                        disabled={state === 'get'}
                        onClick={(ev) => {
                          // The row is a shortcut for this very button; without
                          // this the one tap would ask twice.
                          ev.stopPropagation();
                          void activate(e, book);
                        }}
                      >
                        {state === 'get' ? '下载中…' : '下载'}
                      </button>
                    ) : row ? (
                      // Decoration, not a control: the row is the control. What
                      // it will do is only known after tapping — the 下载 there
                      // is announced by the confirm dialog, not by this mark.
                      // While the row works (identifying, then transferring) the
                      // mark is the only place that can say so.
                      <span className="opds-chev" aria-hidden="true">
                        {state ? '⋯' : '›'}
                      </span>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
          {feed.next && (
            <div className="toolbar" style={{ marginTop: 12, justifyContent: 'center' }}>
              <button className="btn" disabled={loading} onClick={nextPage}>
                {loading ? '加载中…' : '下一页'}
              </button>
            </div>
          )}
        </>
      )}

      {/* The trailing › cannot say whether a row is a book or a folder, and on
          Gutenberg's listings it is a book. Rather than guess in the markup,
          the download announces itself — and can be called off. */}
      {ask && (
        <div className="opds-ask-mask" onClick={() => setAsk(null)}>
          <div
            className="opds-ask"
            role="dialog"
            aria-modal="true"
            aria-label="开始下载"
            onClick={(ev) => ev.stopPropagation()}
          >
            <div className="opds-ask-name">{ask.work.name}</div>
            <div className="opds-ask-sub">
              {ask.size > 0 && <>{fmtSize(ask.size)} · </>}
              下载并加入书架？
            </div>
            <div className="opds-ask-acts">
              <button className="btn ghost" onClick={() => setAsk(null)}>
                取消
              </button>
              <button className="btn primary" onClick={confirmDownload}>
                下载
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** The one-line summary above the catalog, phrased for whatever actually
 * happened: a second tap on a book already on the shelf reads "1 本已在书库",
 * never "已下载 0 本". */
function ResultLine({ r }: { r: { ok: number; errors: string[]; dups: string[] } }) {
  const bits: ReactNode[] = [];
  if (r.ok > 0)
    bits.push(
      <>
        已下载 <b>{r.ok}</b> 本
      </>,
    );
  if (r.dups.length > 0) bits.push(<>{r.dups.length} 本已在书库</>);
  if (r.errors.length > 0)
    bits.push(
      <>
        <b className="wd-fail-count">{r.errors.length}</b> 个失败
      </>,
    );
  if (bits.length === 0) return <>没有变化</>;
  return (
    <>
      {bits.map((b, i) => (
        <Fragment key={i}>
          {i > 0 ? '，' : ''}
          {b}
        </Fragment>
      ))}
    </>
  );
}

function CustomForm({
  onCancel,
  onSubmit,
}: {
  onCancel: () => void;
  onSubmit: (s: OpdsSource) => void;
}) {
  const [form, setForm] = useState<OpdsSource>({ url: '', searchUrl: '' });
  return (
    <div className="card" style={{ padding: 20, marginTop: 14 }}>
      <div className="field">
        <label>目录地址（opds 入口 URL）</label>
        <input
          className="input"
          placeholder="https://example.com/opds"
          value={form.url}
          onChange={(e) => setForm({ ...form, url: e.target.value })}
        />
        {/* The readers who add a source by hand are self-hosting one of four
            servers, and the path is the part they get wrong. Filling it in is
            cheaper than documenting it, and the host stays theirs to edit. */}
        <div className="opds-hints">
          <span className="opds-hints-lead">自建书库路径（点一下填入）：</span>
          {SELF_HOSTED.map((h) => (
            <button
              key={h.name}
              type="button"
              className="opds-hint"
              onClick={() => setForm({ ...form, url: h.url })}
            >
              {h.name}
            </button>
          ))}
        </div>
      </div>
      <div className="field">
        <label>搜索地址（可选，用 {'{search}'} 占位）</label>
        <input
          className="input"
          placeholder="https://example.com/opds/search/{search}"
          value={form.searchUrl}
          onChange={(e) => setForm({ ...form, searchUrl: e.target.value })}
        />
      </div>
      <div className="field">
        <label>用户名（可选）</label>
        <input
          className="input"
          value={form.username ?? ''}
          onChange={(e) => setForm({ ...form, username: e.target.value })}
        />
      </div>
      <div className="field">
        <label>密码（可选）</label>
        <input
          className="input"
          type="password"
          value={form.password ?? ''}
          onChange={(e) => setForm({ ...form, password: e.target.value })}
        />
      </div>
      <label className="wd-check">
        <input
          type="checkbox"
          checked={!!form.insecure}
          onChange={(e) => setForm({ ...form, insecure: e.target.checked })}
        />
        忽略 TLS 证书错误（自签证书 / 内网 HTTPS 用）
      </label>
      <div className="toolbar" style={{ marginTop: 14 }}>
        <button className="btn primary" onClick={() => onSubmit(form)}>
          打开
        </button>
        <button className="btn ghost" onClick={onCancel}>
          取消
        </button>
      </div>
    </div>
  );
}
