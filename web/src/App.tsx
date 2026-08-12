import { Link, Route, Routes, useLocation } from 'react-router-dom';
import Library from './pages/Library';
import Reader from './pages/Reader';
import Editor from './pages/Editor';
import Split from './pages/Split';
import Trash from './pages/Trash';
import WebDav from './pages/WebDav';
import { Toaster } from './toast';

export default function App() {
  const loc = useLocation();
  const isReader = /\/books\/[^/]+\/read/.test(loc.pathname);

  return (
    <div className="app">
      <header className="topbar">
        <Link to="/" className="brand">
          <span className="brand-mark">E</span>
          <span>EpubMaker</span>
        </Link>
        <span className="spacer" />
        <Link to="/" className="btn ghost">
          书架
        </Link>
        <Link to="/webdav" className="btn ghost">
          WebDAV
        </Link>
      </header>

      {isReader ? (
        <Routes>
          <Route path="/books/:id/read" element={<Reader />} />
          <Route path="/books/:id/read/:chapterId" element={<Reader />} />
        </Routes>
      ) : (
        <Routes>
          <Route path="/" element={<Library />} />
          <Route path="/trash" element={<Trash />} />
          <Route path="/webdav" element={<WebDav />} />
          <Route path="/books/:id/edit" element={<Editor />} />
          <Route path="/books/:id/split" element={<Split />} />
          <Route path="*" element={<div className="page empty">页面不存在</div>} />
        </Routes>
      )}

      <Toaster />
    </div>
  );
}
