# AGENTS.md

改这个项目前必读。README 讲**能做什么、怎么跑**；本文件只讲**怎么改才不出错**。
更细的排查步骤见 `docs/troubleshooting.md`，设计取舍的历史原因见 `docs/decisions.md`。

## 是什么

本地桌面应用（Wails v2，Go 后端 + React/TS 前端，WebView2）：EPUB 的导入 → 阅读 → 整理 → 拆分 → 导出，
外加英文阅读学习（划词查词 + 生词本）。后端全 Go，**无 Node 服务、无 HTTP、无端口**。

| 路径 | 职责 |
| --- | --- |
| `app/internal/app` | Wails 绑定。`Backend` = 全部数据操作；`App` = 原生集成（文件对话框、命令行 .epub）；`learning.go` = 查词/生词本 |
| `app/internal/epub` | OCF/OPF/NCX/NAV 解析与流式构建（零依赖，手写 XML） |
| `app/internal/library` | 导入 / 渲染 / 导出 / 封面 / 拆分 |
| `app/internal/dict` | 本地 ECDICT 词库：CSV 导入、归一化、词形还原、频率分级（独立 SQLite） |
| `app/internal/vocab` | 生词本 + 查词信号 |
| `app/internal/storage` | zip 内路径 ↔ 磁盘映射、回收站（软删除） |
| `app/internal/db` | modernc.org/sqlite（纯 Go，无 cgo） |
| `app/internal/{html,config,mime,webdav}` | 字符串改写 / 配置 / MIME / WebDAV 客户端 |
| `web/src` | React 18 + Vite。`pages/` 每页一个文件，`api.ts` 是绑定的唯一封装层，`overlay.ts` 是浮层定位算法 |
| `app/cmd/dictimport` | 命令行词库安装器，与界面按钮走同一条代码路径 |

## 红线（改代码别破坏）

1. **资源主键 = 原 zip 内完整路径**。落盘 `books/<id>/content/<原路径>`，导出原样还原，章节间相对引用
   （`../images/x.png`）因此永远有效。禁止扁平化命名。
2. **没有 HTTP、没有端口**。前端只用 `window.go.app.Backend.*` 进程内绑定；二进制（封面/图片/渲染章节/导出）
   一律内联 base64。禁止引入 `/api` 路由、TCP 监听、multipart 上传。
3. **SQLite 层只用位置参数 `?`**，事务手写 `BEGIN`/`COMMIT`，`SetMaxOpenConns(1)`。别用命名参数或驱动特有的封装。
4. **正文渲染后必须 DOMPurify 净化**，且只经 `library.RenderChapter` 改写资源链接。
5. **分页阅读器翻页不做动画**：章内翻页是一次 `setPageIndex` + `translate3d`，禁止 3D 翻页/卷曲/投影；
   一次翻页只允许一个活动图层，**绝不能复制整章 HTML**。章节切换保留 130ms 淡入淡出（盖住异步加载空窗）。
6. **标注定位靠字符偏移**（`startOffset/endOffset`），高亮只包裹文本、不改文本。任何改变正文长度的做法
   （内联注音、往正文插入节点）都会让历史标注集体错位。浮层必须 `position: fixed`，
   任何进入文档流的元素都会改变 `contentHeight` → 页数变化 → 读者被莫名翻页。
7. **生词是跨书资产**：`vocab.book_id/chapter_id` 只是指针，**不加外键**。书删了词还在。
8. 所有 content 目录内的文件访问走 `storage.ContentPath()`（含路径穿越防护），别自己拼路径。
9. 删除章节只从目录移除，正文文件保留（可能被别处引用）。
10. **导入只认文件路径，不接受上传**。拖放走 Wails 原生桥（`main.go` 的 `DragAndDrop.EnableFileDrop`
    + `web/src/filedrop.ts`），**不要**改用 `e.dataTransfer.files` 读文件：webview 给的 `File`
    没有路径，而且缺了原生监听连默认行为都拦不住（拖进来会把 webview 导航到那个文件）。

## 开发约定

- **首选入口 `.\run.ps1`**（无参数打印帮助）：`dev` / `build` / `nsis` / `test` / `clean` / `web` / `install`。
  底层是 `wails dev`、`wails build`，`web` 模式**没有 Go 后端**（`window.go` 不存在），只能调样式。
- 改后端必须过：`cd app && go build ./... && go vet ./... && go test ./...`；
  改前端必须过 `cd web && npx tsc --noEmit`。改了前端还要 `npm run build` +
  `node scripts/sync-frontend-dist.js` 才会进入二进制（`//go:embed all:frontend/dist`）。
- **涉及 SQLite 的测试在沙箱里会卡死**，运行时要关沙箱。
- 新增依赖克制：标准库 + Wails + modernc.org/sqlite。不要为 XML/WebDAV/EPUB 引第三方库。
- **git commit 信息用英文**，Conventional Commits（`feat:` / `fix:` / `refactor:` / `docs:`）。
  一个逻辑改动一个 commit，不要攒着一起提交。
- **禁止对项目目录用 `rm`/`rmdir`**（会级联到父目录，实测把整个 `app/` 挪进回收站）。删文件用 `git rm`。

## 数据位置

`~/.epubmaker/`：`data/epubmaker.db`、`data/books/<id>/content/`、`data/trash/`、
`dict/dict.db`（词库，约 98MB / 77 万条）、`exports/`、`logs/`、`tmp/`。
`EPUBMAKER_HOME` 可整体改根路径。完整字段见 README。
