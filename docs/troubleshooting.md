# 排查手册

按现象查。都是实际踩过的，不是推测。

## 构建与开发

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `wails3 build` / `wails3 dev` / `wails3 package` 跑不动 | 它们是 go-task 的薄壳，Taskfile 里的 shell 包装在本机跑不了（`gradlew` 无扩展名、`.bat` 也被拒） | 用 `run.ps1 build` / `run.ps1 dev` / `run.ps1 mobile`（各自调 `app/build-windows.ps1`、`app/dev-windows.ps1`、`app/cmd/mobile/build-android.ps1`）。CLI 只留 `generate syso` 与 `android overlay:gen` |
| `run.ps1 dev` 里 vite 已 `ready`，窗口迟迟不出现 | 之后还要编一遍 Go（含 modernc.org/sqlite）并链 `.syso`，冷启动几十秒 | 等 `==> Launching EpubMaker`；别 Ctrl+C |
| `run.ps1` 报 `required tool not found: go` | 在精简过的环境里跑（如只有 `.CPL` 的 `PATHEXT`、没有 Go 在 PATH） | 补 `$env:PATHEXT`、`$env:LOCALAPPDATA`、`$env:GOCACHE`，并把 `D:\Program Files\Go\bin` 加进 PATH |
| 启动报端口被占用 | 上次残留的 vite 子进程占着 7800（`strictPort: true`，直接报错而不是静默死等） | `taskkill /F /IM node.exe` |
| `(Get-Item EpubMaker.exe).VersionInfo` 里 `CompanyName` / `ProductName` 全空，但 `FileVersionRaw` 有 0.4.0.0 | 版本资源写的是**语言中立**的 `StringFileInfo` 表（`000004b0`，v3 模板与 v2 时代相同），本机 PS 5.1 的 .NET 读取器不回退到中立表 | 资源本身是完整的（用 PE 资源查看器能看到 6 个键）；这是读取端的毛病，不是构建坏了，v2 时代一模一样。要断言构建产物，看 `wails3 generate syso` 的输入 `build/windows/info.rendered.json` |
| 打包报 `open epubFileIcon.png: file does not exist` | 该错误来自 v2 的 `info.fileAssociations[].iconName` 约定；v3 只从 `application.Options.FileAssociations` 取扩展名 | 图标在 `app/build/windows/icon.ico`，`.epub` 关联在 `main.go` 的 `FileAssociations`，不再需要 png |
| 桌面 CDP 端口一直不开（`127.0.0.1:9222` refuse） | v3 只合并 `application.Options.Windows.AdditionalBrowserArgs`，环境变量 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` 被忽略 | `main.go` 的 `debugArgs()` 读 `EPUBMAKER_DEBUG_PORT` 并自己拼 `--remote-debugging-port`；发布版（`production` tag）没有 devtools，要用 `-Dev` 构建才能连 |
| `wails3 generate syso` 找不到 / syso 没被链接 | syso 必须落在被 `go build` 的包目录（`app/`），且构建后要删掉，否则下次构建会带着旧图标和旧版本号 | `build-windows.ps1` 生成 `app/wails_windows_amd64.syso`，`go build .` 后 `Remove-Item` |
| `makensis` 找不到 / NSIS 步骤失败 | 本机没装 NSIS，且 `Resolve-Tool` 的回退路径也没命中 | `winget install -e --id NSIS.NSIS`；脚本默认找 `C:\Program Files (x86)\NSIS\makensis.exe` |
| `.epub` 双击打不开 | 用的是解压版 exe（没有注册表项） | 装 NSIS 版。关联来自 `application.Options.FileAssociations`，`main.go` 把命令行里的 `.epub` 排进 `QueueOpen` 并在窗口起来后导入 |
| 运行 exe 报 `frontend not built (web/dist missing)` | 旧实现从磁盘读 `web/dist`，二进制移走就找不到 | 已改 `//go:embed all:frontend/dist`。构建时 `scripts/sync-frontend-dist.js` 把 `web/dist` 镜像到 `app/frontend/dist` |
| `vite build` 中断 | 沙箱拦 `emptyOutDir` 的批量删除 | 已设 `emptyOutDir:false`；必要时手清 `web/dist` 里旧哈希残留 |
| 前端空白 / 满屏"后端未就绪" | 单独跑了 `npm run dev:web`：浏览器里没有宿主，`/wails/runtime.js` 是 404 | 用 `run.ps1 dev` / `build`。本应用无 HTTP，前端所有数据都走进程内绑定；只调样式时忽略数据报错 |

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
