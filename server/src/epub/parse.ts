import JSZip from 'jszip';
import { XMLParser } from 'fast-xml-parser';
import { guessMediaType, isDocument } from './mime';
import { normalizeHref, resolveHref, stripTags } from './html';

export interface ManifestItem {
  id: string;
  href: string; // 相对于 zip 根的完整路径
  mediaType: string;
  properties: string;
}

export interface ParsedEpub {
  metadata: {
    title: string;
    author: string;
    language: string;
    publisher: string;
    description: string;
    identifier: string;
  };
  opfPath: string;
  /** 阅读顺序中的正文文档 */
  spine: ManifestItem[];
  /** 除正文、opf、ncx、nav 之外的资源 */
  resources: ManifestItem[];
  /** href -> 章节标题 */
  toc: Record<string, string>;
  coverHref: string | null;
  /** zip 内全部文件条目（不含 mimetype / META-INF / opf / ncx），key 为规范化路径 */
  entries: Map<string, JSZip.JSZipObject>;
}

/** 解压读取某个 zip 条目为 Buffer（按需调用，避免一次性把整本书的资源载入内存） */
export async function readEntry(entry: JSZip.JSZipObject): Promise<Buffer> {
  return Buffer.from(await entry.async('nodebuffer'));
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
  trimValues: true,
  parseAttributeValue: false,
  parseTagValue: false
});

function toArray<T>(v: T | T[] | undefined | null): T[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

function textOf(v: unknown): string {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return textOf(v[0]);
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if ('#text' in o) return textOf(o['#text']);
  }
  return '';
}

function findEntry(zip: JSZip, name: string): JSZip.JSZipObject | null {
  const direct = zip.file(name);
  if (direct) return direct;
  let decoded = name;
  try {
    decoded = decodeURIComponent(name);
  } catch {
    /* ignore */
  }
  if (decoded !== name) {
    const d = zip.file(decoded);
    if (d) return d;
  }
  const lower = decoded.toLowerCase();
  for (const key of Object.keys(zip.files)) {
    if (zip.files[key].dir) continue;
    let k = key;
    try {
      k = decodeURIComponent(key);
    } catch {
      /* ignore */
    }
    if (k.toLowerCase() === lower || key.toLowerCase() === lower) return zip.files[key];
  }
  return null;
}

/** 解析 NCX 目录：<text>标题</text> ... <content src="xxx"/> */
function parseNcx(xml: string, ncxPath: string): Record<string, string> {
  const map: Record<string, string> = {};
  const re = /<text[^>]*>([\s\S]*?)<\/text>[\s\S]*?<content[^>]*src\s*=\s*["']([^"']+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const title = stripTags(m[1]);
    const href = resolveHref(ncxPath, m[2]);
    if (title && href && !map[href]) map[href] = title;
  }
  return map;
}

/** 解析 EPUB3 nav.xhtml 目录 */
function parseNav(xml: string, navPath: string): Record<string, string> {
  const map: Record<string, string> = {};
  const re = /<a\s[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const href = resolveHref(navPath, m[1]);
    const title = stripTags(m[2]);
    if (title && href && !map[href]) map[href] = title;
  }
  return map;
}

export async function parseEpub(data: Buffer): Promise<ParsedEpub> {
  const zip = await JSZip.loadAsync(data);

  // 1. container.xml -> opf 路径
  const containerEntry = findEntry(zip, 'META-INF/container.xml');
  let opfPath = '';
  if (containerEntry) {
    const containerXml = await containerEntry.async('string');
    const c = parser.parse(containerXml);
    const rootfile = toArray(c?.container?.rootfiles?.rootfile)[0] as Record<string, string> | undefined;
    opfPath = normalizeHref(rootfile?.['@_full-path'] ?? '');
  }
  if (!opfPath) {
    const guess = Object.keys(zip.files).find((k) => k.toLowerCase().endsWith('.opf'));
    if (!guess) throw new Error('不是有效的 EPUB：找不到 OPF 文件');
    opfPath = normalizeHref(guess);
  }

  const opfEntry = findEntry(zip, opfPath);
  if (!opfEntry) throw new Error(`不是有效的 EPUB：OPF 文件缺失 (${opfPath})`);
  const opfXml = await opfEntry.async('string');
  const pkg = parser.parse(opfXml)?.package;
  if (!pkg) throw new Error('OPF 解析失败');

  // 2. 元数据
  const meta = pkg.metadata ?? {};
  const metaTags = toArray<Record<string, string>>(meta.meta);
  const metadata = {
    title: textOf(meta.title) || '未命名书籍',
    author: toArray(meta.creator).map(textOf).filter(Boolean).join('、'),
    language: textOf(meta.language) || 'zh',
    publisher: textOf(meta.publisher),
    description: stripTags(textOf(meta.description)),
    identifier: toArray(meta.identifier).map(textOf).find(Boolean) ?? ''
  };

  // 3. manifest
  const items: ManifestItem[] = toArray<Record<string, string>>(pkg.manifest?.item).map((it) => ({
    id: it['@_id'] ?? '',
    href: resolveHref(opfPath, it['@_href'] ?? ''),
    mediaType: it['@_media-type'] || guessMediaType(it['@_href'] ?? ''),
    properties: it['@_properties'] ?? ''
  }));
  const byId = new Map(items.map((i) => [i.id, i]));

  // 4. spine
  const itemrefs = toArray<Record<string, string>>(pkg.spine?.itemref);
  const navItem = items.find((i) => i.properties.split(/\s+/).includes('nav'));
  const ncxId = pkg.spine?.['@_toc'] as string | undefined;
  const ncxItem =
    (ncxId ? byId.get(ncxId) : undefined) ?? items.find((i) => i.mediaType === 'application/x-dtbncx+xml');

  const spine: ManifestItem[] = [];
  for (const ref of itemrefs) {
    const item = byId.get(ref['@_idref'] ?? '');
    if (!item) continue;
    if (!isDocument(item.mediaType)) continue;
    if (navItem && item.href === navItem.href) continue; // 目录页不作为章节
    spine.push(item);
  }
  // 某些残缺 epub 没有 spine，退化为按 manifest 顺序取所有文档
  if (spine.length === 0) {
    for (const item of items) {
      if (isDocument(item.mediaType) && (!navItem || item.href !== navItem.href)) spine.push(item);
    }
  }

  // 5. 目录标题
  let toc: Record<string, string> = {};
  if (navItem) {
    const e = findEntry(zip, navItem.href);
    if (e) toc = { ...parseNav(await e.async('string'), navItem.href), ...toc };
  }
  if (ncxItem) {
    const e = findEntry(zip, ncxItem.href);
    if (e) toc = { ...parseNcx(await e.async('string'), ncxItem.href), ...toc };
  }

  // 6. 封面
  let coverHref: string | null = null;
  const coverProp = items.find((i) => i.properties.split(/\s+/).includes('cover-image'));
  if (coverProp) coverHref = coverProp.href;
  if (!coverHref) {
    const metaCover = metaTags.find((m) => (m['@_name'] ?? '').toLowerCase() === 'cover');
    const target = metaCover ? byId.get(metaCover['@_content'] ?? '') : undefined;
    if (target && target.mediaType.startsWith('image/')) coverHref = target.href;
  }
  if (!coverHref) {
    const guess = items.find((i) => i.mediaType.startsWith('image/') && /cover/i.test(i.href));
    if (guess) coverHref = guess.href;
  }

  // 7. 读取所有文件内容
  const skip = new Set<string>([opfPath]);
  if (ncxItem) skip.add(ncxItem.href);
  if (navItem) skip.add(navItem.href);

  const entries = new Map<string, JSZip.JSZipObject>();
  for (const key of Object.keys(zip.files)) {
    const entry = zip.files[key];
    if (entry.dir) continue;
    const norm = normalizeHref(key);
    if (!norm || norm === 'mimetype' || norm.startsWith('META-INF/')) continue;
    if (skip.has(norm)) continue;
    if (norm.toLowerCase().endsWith('.opf') || norm.toLowerCase().endsWith('.ncx')) continue;
    entries.set(norm, entry);
  }

  const spineHrefs = new Set(spine.map((s) => s.href));
  const resources = items.filter(
    (i) => !spineHrefs.has(i.href) && !skip.has(i.href) && entries.has(i.href)
  );
  // manifest 里没登记但 zip 里存在的文件也一并保留为资源
  for (const [href] of entries) {
    if (spineHrefs.has(href)) continue;
    if (resources.some((r) => r.href === href)) continue;
    resources.push({ id: '', href, mediaType: guessMediaType(href), properties: '' });
  }

  return { metadata, opfPath, spine, resources, toc, coverHref, entries };
}
