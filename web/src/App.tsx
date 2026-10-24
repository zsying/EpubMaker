import { useEffect } from 'react';
import { Link, Route, Routes, useLocation } from 'react-router-dom';
import Library from './pages/Library';
import Reader from './pages/Reader';
import Editor from './pages/Editor';
import Split from './pages/Split';
import Trash from './pages/Trash';
import WebDav from './pages/WebDav';
import Bookmarks from './pages/Bookmarks';
import Annotations from './pages/Annotations';
import Vocab from './pages/Vocab';
import Me from './pages/Me';
import About from './pages/About';
import Settings from './pages/Settings';
import { initFileDrop } from './filedrop';
import { clearBackClosers } from './backNav';
import { Toaster } from './toast';
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
  useEffect(() => {
    clearBackClosers();
  }, [loc.pathname]);

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
      {!isReader && showTabs && <MobileTabs />}

      <main className={isReader ? 'main' : showTabs ? 'main with-tabs' : 'main'}>
        {isReader ? (
          <Routes>
            <Route path="/books/:id/read" element={<Reader />} />
            <Route path="/books/:id/read/:chapterId" element={<Reader />} />
          </Routes>
        ) : (
          <Routes>
            <Route path="/" element={<Library />} />
            <Route path="/bookmarks" element={<Bookmarks />} />
            <Route path="/annotations" element={<Annotations />} />
            <Route path="/vocab" element={<Vocab />} />
            <Route path="/trash" element={<Trash />} />
            <Route path="/webdav" element={<WebDav />} />
            <Route path="/me" element={<Me />} />
            <Route path="/about" element={<About />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="/books/:id/edit" element={<Editor />} />
            <Route path="/books/:id/split" element={<Split />} />
            <Route path="*" element={<div className="page empty">页面不存在</div>} />
          </Routes>
        )}
      </main>

      <Toaster />
    </div>
  );
}
