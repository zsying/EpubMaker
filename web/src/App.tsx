import { useEffect } from 'react';
import { Link, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import Library from './pages/Library';
import Reader from './pages/Reader';
import Editor from './pages/Editor';
import Split from './pages/Split';
import Trash from './pages/Trash';
import WebDav from './pages/WebDav';
import Bookmarks from './pages/Bookmarks';
import Annotations from './pages/Annotations';
import Vocab from './pages/Vocab';
import Review from './pages/Review';
import LookupHistory from './pages/LookupHistory';
import Me from './pages/Me';
import About from './pages/About';
import WifiShare from './pages/WifiShare';
import Settings from './pages/Settings';
import Logs from './pages/Logs';
import { initFileDrop } from './filedrop';
import { clearBackClosers } from './backNav';
import { api, onSharedImport } from './api';
import { toast, toastError, Toaster } from './toast';
import MobileTabs from './components/MobileTabs';

export default function App() {
  const loc = useLocation();
  const isReader = /\/books\/[^/]+\/read/.test(loc.pathname);
  // The bottom tab bar belongs to the three top-level destinations only;
  // second-level pages (设置/书签/回收站/…) are stacked on top of them and
  // carry their own back header instead.
  const showTabs = ['/', '/vocab', '/me'].includes(loc.pathname);

  // Overlay closers are page-scoped: once the route changes, a closer left by
  // the previous page must never eat a back press on the new one.
  //
  // Every route change is also written to the diagnostic log. When a back
  // gesture lands somewhere unexpected, the sequence of paths is the only
  // evidence of how the reader got there — the WebView keeps no history dump.
  useEffect(() => {
    clearBackClosers();
    void api.logClient('info', 'nav', loc.pathname + loc.search, '').catch(() => {});
  }, [loc.pathname, loc.search]);

  // A book shared to EpubMaker from another app (WeChat, browser, file
  // manager) arrives as a copied cache path. Import it wherever the user
  // happens to be, then tell the shelf to refresh if it is watching.
  useEffect(() => {
    let alive = true;
    let off: (() => void) | null = null;
    onSharedImport((path) => {
      api
        .importPaths([path])
        .then((res) => {
          const n = res.books.length;
          const dups = res.duplicates?.length ?? 0;
          if (n > 0) toast(`已导入《${res.books[0].title}》`, 'success');
          else if (dups > 0) toast(res.duplicates![0], 'info');
          else toastError(res.errors?.[0] ?? '导入失败');
          window.dispatchEvent(new CustomEvent('epubmaker:imported'));
        })
        .catch((e) => toastError(e));
    }).then((unsub) => {
      if (alive) off = unsub;
      else unsub();
    });
    return () => {
      alive = false;
      off?.();
    };
  }, []);

  // The drop bridge is registered here rather than on the shelf: it is what
  // stops the webview from navigating to a dropped file, and a delayed
  // registration would leave one drop with the old, destructive behaviour.
  useEffect(() => {
    initFileDrop();
  }, []);

  return (
    <div className="app">
      {!isReader && (
        <header className="topbar">
          <Link to="/" className="brand">
            <span className="brand-mark">E</span>
            <span>EpubMaker</span>
          </Link>
          <span className="spacer" />
          <Link to="/" className="btn ghost">
            书架
          </Link>
          <Link to="/bookmarks" className="btn ghost">
            书签
          </Link>
          <Link to="/annotations" className="btn ghost">
            划线
          </Link>
          <Link to="/vocab" className="btn ghost">
            生词本
          </Link>
          <Link to="/webdav" className="btn ghost">
            WebDAV
          </Link>
        </header>
      )}

      {/* The phone navigates from the bottom (tabbar); the desktop keeps the
          top bar. CSS picks which one is visible per breakpoint. The reader is
          its own fullscreen surface and never shows tabs. */}
      <main className="main">
        {isReader ? (
          <Routes>
            <Route path="/books/:id/read" element={<Reader />} />
            <Route path="/books/:id/read/:chapterId" element={<Reader />} />
            {/* A reader URL that no longer matches must still land somewhere:
                an empty <Routes> renders nothing at all, which on the reader's
                dark background is the "black screen, nothing responds" state. */}
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        ) : (
          <Routes>
            <Route path="/" element={<Library />} />
            <Route path="/bookmarks" element={<Bookmarks />} />
            <Route path="/annotations" element={<Annotations />} />
            <Route path="/vocab" element={<Vocab />} />
            <Route path="/vocab/history" element={<LookupHistory />} />
            <Route path="/vocab/review" element={<Review />} />
            <Route path="/trash" element={<Trash />} />
            <Route path="/webdav" element={<WebDav />} />
            <Route path="/me" element={<Me />} />
            <Route path="/about" element={<About />} />
            <Route path="/wifi" element={<WifiShare />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="/logs" element={<Logs />} />
            <Route path="/books/:id/edit" element={<Editor />} />
            <Route path="/books/:id/split" element={<Split />} />
            <Route path="*" element={<div className="page empty">页面不存在</div>} />
          </Routes>
        )}
      </main>

      {!isReader && showTabs && <MobileTabs />}

      <Toaster />
    </div>
  );
}
