import JSZip from 'jszip';
import { Readable } from 'node:stream';
import { guessMediaType } from './mime';
import { encodeHrefForUrl, escapeXml } from './html';

export interface BuildChapter {
  title: string;
  href: string;
  content: Buffer | string;
}

export interface BuildAsset {
  href: string;
  mediaType?: string;
  /** Buffer / 字符串 / 可读流（大图片建议传流，导出时不必整块载入内存） */
  content: Buffer | string | Readable;
}

export interface BuildInput {
  title: string;
  author: string;
  language: string;
  publisher?: string;
  description?: string;
  identifier?: string;
  coverHref?: string | null;
  chapters: BuildChapter[];
  assets: BuildAsset[];
}

const OPF_NAME = 'epubmaker.opf';
const NAV_NAME = 'epubmaker-nav.xhtml';
const NCX_NAME = 'epubmaker-toc.ncx';

function makeIds(hrefs: string[]): Map<string, string> {
  const map = new Map<string, string>();
  const used = new Set<string>();
  hrefs.forEach((href, i) => {
    let base = 'id_' + href.replace(/[^A-Za-z0-9_]/g, '_').replace(/_+/g, '_');
    if (base.length > 60) base = base.slice(-60);
    let id = base;
    let n = 1;
    while (used.has(id)) id = `${base}_${n++}`;
    used.add(id);
    map.set(href, id);
  });
  return map;
}

function buildNav(input: BuildInput): string {
  const items = input.chapters
    .map((c) => `      <li><a href="${escapeXml(encodeHrefForUrl(c.href))}">${escapeXml(c.title || '未命名章节')}</a></li>`)
    .join('\n');
  return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="${escapeXml(input.language)}" xml:lang="${escapeXml(input.language)}">
<head>
  <meta charset="utf-8"/>
  <title>目录</title>
</head>
<body>
  <nav epub:type="toc" id="toc">
    <h1>目录</h1>
    <ol>
${items}
    </ol>
  </nav>
</body>
</html>
`;
}

function buildNcx(input: BuildInput, uid: string): string {
  const points = input.chapters
    .map(
      (c, i) => `    <navPoint id="navPoint-${i + 1}" playOrder="${i + 1}">
      <navLabel><text>${escapeXml(c.title || '未命名章节')}</text></navLabel>
      <content src="${escapeXml(encodeHrefForUrl(c.href))}"/>
    </navPoint>`
    )
    .join('\n');
  return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE ncx PUBLIC "-//NISO//DTD ncx 2005-1//EN" "http://www.daisy.org/z3986/2005/ncx-2005-1.dtd">
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head>
    <meta name="dtb:uid" content="${escapeXml(uid)}"/>
    <meta name="dtb:depth" content="1"/>
    <meta name="dtb:totalPageCount" content="0"/>
    <meta name="dtb:maxPageNumber" content="0"/>
  </head>
  <docTitle><text>${escapeXml(input.title)}</text></docTitle>
  <navMap>
${points}
  </navMap>
</ncx>
`;
}

function buildOpf(input: BuildInput, uid: string, ids: Map<string, string>): string {
  const modified = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

  const manifestLines: string[] = [
    `    <item id="nav" href="${NAV_NAME}" media-type="application/xhtml+xml" properties="nav"/>`,
    `    <item id="ncx" href="${NCX_NAME}" media-type="application/x-dtbncx+xml"/>`
  ];

  for (const c of input.chapters) {
    manifestLines.push(
      `    <item id="${ids.get(c.href)}" href="${escapeXml(encodeHrefForUrl(c.href))}" media-type="application/xhtml+xml"/>`
    );
  }
  for (const a of input.assets) {
    const props = input.coverHref && a.href === input.coverHref ? ' properties="cover-image"' : '';
    manifestLines.push(
      `    <item id="${ids.get(a.href)}" href="${escapeXml(encodeHrefForUrl(a.href))}" media-type="${escapeXml(
        a.mediaType || guessMediaType(a.href)
      )}"${props}/>`
    );
  }

  const spineLines = input.chapters.map((c) => `    <itemref idref="${ids.get(c.href)}"/>`);

  const coverMeta =
    input.coverHref && ids.get(input.coverHref)
      ? `    <meta name="cover" content="${ids.get(input.coverHref)}"/>\n`
      : '';

  const authors = (input.author || '')
    .split(/[、,;；]/)
    .map((s) => s.trim())
    .filter(Boolean);
  const creatorLines = authors.length
    ? authors.map((a, i) => `    <dc:creator id="creator${i + 1}">${escapeXml(a)}</dc:creator>`).join('\n') + '\n'
    : '';

  return `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" xml:lang="${escapeXml(
    input.language
  )}">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">${escapeXml(uid)}</dc:identifier>
    <dc:title>${escapeXml(input.title)}</dc:title>
    <dc:language>${escapeXml(input.language || 'zh')}</dc:language>
${creatorLines}${input.publisher ? `    <dc:publisher>${escapeXml(input.publisher)}</dc:publisher>\n` : ''}${
    input.description ? `    <dc:description>${escapeXml(input.description)}</dc:description>\n` : ''
  }    <meta property="dcterms:modified">${modified}</meta>
${coverMeta}    <meta name="generator" content="EpubMaker"/>
  </metadata>
  <manifest>
${manifestLines.join('\n')}
  </manifest>
  <spine toc="ncx">
${spineLines.join('\n')}
  </spine>
</package>
`;
}

export function buildEpub(input: BuildInput): Readable {
  const zip = new JSZip();
  // mimetype 必须是第一个条目且不压缩
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  zip.file(
    'META-INF/container.xml',
    `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="${OPF_NAME}" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
`
  );

  const uid = input.identifier && input.identifier.trim() ? input.identifier.trim() : `urn:uuid:${crypto.randomUUID()}`;
  const ids = makeIds([...input.chapters.map((c) => c.href), ...input.assets.map((a) => a.href)]);

  for (const c of input.chapters) zip.file(c.href, c.content);
  for (const a of input.assets) zip.file(a.href, a.content);

  zip.file(NAV_NAME, buildNav(input));
  zip.file(NCX_NAME, buildNcx({ ...input, identifier: uid }, uid));
  zip.file(OPF_NAME, buildOpf(input, uid, ids));

  // streamFiles: true —— 边生成边写出，整本书不必在内存中拼成完整 Buffer
  return zip.generateNodeStream({
    type: 'nodebuffer',
    streamFiles: true,
    compression: 'DEFLATE',
    compressionOptions: { level: 6 }
  }) as unknown as Readable;
}
