/**
 * 端到端冒烟测试。
 * 在系统临时目录里新建一个隔离的 APP_HOME，启动 server/dist，
 * 跑一遍「造样例 EPUB → 导入 → 阅读 → 整理 → 拆分 → 导出 → 回环导入 → 删除」，
 * 全程不碰 ~/.epubmaker 里的真实数据。
 *
 * 用法：npm run build && npm run test:e2e
 */
import JSZip from 'jszip';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const TMP_HOME = path.join(os.tmpdir(), 'epubmaker-e2e-' + Date.now());
const PORT = 7899;
const BASE = `http://127.0.0.1:${PORT}`;
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

let failures = 0;
function check(name, cond, extra = '') {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name} ${extra}`);
  }
}

async function makeSampleEpub() {
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  zip.file(
    'META-INF/container.xml',
    `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`
  );
  const chapters = [];
  for (let i = 1; i <= 6; i++) {
    const extra = i === 2 ? `<p><img src="../images/pic.png" alt="插图"/></p>` : '';
    chapters.push({ id: `ch${i}`, href: `text/chapter${i}.xhtml`, title: `第 ${i} 章 · 测试章节` });
    zip.file(
      `OEBPS/text/chapter${i}.xhtml`,
      `<?xml version="1.0" encoding="utf-8"?><!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml"><head><meta charset="utf-8"/><title>第 ${i} 章 · 测试章节</title><link rel="stylesheet" href="../styles/main.css"/></head>
<body><h2>第 ${i} 章 · 测试章节</h2><p>这是第 ${i} 章的正文内容，用于端到端验证。</p>${extra}</body></html>`
    );
  }
  zip.file('OEBPS/styles/main.css', 'body{line-height:1.8} h2{color:#333}');
  zip.file('OEBPS/images/cover.png', PNG);
  zip.file('OEBPS/images/pic.png', PNG);
  zip.file(
    'OEBPS/nav.xhtml',
    `<?xml version="1.0" encoding="utf-8"?><!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>目录</title></head><body><nav epub:type="toc"><ol>${chapters
      .map((c) => `<li><a href="${c.href}">${c.title}</a></li>`)
      .join('')}</ol></nav></body></html>`
  );
  zip.file(
    'OEBPS/toc.ncx',
    `<?xml version="1.0" encoding="utf-8"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><head/><docTitle><text>端到端测试书</text></docTitle><navMap>${chapters
      .map(
        (c, i) =>
          `<navPoint id="np${i}" playOrder="${i + 1}"><navLabel><text>${c.title}</text></navLabel><content src="${c.href}"/></navPoint>`
      )
      .join('')}</navMap></ncx>`
  );
  zip.file(
    'OEBPS/content.opf',
    `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">urn:uuid:e2e-test-0001</dc:identifier>
    <dc:title>端到端测试书</dc:title>
    <dc:creator>测试作者</dc:creator>
    <dc:language>zh</dc:language>
    <dc:publisher>测试出版社</dc:publisher>
    <dc:description>一本用于验证导入导出的样例书。</dc:description>
    <meta name="cover" content="cover-img"/>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="css" href="styles/main.css" media-type="text/css"/>
    <item id="cover-img" href="images/cover.png" media-type="image/png"/>
    <item id="pic" href="images/pic.png" media-type="image/png"/>
    ${chapters.map((c) => `<item id="${c.id}" href="${c.href}" media-type="application/xhtml+xml"/>`).join('\n    ')}
  </manifest>
  <spine toc="ncx">
    ${chapters.map((c) => `<itemref idref="${c.id}"/>`).join('\n    ')}
  </spine>
</package>`
  );
  return zip.generateAsync({ type: 'nodebuffer' });
}

async function waitHealth(ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

const j = async (res) => {
  const body = await res.json();
  if (!body.ok) throw new Error(body.error || 'API error');
  return body.data;
};

(async () => {
  fs.mkdirSync(TMP_HOME, { recursive: true });
  console.log('临时 APP_HOME =', TMP_HOME);

  const srv = spawn(process.execPath, ['server/dist/index.js'], {
    cwd: process.cwd(),
    env: { ...process.env, EPUBMAKER_HOME: TMP_HOME, EPUBMAKER_PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let srvLog = '';
  srv.stdout.on('data', (d) => (srvLog += d));
  srv.stderr.on('data', (d) => (srvLog += d));

  try {
    if (!(await waitHealth())) throw new Error('服务未启动:\n' + srvLog);
    console.log('\n[1] 服务启动');
    check('health 可用', true);
    const cfg = await j(await fetch(`${BASE}/api/config`));
    check('config.json 已生成', fs.existsSync(cfg.configFile), cfg.configFile);
    check('数据/导出/日志目录已创建', fs.existsSync(cfg.dataDir) && fs.existsSync(cfg.exportDir) && fs.existsSync(cfg.logDir));

    console.log('\n[2] 导入 EPUB');
    const epub = await makeSampleEpub();
    fs.writeFileSync(path.join(TMP_HOME, 'sample.epub'), epub);
    const fd = new FormData();
    fd.append('files', new Blob([epub], { type: 'application/epub+zip' }), 'sample.epub');
    const imported = await j(await fetch(`${BASE}/api/books/import`, { method: 'POST', body: fd }));
    const book = imported.books[0];
    check('导入成功', !!book);
    check('书名解析正确', book.title === '端到端测试书', book.title);
    check('作者解析正确', book.author === '测试作者', book.author);
    check('章节数为 6（nav 未混入）', book.chapterCount === 6, String(book.chapterCount));
    check('封面识别成功', book.coverHref === 'OEBPS/images/cover.png', String(book.coverHref));

    console.log('\n[3] 阅读');
    const chapters = await j(await fetch(`${BASE}/api/books/${book.id}/chapters`));
    check('目录标题来自 nav/ncx', chapters[0].title === '第 1 章 · 测试章节', chapters[0].title);
    const r2 = await j(await fetch(`${BASE}/api/books/${book.id}/chapters/${chapters[1].id}/render`));
    check('正文渲染包含文本', r2.html.includes('第 2 章的正文内容'));
    check(
      '图片链接已改写为 API 路径',
      r2.html.includes(`/api/books/${book.id}/assets/OEBPS/images/pic.png`),
      r2.html.slice(0, 200)
    );
    const img = await fetch(`${BASE}/api/books/${book.id}/assets/OEBPS/images/pic.png`);
    check('图片资源可访问', img.ok && img.headers.get('content-type') === 'image/png');
    const cover = await fetch(`${BASE}${book.coverUrl}`);
    check('封面可访问', cover.ok);

    console.log('\n[4] 整理');
    const updated = await j(
      await fetch(`${BASE}/api/books/${book.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: '改名后的书', author: '张三、李四' })
      })
    );
    check('书籍元数据修改成功', updated.title === '改名后的书' && updated.author === '张三、李四');

    await j(
      await fetch(`${BASE}/api/books/${book.id}/chapters/${chapters[0].id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: '序章', html: '<h2>序章</h2><p>被改写的正文。</p>' })
      })
    );
    const src = await j(await fetch(`${BASE}/api/books/${book.id}/chapters/${chapters[0].id}/source`));
    check('章节标题与正文修改成功', src.title === '序章' && src.html.includes('被改写的正文'));

    const reordered = await j(
      await fetch(`${BASE}/api/books/${book.id}/chapters/reorder`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chapterIds: [...chapters].reverse().map((c) => c.id) })
      })
    );
    check('章节重排成功', reordered[0].id === chapters[5].id);
    // 排回原顺序
    await j(
      await fetch(`${BASE}/api/books/${book.id}/chapters/reorder`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chapterIds: chapters.map((c) => c.id) })
      })
    );

    const newCh = await j(
      await fetch(`${BASE}/api/books/${book.id}/chapters`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: '附录', html: '<p>附录内容</p>' })
      })
    );
    check('新增章节成功', newCh.title === '附录');
    await fetch(`${BASE}/api/books/${book.id}/chapters/${newCh.id}`, { method: 'DELETE' });
    check('删除章节成功', (await j(await fetch(`${BASE}/api/books/${book.id}/chapters`))).length === 6);

    console.log('\n[5] 拆分');
    const created = await j(
      await fetch(`${BASE}/api/books/${book.id}/split`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          parts: [
            { title: '上卷', author: '张三', chapterIds: chapters.slice(0, 3).map((c) => c.id) },
            { title: '下卷', author: '李四', chapterIds: chapters.slice(3).map((c) => c.id) }
          ],
          deleteSource: false
        })
      })
    );
    check('生成 2 本新书', created.length === 2, String(created.length));
    check('上卷 3 章 / 下卷 3 章', created[0].chapterCount === 3 && created[1].chapterCount === 3);
    const lowerImgs = await j(await fetch(`${BASE}/api/books/${created[1].id}/images`));
    check('下卷未携带无关图片（仅封面）', lowerImgs.length <= 2, JSON.stringify(lowerImgs.map((i) => i.href)));
    const upperImgs = await j(await fetch(`${BASE}/api/books/${created[0].id}/images`));
    check(
      '上卷携带了第 2 章引用的插图',
      upperImgs.some((i) => i.href.endsWith('pic.png')),
      JSON.stringify(upperImgs.map((i) => i.href))
    );

    console.log('\n[5b] 拆分封面选择（原书图 / 上传新图 / 不用封面）');
    const imgsList = await j(await fetch(`${BASE}/api/books/${book.id}/images`));
    check(
      '图片列表含 cover.png 与 pic.png',
      imgsList.some((i) => i.href.endsWith('cover.png')) && imgsList.some((i) => i.href.endsWith('pic.png')),
      JSON.stringify(imgsList.map((i) => i.href))
    );

    // 上传一张新封面
    const fd3 = new FormData();
    fd3.append('cover', new Blob([PNG], { type: 'image/png' }), 'newcover.png');
    const up = await j(await fetch(`${BASE}/api/books/${book.id}/covers`, { method: 'POST', body: fd3 }));
    check('封面上传成功', !!up.href && up.href.startsWith('epubmaker/covers/'), up.href);
    const coverImgsAfter = await j(await fetch(`${BASE}/api/books/${book.id}/images`));
    check('上传封面进入图片列表', coverImgsAfter.some((i) => i.href === up.href));

    const coverSplit = await j(
      await fetch(`${BASE}/api/books/${book.id}/split`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          parts: [
            {
              title: '封面A',
              author: '张三',
              chapterIds: [chapters[0].id, chapters[1].id],
              coverHref: 'OEBPS/images/cover.png'
            },
            { title: '封面B', author: '李四', chapterIds: [chapters[2].id, chapters[3].id], coverHref: up.href },
            { title: '封面C', author: '王五', chapterIds: [chapters[4].id, chapters[5].id], coverHref: null }
          ],
          deleteSource: false
        })
      })
    );
    check('生成 3 本新书', coverSplit.length === 3, String(coverSplit.length));
    check('A 卷沿用原书图作封面', coverSplit[0].coverHref === 'OEBPS/images/cover.png', String(coverSplit[0].coverHref));
    check('B 卷使用上传的新封面', coverSplit[1].coverHref === up.href, String(coverSplit[1].coverHref));
    check('C 卷无封面', coverSplit[2].coverHref === null, String(coverSplit[2].coverHref));
    const bImgs = await j(await fetch(`${BASE}/api/books/${coverSplit[1].id}/images`));
    check('B 卷携带上传的封面', bImgs.some((i) => i.href === up.href));
    const bExp = await fetch(`${BASE}/api/books/${coverSplit[1].id}/export`);
    const bBuf = Buffer.from(await bExp.arrayBuffer());
    const bZip = await JSZip.loadAsync(bBuf);
    const bOpf = await bZip.file('epubmaker.opf').async('string');
    check('B 卷导出 OPF 声明封面', bOpf.includes('cover-image'));
    check('B 卷导出包含上传封面文件', !!bZip.file(up.href));

    console.log('\n[6] 导出');
    const expRes = await fetch(`${BASE}/api/books/${created[0].id}/export`);
    check('导出请求成功', expRes.ok);
    const out = Buffer.from(await expRes.arrayBuffer());
    check('导出文件非空', out.length > 500, String(out.length));
    const outZip = await JSZip.loadAsync(out);
    const mimetype = await outZip.file('mimetype').async('string');
    check('mimetype 正确', mimetype === 'application/epub+zip');
    check('container.xml 存在', !!outZip.file('META-INF/container.xml'));
    const opf = await outZip.file('epubmaker.opf').async('string');
    check('OPF 标题为上卷', opf.includes('<dc:title>上卷</dc:title>'));
    check('OPF 含 3 个 itemref', (opf.match(/<itemref/g) || []).length === 3);
    check('OPF 声明封面', opf.includes('cover-image'));
    check('nav 与 ncx 均生成', !!outZip.file('epubmaker-nav.xhtml') && !!outZip.file('epubmaker-ncx'.replace('ncx', 'toc.ncx')));
    check('章节文件已打包', !!outZip.file('OEBPS/text/chapter1.xhtml'));
    check('插图已打包', !!outZip.file('OEBPS/images/pic.png'));

    // 回环：把导出的 epub 再导入一次
    console.log('\n[7] 回环导入（导出产物再导入）');
    const fd2 = new FormData();
    fd2.append('files', new Blob([out], { type: 'application/epub+zip' }), 'roundtrip.epub');
    const re = await j(await fetch(`${BASE}/api/books/import`, { method: 'POST', body: fd2 }));
    check('回环导入成功', re.books.length === 1);
    check('回环书名保持', re.books[0].title === '上卷', re.books[0].title);
    check('回环章节数保持', re.books[0].chapterCount === 3, String(re.books[0].chapterCount));

    console.log('\n[8] 删除与回收站');
    const delRes = await j(await fetch(`${BASE}/api/books/${book.id}`, { method: 'DELETE' }));
    check('删除返回软删除标记', delRes.deleted === true, JSON.stringify(delRes));
    const rest = await j(await fetch(`${BASE}/api/books`));
    check('删除后书架不再显示', !rest.find((b) => b.id === book.id));

    let trash = await j(await fetch(`${BASE}/api/trash`));
    const inTrash = trash.find((t) => t.id === book.id);
    check('回收站含该书且可恢复', !!inTrash && inTrash.recoverable === true, JSON.stringify(inTrash));

    const restored = await j(
      await fetch(`${BASE}/api/trash/${book.id}/restore`, { method: 'POST' })
    );
    check('恢复成功', restored.id === book.id && restored.deletedAt === null, JSON.stringify(restored));
    const afterRestore = await j(await fetch(`${BASE}/api/books`));
    check('恢复后回到书架', afterRestore.some((b) => b.id === book.id));

    // 再删一次并彻底删除
    await fetch(`${BASE}/api/books/${book.id}`, { method: 'DELETE' });
    trash = await j(await fetch(`${BASE}/api/trash`));
    check('再次删除后回到回收站', trash.some((t) => t.id === book.id));
    const purged = await j(await fetch(`${BASE}/api/trash/${book.id}`, { method: 'DELETE' }));
    check('彻底删除成功', purged.purged === true, JSON.stringify(purged));
    trash = await j(await fetch(`${BASE}/api/trash`));
    check('回收站已清空该书', !trash.some((t) => t.id === book.id));

    const logs = fs.readdirSync(cfg.logDir);
    check('日志文件已写入', logs.length > 0, JSON.stringify(logs));
    const exports = fs.readdirSync(cfg.exportDir);
    check('导出文件已落盘', exports.some((f) => f.endsWith('.epub')), JSON.stringify(exports));
  } catch (err) {
    failures++;
    console.error('\n异常:', err);
    console.error(srvLog.slice(-3000));
  } finally {
    srv.kill();
    console.log(`\n=== 结果：${failures === 0 ? '全部通过 ✅' : failures + ' 项失败 ❌'} ===`);
    try {
      fs.rmSync(TMP_HOME, { recursive: true, force: true });
    } catch {}
    process.exit(failures === 0 ? 0 : 1);
  }
})();
