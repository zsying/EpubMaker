import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, DictStatus } from '../api';

/**
 * The mobile「我的」tab. The desktop top bar spreads the low-frequency
 * destinations across six links; on a phone they live here as one list, so the
 * bottom bar only needs three tabs for the things that matter daily.
 */
const ENTRIES = [
  { to: '/bookmarks', title: '书签', desc: '按书保存的阅读位置' },
  { to: '/annotations', title: '划线', desc: '高亮与批注' },
  { to: '/trash', title: '回收站', desc: '已删除的书' },
  { to: '/webdav', title: 'WebDAV', desc: '远程书库连接与导入' },
];

export default function Me() {
  const [dict, setDict] = useState<DictStatus | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .dictStatus()
      .then((d) => {
        if (alive) setDict(d);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div className="page me-page">
      <div className="lib-head">
        <h1>我的</h1>
      </div>

      <div className="me-list">
        {ENTRIES.map((e) => (
          <Link key={e.to} className="me-row" to={e.to}>
            <span className="me-row-text">
              <span className="me-row-title">{e.title}</span>
              <span className="me-row-desc">{e.desc}</span>
            </span>
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
              <path d="M5 3 L10 7 L5 11" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </Link>
        ))}
      </div>

      <div className="me-dict">
        <span>查词词库</span>
        <span className={dict?.installed ? 'tag' : 'tag muted-tag'}>
          {dict?.installed ? `已安装 · ${dict.entries} 条` : '未安装（手机暂不支持导入）'}
        </span>
      </div>
    </div>
  );
}
