# AGENTS.md — EpubMaker 项目约定与规则

本文件是所有 AI 助手 / 协作者在改这个项目之前必须先读的约定。README 讲"能做什么"，本文件讲"怎么改才不出错"。

## 项目是什么

本地运行的 EPUB 电子书维护与生成**桌面应用**（Wails v2，Go + TypeScript 前端）：
**导入 → 阅读 → 整理 → 拆分 → 导出**。后端已 100% 从 Express/TypeScript 迁移到 Go，
不再依赖 Node 服务，无反向代理。

- `app/`：Go + Wails v2 桌面应用（模块 `epubmaker-desktop`）。后端全部在 `app/internal/*`：
  - `internal/api`：所有 `/api/*` 路由（books / trash / chapters / assets / render / covers / split / export / webdav）
  - `internal/epub`：OCF/OPF/NCX/NAV 解析与 EPUB 流式构建（零依赖，只用标准库）
  - `internal/html`：属性改写 / 引用收集等字符串助手
  - `internal/library`：导入 / 渲染 / 导出 / 上传封面 / 拆分
  - `internal/webdav`：WebDAV 客户端（test/list/import）
  - `internal/storage`：zip 内路径 ↔ 磁盘映射 + 回收站（软删除）
  - `internal/app`：Wails 绑定（原生文件对话框、命令行 .epub 导入）
  - `internal/server`：桌面 HTTP 表面（静态托管 web/dist + SPA 回退），**不含任何代理**
  - `internal/db`：modernc.org/sqlite（`database/sql`，纯 Go 无 cgo）
  - `internal/config`、`internal/mime`
- `web/`：React 18 + Vite + TS 前端，构建到 `web/dist`，由 `server.NewMux` 托管。
  Wails 构建时执行 `frontend:build`（`npm run build`）产出 `web/dist`。
- `app/wails.json`：Wails 配置（前端目录、构建命令、NSIS 安装包、`.epub` 文件关联）。

## 常用命令

```bash
cd app
go build ./...                 # 编译桌面后端
go vet ./...                  # 静态检查
go test ./...                 # 全部单测（e2e 需关闭沙箱，见下）
go test ./internal/api/... -run TestE2ELifecycle   # 端到端冒烟（导入→阅读→拆分→导出→回收站）
wails dev                     # 桌面开发：后台起 vite watcher + 编译 Go + 窗口热更新
wails build                   # 生产 exe（先构建前端）
wails build -nsis             # Windows NSIS 安装包（含 .epub 文件关联，需本机装 NSIS）
# 仓库根（推荐入口）：
npm run dev:app               # = cd app && wails dev
npm run build:app             # 生产构建
npm run build:app:nsis        # 打安装包
npm run dev:web               # 仅前端 vite（7800，无 Go 后端，不能调 /api）
```

> `wails dev` 首次会静默编译 Go（含 modernc.org/sqlite）几十秒才弹窗，看到 vite `ready` 后**耐心等，别 Ctrl+C**。
> 端口 7800 已设 `strictPort:true`：被上次残留的 vite 子进程占用时会直接报错而非静默死等，此时先 `taskkill /F /IM node.exe`。

> 改动后端后**必须重启应用**，`/api/health` 只回 ok 不能证明新代码生效——发一个"只有新代码才支持"
> 的请求确认，或核对进程启动时间。Go 是编译型，重建即生效。

## 运行时数据布局（都在 `~/.epubmaker`）

```
~/.epubmaker/
├── config.json                 # port/host/各目录/maxUploadSizeMb/keepOriginalEpub
├── data/epubmaker.db           # SQLite（modernc.org/sqlite）
├── data/books/<bookId>/
│   ├── content/<原 zip 内完整路径>   # 章节、图片、CSS、字体
│   └── original.epub
├── data/trash/                 # 回收站（软删除的书目录整体 rename 到这里）
│   └── _purged/                # 彻底删除被沙箱拦截时的保留区
├── exports/  logs/  tmp/
```

- `EPUBMAKER_HOME` 环境变量可整体改根路径；`EPUB_WEB_DIST` 可覆盖前端 dist 路径。
- `config.json` 里各目录相对路径基于 APP_HOME，绝对路径可挪到别的盘。

## 核心不变量（红线，改代码时别破坏）

1. **资源主键 = 原 zip 内完整路径**。落盘 `books/<id>/content/<原路径>`，导出原样还原。
   章节间相对引用（`../images/x.png`）因此永远有效。**禁止改成扁平化命名**。
2. 导出生成的三个文件固定叫 `epubmaker.opf`、`epubmaker-nav.xhtml`、`epubmaker-toc.ncx`，放包根——
   为的是不和原书自带的 `content.opf` / `nav.xhtml` 撞名。
3. `mimetype` 必须是 zip 第一个条目且 `STORE` 不压缩（`app/internal/epub/build.go` 用
   `zip.Store` + `RegisterCompressor` 自定义 deflate 级别 6）。
4. SQLite 适配层（`app/internal/db`）**只允许位置参数 `?`**，事务用手写 `BEGIN`/`COMMIT`——
   纯 Go（modernc.org/sqlite），`db` 用 `SetMaxOpenConns(1)`。别用命名参数、别依赖驱动特有的事务封装。
5. 删除章节只从目录移除，磁盘正文文件保留（可能被别处引用）。
6. 所有 content 目录内的文件访问都走 `internal/storage` 的 `ContentPath()`（含路径穿越防护），
   不要在业务代码里自己拼路径。
7. 阅读/预览用 `library.RenderChapter` 返回已改写过资源链接的 HTML，前端一律 **DOMPurify 净化**后渲染。

## 开发规则与约定

### 大文件与内存
- 上传用 multer 风格的**磁盘暂存**：`internal/api/engine.go` 的 `saveUploadTo` 把 multipart 落到
  `storage.TempPath(name)`（`tmp/`），导入后 `os.Remove` 清理，不要改回内存暂存。
- 导入/导出必须**流式**：`epub.ParseEpub` 只保留 zip 条目句柄、按需解压；
  `epub.BuildEpub` 资源以 `io.Reader` 懒流交给打包器（`io.Copy`）。不要整本 epub 或全部资源一次进内存。
- 图片全程**字节级无损**：不转码、不重压（`internal/library` 原样写 content 目录）。

### 删除与回收站（软删除模型）
- `books.deleted_at` 非空 = 在回收站；`listBooks`/`getBook` 一律过滤 `deleted_at IS NULL`。
- `DELETE /api/books/:id` 是**软删除**：目录 rename 进 `data/trash/<id>-<ts>` + 置 `deleted_at`
  （`storage.MoveBookDirToTrash`）。
- 恢复 = 目录 rename 回 `books/<id>` + 清 `deleted_at`；彻底删除 = 删 DB 行 + 物理删目录
  （`storage.RemoveBookDir`，失败 rename 进 `_purged`）。
- 不要在 deleteBook 里用"逐文件 unlink 回退"删除目录——在沙箱环境会因累计删除量卡死进程。见"沙箱"节。

### 沙箱环境（WorkBuddy 预览时）
本机直接跑没有这些限制，但预览服务跑在沙箱里，会拦截"批量文件删除"（>50 个/次，报
`SAFE_DELETE_BULK_CONFIRM_REQUIRED`，或静默卡死进程）。Go 后端的规避手段：
- 目录"移动"用 `os.Rename`（不是删除，不受限）；
- 删除整目录优先 `os.RemoveAll`，失败时 rename 到 `_purged` 保留区，**不要**逐文件 `os.Remove`；
- `modernc.org/sqlite` 在沙箱里会**卡住**，涉及 SQLite 的测试必须**关闭沙箱**运行
  （`dangerouslyDisableSandbox: true`）。

### 其它
- **git commit 信息必须用英文**（标题+正文都英文，按 Conventional Commits 风格：`feat:` / `fix:` / `refactor:` / `docs:` 等）。
- 上传文件名：Go 的 `multipart.FileHeader.Filename` 已是 UTF-8，无需再做 latin1→utf8 还原。
- web 构建：`vite.config.ts` 已设 `emptyOutDir:false`（规避沙箱清空 dist 限制）。本机正常 `rm` 不受影响。
- 改 EPUB 引擎或 API 后必须跑 `cd app && go build ./... && go vet ./... && go test ./...`
  （e2e 用 `go test ./internal/api/... -run TestE2ELifecycle`，需关闭沙箱）。
- 新增依赖尽量只用标准库 + Wails + modernc.org/sqlite；不要为了 XML/WebDAV/EPUB 引入重量级第三方库
  （当前 `epub/xml.go` 是手写命名空间剥离解析器，匹配 fast-xml-parser 的 find/findAll 递归语义）。

## 验证

```bash
cd app && go build ./... && go vet ./... && go test ./...
```

`TestE2ELifecycle`（`internal/api/e2e_test.go`）在系统临时目录造隔离 `EPUBMAKER_HOME`，
完整跑通 导入 → 列出章节 → 渲染（图片 URL 改写）→ 导出回环解析 → 拆分（每卷封面）→ 上传封面 →
删除/回收站/恢复/彻底删除 全流程。涉及 SQLite，**必须关闭沙箱运行**。

## 常见坑速查

| 坑 | 原因 | 处理 |
| --- | --- | --- |
| `regexp: Compile ... invalid escape sequence: \2` | Go 的 RE2 不支持反向引用 | `internal/html/html.go` 的 `urlAttrRe` 把闭合引号也捕获成独立分组，在代码里用 `q1==q2` 校验匹配，不要写 `\1`/`\2` |
| `modernc.org/sqlite` 测试卡死 | 沙箱拦截 SQLite 的锁/IO | 跑 SQLite 相关测试加 `dangerouslyDisableSandbox: true` |
| 删除书籍报 SAFE_DELETE | 沙箱批量删除拦截 | 软删除 rename 进 trash，见上文 |
| 解析 OPF 报"缺少 package 元素" | `epub/xml.go` 的树是命名空间剥离树，`find/findAll` 是**递归**的，调用方要按 fast-xml-parser 语义用 `root.Find("package")` | 保持 `parseXMLTree` 的 `#root` 包裹 + 递归 `find`/`findAll` |
| 拆分后分卷封面都一样 | `BuildExportInput` 没读 `part.coverHref` | 拆分时把每卷 coverHref 透传给导出 |
| 拆分页左右一起滚 | Grid 行高按内容撑开 / 页面高度不确定 | 用 flex 分栏 + `min-height:0` + `overflow-y:auto`；页面高度用确定值（如 `calc(100vh - 56px)`） |
| vite build 中断 | 沙箱 safe-delete 拦 `emptyOutDir` | 已设 `emptyOutDir:false`；必要时清掉 `web/dist` 里的旧哈希残留 |
| `.epub` 双击打不开 | 没装 NSIS 安装包 / 没注册关联 | 用 `wails build -nsis` 安装；`main.go` 已解析命令行 .epub 并在 `Startup` 导入并 emit `epub:imported` 事件（前端需监听该事件刷新书架） |
| `wails dev` 永久卡在 `Compiling frontend:` | `wails.json` 用了 `frontend:dev` 而非 `frontend:dev:watcher`。dev 模式下该字段被当"一次性构建命令"用 `cmd.Run()` **阻塞**执行，而 `npm run dev`(vite) 是长驻服务器永不退出 | 必须写 `"frontend:dev:watcher": "npm run dev"` + `"frontend:dev:serverUrl": "auto"`；注意键名是 `frontend:dev:serverUrl`（不是 `frontend:devserverurl`），写错会被静默忽略 |
| `json: cannot unmarshal string into ... Project.Author` | Wails v2.11 起 `wails.json` 的 `author` 必须是对象 | 写成 `"author": { "name": "john" }` |
| 打包报 `open epubFileIcon.png: file does not exist` | `info.fileAssociations[].iconName` 要求 `app/build/<iconName>.png` 存在，Wails 据此生成 `windows/<iconName>.ico` | 保证 `app/build/epubFileIcon.png` 在库（已提交）；换图标直接覆盖该 PNG（建议 ≥256×256） |
| `wails build -nsis` 报创建安装包失败 | 本机没装 NSIS，`makensis` 不在 PATH | `winget install -e --id NSIS.NSIS` 后重跑 |
| **整个目录凭空消失** | 对项目内目录执行 `rmdir`/`rm -rf` 时，删除会**级联蔓延到父目录**（实测 `rmdir app/installer` 把整个 `app/` 移进了回收站） | **禁止**对项目目录用 `rm`/`rmdir`。删文件只用 `git rm`（空目录 git 本来就不跟踪，不用管）。若已发生：跟踪文件用 `git checkout -- <dir>` 恢复，未跟踪文件去 `D:\$RECYCLE.BIN\<SID>\` 找 `$R*` 载荷（`$I*` 是元数据，内含原路径）拷回 |
