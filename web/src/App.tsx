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
import { initFileDrop } from './filedrop';
import { Toaster } from './toast';

export default function App() {
  const loc = useLocation();
  const isReader = /\/books\/[^/]+\/read/.test(loc.pathname);

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

      <main className="main">
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
