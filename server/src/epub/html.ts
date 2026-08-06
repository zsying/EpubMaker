import path from 'node:path';

const P = path.posix;

/** 规范化 EPUB 内部路径：去掉前导斜杠、解析 . 与 .. 、去掉 query/hash */
export function normalizeHref(href: string): string {
  let h = href.split('#')[0].split('?')[0];
  try {
    h = decodeURIComponent(h);
  } catch {
    /* 保持原样 */
  }
  h = h.replace(/\\/g, '/');
  h = P.normalize(h).replace(/^\/+/, '');
  while (h.startsWith('../')) h = h.slice(3);
  return h;
}

/** 以某个文件为基准解析相对路径 */
export function resolveHref(fromFile: string, rel: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(rel) || rel.startsWith('//') || rel.startsWith('#')) return rel;
  const dir = P.dirname(fromFile);
  return normalizeHref(dir === '.' ? rel : P.join(dir, rel));
}

export function encodeHrefForUrl(href: string): string {
  return href.split('/').map(encodeURIComponent).join('/');
}

/** 取出 <body> 内部内容；没有 body 时返回原文 */
export function extractBody(xhtml: string): string {
  const m = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(xhtml);
  return m ? m[1] : xhtml;
}

/** 用新的正文替换原文档的 body 内容，保留 head 等结构 */
export function replaceBody(xhtml: string, inner: string): string {
  if (/<body[^>]*>[\s\S]*?<\/body>/i.test(xhtml)) {
    return xhtml.replace(/(<body[^>]*>)([\s\S]*?)(<\/body>)/i, (_m, a: string, _b: string, c: string) => a + '\n' + inner + '\n' + c);
  }
  return wrapDocument('', inner);
}

export function stripTags(html: string): string {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 从文档中猜测标题：优先 <title>，其次首个 h1~h3 */
export function extractTitle(xhtml: string): string {
  const t = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(xhtml);
  if (t && stripTags(t[1])) return stripTags(t[1]);
  const h = /<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/i.exec(xhtml);
  if (h && stripTags(h[1])) return stripTags(h[1]);
  return '';
}

export function escapeXml(s: string): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** 生成一个标准 XHTML 文档 */
export function wrapDocument(title: string, bodyInner: string, cssHrefs: string[] = []): string {
  const links = cssHrefs.map((h) => `  <link rel="stylesheet" type="text/css" href="${escapeXml(h)}"/>`).join('\n');
  return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head>
  <meta charset="utf-8"/>
  <title>${escapeXml(title)}</title>
${links}
</head>
<body>
${bodyInner}
</body>
</html>
`;
}

const URL_ATTR = /(\s(?:src|href|poster|data)\s*=\s*)(["'])(.*?)\2/gi;

/**
 * 把正文里的相对资源链接改写成可访问的 URL。
 * @param resolver 传入解析后的 EPUB 内部路径，返回可访问的 URL；返回 null 表示删除该链接
 */
export function rewriteResourceUrls(
  html: string,
  fromFile: string,
  resolver: (internalHref: string) => string | null
): string {
  return html.replace(URL_ATTR, (full, prefix: string, quote: string, url: string) => {
    if (!url || /^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith('//') || url.startsWith('#')) return full;
    const target = resolveHref(fromFile, url);
    const mapped = resolver(target);
    if (mapped === null) return full;
    const hash = url.includes('#') ? '#' + url.split('#')[1] : '';
    return `${prefix}${quote}${mapped}${hash}${quote}`;
  });
}

/** 收集正文引用到的所有内部资源路径 */
export function collectReferences(html: string, fromFile: string): string[] {
  const out = new Set<string>();
  let m: RegExpExecArray | null;
  const re = new RegExp(URL_ATTR.source, 'gi');
  while ((m = re.exec(html))) {
    const url = m[3];
    if (!url || /^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith('//') || url.startsWith('#')) continue;
    out.add(resolveHref(fromFile, url));
  }
  // xlink:href (svg image)
  const svg = /xlink:href\s*=\s*["'](.*?)["']/gi;
  while ((m = svg.exec(html))) {
    const url = m[1];
    if (!url || /^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith('#')) continue;
    out.add(resolveHref(fromFile, url));
  }
  return [...out];
}

/** 收集 CSS 中 url(...) 引用 */
export function collectCssReferences(css: string, fromFile: string): string[] {
  const out = new Set<string>();
  const re = /url\(\s*(['"]?)([^)'"]+)\1\s*\)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css))) {
    const url = m[2].trim();
    if (!url || /^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith('//')) continue;
    out.add(resolveHref(fromFile, url));
  }
  return [...out];
}
