# EpubMaker

EPUB 电子书维护与生成工具。本地运行的**桌面应用**（Wails v2，Go 后端 + TypeScript 前端），用来把手上的 epub 导进来，读、改、拆、再导出去。后端已用 Go 重写，不再依赖 Node 服务。

- **导入** —— 拖入 epub，自动解析元数据、目录、章节与全部资源
- **阅读** —— 侧栏目录 + 排版干净的阅读器，记住上次读到哪一章，方向键翻章
- **整理** —— 改书名/作者/简介/封面，改章节标题与正文 HTML，拖拽排序，新增、删除、合并章节
- **拆分** —— 把一本书按章节切成多本，自动只携带各分卷真正引用到的图片、样式与字体
- **导出** —— 生成符合 EPUB 3 规范的文件下载（同时带 nav + ncx，兼容老阅读器）

## 技术栈

| 层 | 选型 |
| --- | --- |
| 语言 | Go（后端）+ TypeScript（前端） |
| 桌面框架 | Wails v2（WebView2，单可执行文件） |
| 后端 | Go（`app/internal/*`，零依赖 EPUB/XML/WebDAV，仅标准库 + Wails） |
| 数据库 | SQLite（modernc.org/sqlite，纯 Go 无 cgo） |
| EPUB 引擎 | 自研解析/生成（`app/internal/epub`），无第三方 epub 库 |
| 前端 | React 18 + Vite + React Router，DOMPurify 净化正文 |

## 快速开始

```bash
# 桌面应用（需要 Go 工具链与 Wails CLI）
cd app
go build ./...          # 先确保后端编译通过
wails dev               # 构建前端 + 启动桌面应用 + 热更新
wails build             # 产出 EpubMaker.exe
wails build -nsis       # 产出 Windows 安装包（含 .epub 文件关联，需本机装 NSIS）

# 仅前端（可选）
npm run dev:web         # vite 开发服务器
```

后端单元 / 端到端测试（隔离在临时目录里跑，不影响真实数据；涉及 SQLite 需关闭沙箱）：

```bash
cd app && go test ./...
cd app && go test ./internal/api/... -run TestE2ELifecycle
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
├── app/
│   ├── main.go              # Wails 入口：组装 mux、绑定原生能力、解析命令行 .epub
│   ├── main_test.go         # 校验前端产物已 embed
│   ├── wails.json           # Wails 配置（前端目录、NSIS、.epub 文件关联）
│   ├── build/               # Wails 构建资产：appicon.png、epubFileIcon.png（.epub 关联图标）、
│   │                        # windows/{info.json,installer/*.nsi}（NSIS 模板，bin/ 不入库）
│   ├── frontend/dist/       # 占位目录，仅 .gitkeep 入库；wails build 时由 scripts/sync-frontend-dist.js
│   │                        # 从 web/dist 镜像内容，再被 //go:embed 打包进二进制
│   ├── internal/
│   │   ├── api/             # 所有 /api 路由（books/trash/chapters/assets/webdav）
│   │   ├── epub/            # OCF/OPF/NCX/NAV 解析与流式构建（零依赖）
│   │   ├── html/            # 正文抽取、链接改写、引用收集
│   │   ├── library/         # 导入 / 渲染 / 导出 / 封面 / 拆分
│   │   ├── webdav/          # WebDAV 客户端（test/list/import）
│   │   ├── storage/         # 内容文件映射 + 回收站（软删除）
│   │   ├── app/             # Wails 绑定（原生文件对话框、命令行导入）
│   │   ├── server/          # 桌面 HTTP 表面（SPA 回退，无代理）；静态文件由 Wails embed 直供
│   │   ├── db/  config/  mime/
│   └── go.mod
├── scripts/
│   └── sync-frontend-dist.js  # wails build 时把 web/dist 镜像到 app/frontend/dist
└── web/src/
    ├── pages/{Library,Reader,Editor,Split}.tsx
    ├── api.ts  toast.tsx  styles.css
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
