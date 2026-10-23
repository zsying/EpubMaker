# 排查手册

按现象查。都是实际踩过的，不是推测。

## 构建与开发

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `wails dev` 永久卡在 `Compiling frontend:` | `wails.json` 里写了 `frontend:dev` 而非 `frontend:dev:watcher`；dev 模式下该字段被当一次性构建命令 `cmd.Run()` 阻塞执行，而 `npm run dev` 是长驻服务 | 必须用 `"frontend:dev:watcher": "npm run dev"` + `"frontend:dev:serverUrl": "auto"`。键名是 `serverUrl`（小写 s），写错会被静默忽略 |
| `wails dev` 没弹窗 | 首次要静默编译 Go（含 modernc.org/sqlite）几十秒 | 看到 vite `ready` 后耐心等，别 Ctrl+C |
| 启动报端口被占用 | 上次残留的 vite 子进程占着 7800（`strictPort: true`，直接报错而不是静默死等） | `taskkill /F /IM node.exe` |
| `internal error: package "fmt" without types` | wails v2.11 内置的 `golang.org/x/tools` 读不了 Go 1.27 的导出数据，而 `go build ./...` 是通过的 | `run.ps1` 已把 `GOTOOLCHAIN` 钉到 `app/go.mod` 的 go 版本（见 `Set-WailsToolchain`）。wails 更新后可删 |
| `json: cannot unmarshal string into ... Project.Author` | Wails v2.11 起 `wails.json` 的 `author` 必须是对象 | `"author": { "name": "john" }` |
| 打包报 `open epubFileIcon.png: file does not exist` | `info.fileAssociations[].iconName` 要求 `app/build/<iconName>.png` 存在，Wails 据此生成 `.ico` | 保证 `app/build/epubFileIcon.png` 在库；换图标直接覆盖（≥256×256） |
| `wails build -nsis` 创建安装包失败 | 本机没装 NSIS，`makensis` 不在 PATH | `winget install -e --id NSIS.NSIS` |
| `.epub` 双击打不开 | 没装 NSIS 版 / 没注册文件关联 | `wails build -nsis` 后安装。`main.go` 解析命令行 .epub，在 `Startup` 导入并 emit `epub:imported`（前端监听后刷新书架） |
| 运行 exe 报 `frontend not built (web/dist missing)` | 旧实现从磁盘读 `web/dist`，二进制移走就找不到 | 已改 `//go:embed all:frontend/dist`。构建时 `scripts/sync-frontend-dist.js` 把 `web/dist` 镜像到 `app/frontend/dist` |
| `vite build` 中断 | 沙箱拦 `emptyOutDir` 的批量删除 | 已设 `emptyOutDir:false`；必要时手清 `web/dist` 里旧哈希残留 |
| 前端空白 / `window.go.app.Backend is not a function` | 单独跑了 `npm run dev:web`，那里面没有 WebView 绑定 | 用 `run.ps1 dev` / `build`。本应用无 HTTP，前端所有数据都走进程内绑定 |

## 沙箱环境（WorkBuddy 预览时）

本机直接跑没这些限制；预览服务在沙箱里会拦批量文件删除（>50 个/次）：

- `modernc.org/sqlite` 会**卡住** → 涉及 SQLite 的测试必须 `dangerouslyDisableSandbox: true`。
- 删除整目录优先 `os.RemoveAll`，失败则 rename 到 `data/trash/_purged/` 保留区；**不要**逐文件 `os.Remove`
  （累计删除量会卡死进程）。目录移动用 `os.Rename`，不是删除，不受限。
- **整个目录凭空消失**：对项目内目录执行 `rmdir`/`rm -rf` 会级联蔓延到父目录
  （实测 `rmdir app/installer` 把整个 `app/` 挪进了回收站）。已跟踪文件用 `git checkout -- <dir>` 恢复；
  未跟踪文件去 `D:\$RECYCLE.BIN\<SID>\` 找 `$R*` 载荷拷回（`$I*` 是元数据，内含原路径）。

## 数据与解析

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 解析 OPF 报"缺少 package 元素" | `epub/xml.go` 的树是命名空间剥离树，`find/findAll` 是**递归**的 | 按 fast-xml-parser 语义用 `root.Find("package")`；保持 `parseXMLTree` 的 `#root` 包裹 |
| `regexp: invalid escape sequence: \2` | Go 的 RE2 不支持反向引用 | `html.go` 的 `urlAttrRe` 把闭合引号也捕获成独立分组，代码里用 `q1==q2` 校验 |
| 拆分后每卷封面都一样 | `BuildExportInput` 没读 `part.coverHref` | 拆分时把每卷 coverHref 透传给导出 |
| 拆分页左右两栏一起滚 | Grid 行高按内容撑开、页面高度不确定 | flex 分栏 + `min-height:0` + `overflow-y:auto`，页面高度用确定值（如 `calc(100vh - 56px)`） |

## 词库与生词本

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 释义显示成一串 `\n` | ECDICT 把多行释义存成**字面量 `\n`**（反斜杠+n），不是真换行 | 导入时 `dict.unescape()`，已内置 |
| `'hood` 这类词查不到 | 查询归一化会剥掉前导标点，而词库里有带标点的词条 | 匹配键同时试 `keyOf(raw)` 与 `Normalize(raw)`，别只归一化一种 |
| 变形词只显示"xx的过去式" | ECDICT 每个变形**都是独立词条**，其释义只是交叉引用；但 `running` 这类又有实义 | 不用还原结果覆盖本体：`Result.Base` 同时返回原型，前端并排显示 |
| 导入新词库后仍是旧数据 | 词库句柄被缓存 | 重新导入前必须 `closeDict()`，已内置在 `DictImportCSV` |

其他与词库有关的设计原因见 `docs/decisions.md`。
