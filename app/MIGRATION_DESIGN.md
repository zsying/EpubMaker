# EpubMaker 桌面化迁移设计文档（Go + TS / Wails）

> 状态：设计阶段（尚未写任何 Go 代码）。
> 决策来源：与用户商定的四要素 —— Wails + 保留 Go 内 HTTP 服务 + 先 Windows + 渐进式路由替换。
> 关联权威文档：`AGENTS.md`（项目红线，迁移后依然有效，本文第 8 节逐条给出 Go 实现要点）。

---

## 1. 目标与非目标

**目标**
- 把本地 Web 应用（Express + React）转为单个 Windows 原生可执行文件（Wails + React/TS）。
- 用户无需安装 Node 运行时；可分发包（.exe / 安装包）、可注册 `.epub` 文件关联、系统托盘。
- 业务逻辑、数据布局、对外 API 行为**完全兼容**现有实现，前端体验不变。

**非目标（本期不做）**
- 跨平台（macOS/Linux）打包 —— 架构不排斥，但本期只出 Windows。
- 账号体系、云同步、自动更新 —— 后续单独评估。
- 重写前端框架（保持 React + Vite + TS）。

---

## 2. 决策记录

| 项 | 决定 |
|---|---|
| 桌面框架 | **Wails v2**（Go 宿主 + 系统 WebView2，单二进制） |
| 前后端通信 | **Go 内 HTTP 服务**（前端 `api.ts` 同源调用，基本不改） |
| 分发平台 | 先 **Windows**（WebView2 运行时已确认存在 151.x） |
| 迁移策略 | **渐进式**：Go 逐路由替换 Express，未迁路由临时反代 Express |
| Go 代码位置 | 仓库内新建 `app/` 目录（Go module），与 `server/` `web/` 并存至迁移完成 |
| SQLite 驱动 | `modernc.org/sqlite`（纯 Go、无 cgo，利于单文件与跨平台编译） |

---

## 3. 技术架构

### 3.1 运行模型

- **生产**：`app` 编译为单 `.exe`；内嵌 `web/dist`（`go:embed`）；启动一个 `http.Server`（默认 `127.0.0.1:7801`）托管前端静态资源 + `/api/*`；Wails 窗口加载 `http://127.0.0.1:7801`。
- **开发**：`wails dev` 启动 Go 进程 + 前端 Vite 热更新（frontend 指向 `../web`）；窗口加载 Vite 提供的地址，`/api` 经 Vite proxy 到 Go 端口。
- **过渡期（渐进式）**：Express 暂迁到 `7802`（用 `EPUBMAKER_PORT` 覆盖）；Go 的 `/api/*` mux 已迁移的路由自行处理，未匹配的 `/api/*`**反向代理到 7802**。全部迁移后删除 Express、恢复 7801 为唯一端口。

### 3.2 仓库 / 目录结构（目标态）

```
EpubMaker/
├── app/                      # 新增：Go 模块（Wails 桌面端）
│   ├── main.go               # Wails 引导 + http.Server 启动
│   ├── wails.json            # Wails 配置（frontendDir=../web）
│   ├── bridge.go             # 过渡期：未迁移 /api 反代到 Express
│   ├── go.mod
│   ├── internal/
│   │   ├── db/               # SQLite 适配层（modernc.org/sqlite，位置参数 ?）
│   │   ├── storage/          # contentPath() 路径穿越防护
│   │   ├── library/          # 书籍 / 章节 / 回收站 / 封面 / 拆分 业务逻辑
│   │   ├── epub/             # 流式导入 / 导出 / render 链接改写 / mimetype
│   │   ├── webdav/           # PROPFIND 列目录 + 流式下载（Go encoding/xml）
│   │   ├── config/           # 读取 ~/.epubmaker/config.json
│   │   └── server/           # http 路由注册（镜像 routes.ts）
│   └── MIGRATION_DESIGN.md
├── web/                      # 基本保留；api.ts 仅 base URL 改同源
├── server/                   # 过渡期保留（Express），迁移完成后删除
└── scripts/
    ├── e2e.mjs               # 现有 TS e2e（49 断言）
    └── e2e_go.mjs            # 新增：驱动 Go 构建产物跑等价断言（Phase 3 起）
```

---

## 4. 现有 API 路由清单与迁移映射

来源：`server/src/routes.ts`（共 25 个端点）。下表供逐路由接管的 checklist。

| 方法 & 路径 | TS 处理 | Go 归属 | 阶段 |
|---|---|---|---|
| `GET /health` | 内联 | `server` | 1 |
| `GET /config` | 内联 | `server` + `config` | 1 |
| `GET /books` | `lib.listBooks` | `library` + `db` | 2 |
| `POST /books/import` | multer 多文件 | `library.importEpub` + 原生文件流 | 3/4 |
| `GET /books/:id` | `lib.getBook` | `library` + `db` | 2 |
| `PATCH /books/:id` | `lib.updateBook` | `library` + `db` | 2 |
| `DELETE /books/:id` | `lib.deleteBook`（软删） | `library` + `storage` | 2 |
| `GET /trash` | `lib.listTrash` | `library` + `db` | 2 |
| `POST /trash/:id/restore` | `lib.restoreBook` | `library` + `storage` | 2 |
| `DELETE /trash/:id` | `lib.purgeBook` | `library` + `storage` | 2 |
| `GET /books/:id/chapters` | `lib.listChapters` | `library` + `db` | 2 |
| `POST /books/:id/chapters/reorder` | `lib.reorderChapters` | `library` + `db` | 2 |
| `POST /books/:id/chapters/merge` | `lib.mergeChapters` | `library` + `db` | 2 |
| `POST /books/:id/chapters` | `lib.createChapter` | `library` + `db` | 2 |
| `GET /books/:id/chapters/:cid/render` | `lib.renderChapter` | `epub` | 3 |
| `GET /books/:id/chapters/:cid/source` | `lib.getChapterSource` | `library` + `storage` | 3 |
| `PATCH /books/:id/chapters/:cid` | `lib.updateChapter` | `library` + `db` | 2 |
| `DELETE /books/:id/chapters/:cid` | `lib.deleteChapter` | `library` + `storage` | 2 |
| `GET /books/:id/images` | `lib.listAssets` 过滤 | `library` + `db` | 2 |
| `GET /books/:id/assets/*` | `lib.assetFilePath` 流式 | `storage` 流式 | 2 |
| `POST /webdav/test` | `webdav.testWebDav` | `webdav` | 4 |
| `POST /webdav/list` | `webdav.listWebDav` | `webdav` | 4 |
| `POST /webdav/import` | `webdav.*` + `lib.importEpub` | `webdav` + `library` | 4 |
| `POST /books/:id/covers` | multer 单文件 + `lib.uploadCover` | `library.uploadCover` | 4 |
| `POST /books/:id/split` | `lib.splitBook` | `library` + `epub` | 3 |
| `GET /books/:id/export` | `lib.exportBook` 流式 | `epub` 流式 | 3 |

> 前端 `/api` 前缀在 Go 端用 `http.StripPrefix` 或直接挂在 mux 上；`api.ts` 的 `API_BASE` 改为 `''`（同源），其余 fetch 路径不变。

---

## 5. 服务层模块迁移映射

| 现有 TS 模块 | Go 包 | 关键点 |
|---|---|---|
| `services/library.ts` | `internal/library` | 所有书籍/章节/回收站/封面/拆分逻辑；保持函数签名语义一致 |
| `services/storage.ts` | `internal/storage` | `contentPath()` 路径穿越防护必须 1:1 复刻（见第 8 节） |
| `db.ts` | `internal/db` | 仅位置参数 `?`；`BEGIN/COMMIT` 手写事务；modernc.org/sqlite 驱动 |
| `epub/*` | `internal/epub` | 流式 zip（导入/导出）、`renderChapter` 链接改写、mimetype 首条 STORE |
| `services/webdav.ts` | `internal/webdav` | PROPFIND XML 解析（Go `encoding/xml`）、流式 GET 下载 |
| `config.ts` | `internal/config` | 读 `~/.epubmaker/config.json`，路径基于 `APP_HOME` |
| `mime.ts` | `internal/mime` | `guessMediaType` 按扩展名映射 |

---

## 6. 数据布局与兼容性

- 运行时数据根 `~/.epubmaker`（`EPUBMAKER_HOME` 可覆盖）**完全不变**：`config.json` / `data/epubmaker.db` / `data/books/<id>/content/<zip内路径>` / `data/trash/` / `exports/ logs/ tmp/`。
- 现有已导入书籍、数据库、配置**直接被 Go 版本读取**，无需迁移数据。
- 软删除模型不变：删除 = 目录 `os.Rename` 进 `trash/<id>-<ts>` + 置 `deleted_at`；恢复 = rename 回 + 清 `deleted_at`；彻底删除 = 删 DB 行 + 物理删目录（失败则 rename 到 `_purged` 保留区，**绝不逐文件 unlink**）。

---

## 7. 前端改动

- `web/src/api.ts`：`API_BASE` 由 `/api` 改为 `''`（同源）；其余接口路径、返回结构不变。
- 本地 EPUB 导入：浏览器 `<input type=file>` → **Wails 原生文件对话框**（`runtime.OpenFileDialog`），多选拿到本地路径后由 Go 直接读文件流导入（不再走 multipart 上传）。
- WebDAV 页、书架、阅读、编辑、拆分、回收站页面**无需改动**（只依赖 `/api` 契约）。
- 顶栏、路由、样式不变。

---

## 8. 红线清单（Go 实现要点，对应 AGENTS.md）

1. **资源主键 = 原 zip 内完整路径**：落盘 `books/<id>/content/<原路径>`，导出原样还原；禁止扁平化命名。→ Go 用 `archive/zip` 的 `file.Name` 作为落盘相对路径。
2. **导出三文件固定名**：`epubmaker.opf` / `epubmaker-nav.xhtml` / `epubmaker-toc.ncx`，置包根，不与原书 `content.opf` 撞名。
3. **mimetype 首条 + STORE**：`zip.File` 第一个条目 `Method=Store`、内容为 `application/epub+zip`，用 `zip.Writer.CreateHeader` 控制顺序。
4. **SQLite 仅位置参数 `?` + 手写事务**：modernc.org/sqlite 的 `sql.DB`，事务用 `BEGIN`/`COMMIT`；不依赖驱动专有 `transaction()`。
5. **删除章节只移目录、留正文文件**：同 AGENTS.md 第 5 条。
6. **content 访问走 `storage.ContentPath()`**：含路径穿越防护（`../` 归一化后必须仍在 `content/` 内），业务代码不自拼路径。
7. **阅读/预览**：`renderChapter` 返回改写资源链接后的 HTML；前端仍用 **DOMPurify 净化**后渲染（净化留在浏览器侧，不变）。
8. **沙箱安全删除**：软删除用 rename；物理删除整目录优先 `os.RemoveAll`，失败 rename 到保留区，不逐文件 unlink。

---

## 9. 测试策略

- **Phase 3 前必须补 `scripts/e2e_go.mjs`**：镜像现有 `e2e.mjs` 的 49 条断言，驱动 Go 构建产物（隔离 `EPUBMAKER_HOME`、独立端口）跑完整流程：导入 → 阅读 → 整理（增删/重排/合并）→ 拆分（含每卷封面）→ 导出 → 回环导入 → 删除/回收站/恢复。
- 每迁完一个阶段，运行该阶段相关断言；全绿后再接管下一批路由。
- 现有 `npm run test:e2e`（TS 版）在迁移期继续作为「Express 仍正确」的对照，直至 Express 删除。
- WebDAV：用本地 mock WebDAV（如 `gowebdav` 自带的测试服务器或 Python `http.server` + PROPFIND）验证列目录/导入；中文目录名解码要覆盖。

---

## 10. 分阶段实施计划

| 阶段 | 范围 | 退出标准 |
|---|---|---|
| **0 脚手架** | `wails init` 风格手工建 `app/`；`wails.json` 指向 `../web`；Go 起 HTTP 服务并 `go:embed` 现有 `web/dist`；窗口渲染首页/顶栏；`/api` 全量反代 Express(7802) | 窗口内能浏览现有书架、各页正常 |
| **1 基础** | 端口 `config` + `health` + `db` 层（modernc）+ `config` 包 | `/config` `/health` 由 Go 处理，其余仍反代 |
| **2 书籍与章节** | 书籍 CRUD、章节增删改查/重排/合并、回收站、资源流式、images | 书架/阅读/编辑/拆分页在 Go 下功能等价 |
| **3 EPUB 引擎** | 导入/导出/render/source/拆分；`e2e_go.mjs` 49 断言全绿 | 导入→导出回环字节一致；拆分每卷封面正确 |
| **4 WebDAV + 封面 + 本地导入** | WebDAV 三接口、封面、原生文件对话框导入 | WebDAV 导入、本地拖拽/选文件导入可用 |
| **5 收尾** | 撤 Express 桥（7801 唯一）、删除 `server/`、Windows 安装包、`.epub` 关联、托盘；更新 `AGENTS.md` 反映新栈 | 单 `.exe` 安装后开箱即用；`AGENTS.md` 与新架构一致 |

---

## 11. 风险与缓解

| 风险 | 缓解 |
|---|---|
| EPUB 流式引擎搬错（mimetype/顺序/资源主键） | Phase 3 前写 Go e2e，导入→导出回环校验；逐项对照红线 |
| modernc.org/sqlite 与 better-sqlite3 行为差异（事务/并发） | 单一 `*sql.DB` + `busy_timeout`；事务严格 `BEGIN/COMMIT`；e2e 覆盖 |
| 过渡期双服务端口/反代引入复杂度 | 反代仅做 HTTP 透传；每阶段收窄反代范围；Phase 5 彻底移除 |
| 前端 `/api` 前缀或契约漂移 | `api.ts` 仅改 base，契约由 e2e 双向守护 |
| WebView2 在某些 Windows 缺失 | 安装包内检测并提示/引导 WebView2 运行时（已确认本机存在） |

---

## 12. 未决 / 后续

- 安装包形式（NSIS / MSIX）、是否做自动更新 —— 单独评估。
- `.epub` 文件关联双击启动并导入的体验细节。
- 跨平台（macOS/Linux）是否纳入、何时纳入。
- `AGENTS.md` 在 Phase 5 重写为新栈权威文档（命令、红线、验证方式）。

---

## 13. 参考文件

- `server/src/routes.ts` —— 现有 25 个 API 端点（本文第 4 节来源）
- `server/src/services/library.ts` / `storage.ts` / `db.ts` —— 业务逻辑与数据访问
- `server/src/epub/*` / `services/webdav.ts` / `config.ts` / `mime.ts` —— 引擎与模块
- `web/src/api.ts` / `App.tsx` / `pages/*` —— 前端契约
- `scripts/e2e.mjs` —— 49 条断言参考
- `AGENTS.md` —— 项目红线（本文第 8 节逐条映射）
