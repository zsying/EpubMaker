# EpubMaker

EPUB 电子书维护与生成工具。本地运行的 Web 应用，用来把手上的 epub 导进来，读、改、拆、再导出去。

- **导入** —— 拖入 epub，自动解析元数据、目录、章节与全部资源
- **阅读** —— 侧栏目录 + 排版干净的阅读器，记住上次读到哪一章，方向键翻章
- **整理** —— 改书名/作者/简介/封面，改章节标题与正文 HTML，拖拽排序，新增、删除、合并章节
- **拆分** —— 把一本书按章节切成多本，自动只携带各分卷真正引用到的图片、样式与字体
- **导出** —— 生成符合 EPUB 3 规范的文件下载（同时带 nav + ncx，兼容老阅读器）

## 技术栈

| 层 | 选型 |
| --- | --- |
| 语言 | TypeScript（前后端统一） |
| 后端 | Node.js + Express |
| 数据库 | SQLite（`better-sqlite3`，缺原生模块时自动回退到内置 `node:sqlite`） |
| EPUB 引擎 | 自研解析/生成（JSZip + fast-xml-parser），无第三方 epub 库 |
| 前端 | React 18 + Vite + React Router，DOMPurify 净化正文 |

## 快速开始

```bash
npm install

# 开发模式：后端 7801，前端 7800（自动代理 /api）
npm run dev

# 生产模式：构建后由后端一并托管前端
npm run build
npm start        # 打开 http://127.0.0.1:7801
```

端到端冒烟测试（隔离在临时目录里跑，不影响真实数据）：

```bash
npm run build && npm run test:e2e
```

## 存储位置

所有运行时数据都放在 **`~/.epubmaker`**（可用环境变量 `EPUBMAKER_HOME` 整体改到别处）：

```
~/.epubmaker/
├── config.json          # 配置文件，首次启动自动生成
├── data/
│   ├── epubmaker.db     # SQLite 数据库
│   └── books/<bookId>/
│       ├── content/     # 解包后的章节 XHTML、图片、CSS、字体
│       └── original.epub
├── exports/             # 导出生成的 epub
├── logs/                # 按天分文件的运行日志
└── tmp/
```

### config.json

```jsonc
{
  "port": 7801,
  "host": "127.0.0.1",
  "dataDir": "data",        // 相对路径基于 ~/.epubmaker；也可填绝对路径挪到别的盘
  "exportDir": "exports",
  "logDir": "logs",
  "tmpDir": "tmp",
  "logLevel": "info",       // debug | info | warn | error
  "maxUploadSizeMb": 300,
  "keepOriginalEpub": true  // 导入时是否保留原始 epub 副本
}
```

改完重启服务生效。`port` / `host` 也可以用 `EPUBMAKER_PORT`、`EPUBMAKER_HOST` 临时覆盖。

## 目录结构

```
EpubMaker/
├── server/src/
│   ├── config.ts            # 配置加载 + 目录初始化
│   ├── logger.ts            # 按天切分的文件日志
│   ├── db.ts                # SQLite 适配层（双驱动）+ 建表
│   ├── routes.ts            # REST API
│   ├── epub/
│   │   ├── parse.ts         # container.xml / OPF / NCX / nav 解析
│   │   ├── build.ts         # EPUB 3 生成
│   │   ├── html.ts          # 正文抽取、链接改写、引用收集
│   │   └── mime.ts
│   └── services/
│       ├── library.ts       # 导入 / 整理 / 拆分 / 导出业务逻辑
│       └── storage.ts       # 内容文件读写（含路径穿越防护）
├── web/src/
│   ├── pages/{Library,Reader,Editor,Split}.tsx
│   ├── api.ts  toast.tsx  styles.css
└── scripts/e2e.mjs
```

## API 一览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/config` | 查看当前生效的存储路径 |
| GET | `/api/books?keyword=` | 书籍列表 / 搜索 |
| POST | `/api/books/import` | 上传导入（multipart，字段 `files`，支持多选） |
| GET/PATCH/DELETE | `/api/books/:id` | 书籍详情 / 修改元数据 / 删除 |
| GET/POST | `/api/books/:id/chapters` | 章节列表 / 新增章节 |
| GET | `/api/books/:id/chapters/:cid/render` | 阅读用正文（资源链接已改写） |
| GET | `/api/books/:id/chapters/:cid/source` | 编辑用 HTML 源码 |
| PATCH/DELETE | `/api/books/:id/chapters/:cid` | 改标题与正文 / 从目录移除 |
| POST | `/api/books/:id/chapters/reorder` | 重排章节 |
| POST | `/api/books/:id/chapters/merge` | 合并章节 |
| GET | `/api/books/:id/images` | 书内图片（用于选封面） |
| GET | `/api/books/:id/assets/*` | 读取书内任意资源 |
| POST | `/api/books/:id/split` | 拆分成多本 |
| GET | `/api/books/:id/export` | 导出 epub 下载 |

## 实现上的几个取舍

- **路径策略**：所有资源以「原 zip 内的完整路径」为主键存盘，导入导出保持一致，章节间相对引用（`../images/x.png`）天然可用。导出时生成的 `epubmaker.opf` / `epubmaker-nav.xhtml` / `epubmaker-toc.ncx` 放在包根，避免与原书文件重名。
- **阅读排版**：阅读器不加载原书 CSS，统一用一套干净的中文排版；图片链接实时改写到 `/api/books/:id/assets/...`，正文经 DOMPurify 净化后渲染。
- **拆分带资源**：按章节正文里的引用递归收集（含 CSS 里的 `url()`），样式表与封面始终携带，避免分卷排版丢失又不至于每卷都复制整本的图片。
- **删除章节**：只从目录中移除，正文文件保留在磁盘上，避免误删被其他章节引用的内容。
