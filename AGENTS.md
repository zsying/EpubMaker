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
   **出站请求是另一回事**：`internal/webdav` 和 `internal/dict/online.go` 确实会主动 GET 外部服务。
   新加出站请求必须同时满足三条——(a) 由用户的显式动作触发，不在打开页面时偷偷发；(b) 有超时，
   且失败不阻塞 UI；(c) 结果落到本地（`dictcache` 那张表），同一个词不重复问。生词本的
   「联网补全」是现成模板，`FillVocabGlosses` 的墓碑逻辑（查过了没有 → 记一笔空结果）也别漏掉，
   否则按钮会永远提示还有 N 个词没解决。
3. **SQLite 层只用位置参数 `?`**，事务手写 `BEGIN`/`COMMIT`，`SetMaxOpenConns(1)`。别用命名参数或驱动特有的封装。
4. **正文渲染后必须 DOMPurify 净化**，且只经 `library.RenderChapter` 改写资源链接。
5. **分页阅读器翻页不做动画**：章内翻页是一次 `setPageIndex` + `translate3d`，禁止 3D 翻页/卷曲/投影；
   一次翻页只允许一个活动图层，**绝不能复制整章 HTML**。章节切换保留 130ms 淡入淡出（盖住异步加载空窗）。
5b. **触摸设备没有 hover，每个靠悬停的入口都要有 tap 等价物**。`Reader.tsx` 的 `touchPrimary`
   （`pointer: coarse` / `hover: none`，且 `any-pointer: fine` 为假）是唯一判定，别用
   `maxTouchPoints > 0`——带触摸屏的笔记本会因此丢掉桌面行为。手机上的点击分工（顺序即优先级）：
   顶部/底部**正文边距带**（`marginPx`，不是桌面的 64px `CHROME_EDGE`）= 开合工具条 → 左右边 = 翻页
   → 落在单词上 = 查词 → 其余空白 = 开合工具条。边带宽度**必须等于正文上/下边距**：满屏后正文从
   22px 处开始，用 64px 会把第一行整行吞掉，点它就永远开不出词典。
   横向 swipe 翻页由原生非 passive 监听实现（`touchmove` 必须能 `preventDefault`，配合
   `.reader-paged .reader-stage { touch-action: pan-y }`，**不要**改成 React 的 onTouchMove，
   那是 passive 的）。
5c. **划词工具栏由"选区"驱动，不由"手势"驱动**。`mouseup` 和 `selectionchange`（140ms 防抖）
   都走 `syncSelectionFromDom()`：手机长按只产生选区、永远没有 `mouseup`，只监听 mouseup 等于
   触摸下划词失效。
5d. **触摸端书页 = 屏幕，不是纸**。`measureAndLayout` 的 `fill` 分支（`touchPrimary`）放弃
   `PAGE_RATIO`/`OUTER_PAD`，sheet 直接取满视口，`MARGIN` 22px，并且：
   - 竖屏永远单页；横屏可用宽度超过 `MAX_COL_W` 才分两列（否则一行 40 多个汉字）。
   - `.reader-fill` 下 **不画任何"书"的装饰**：圆角、投影、书脊内阴影（`.page-sheet::after`）、
     `book-edge` 页堆全部去掉。它们表达的是"书躺在桌上"，屏幕铺满时只会变成两条灰边。
   - 翻页带收窄到 14px（`turnZoneAt`）：边距只有 22px，带宽超过它就会让点首字变成翻页。
   - 触屏一律不固定目录（268px 侧栏在 390px 屏上只剩 122px 正文），`tocDocked` 会被强制复位。
   改这块之前先跑 `D:\tmp\epub-verify\mobile.cjs`，其中"sheet 占满视口 / 边缘无渐变"几条
   就是钉这个行为的；桌面回归跑 `verify|esc|drop|shelf|vocab-schedule`。
5e. **尺寸来源是 `readViewport()`（visualViewport 优先），监听挂在阅读区根节点上**。三条铁律：
   - `measureAndLayout` 与 `useAnchoredOverlay` 都读 `readViewport()`，不要直接用
     `window.innerHeight`——软键盘弹出时布局视口和可视视口不一致，浮层会落到键盘下面。
     横向缩放（`vv.scale !== 1`）时退回布局视口，否则捏合缩放会触发重排。
   - **键盘弹出不许重排正文**：`readViewport().keyboard` 为真且高度变小时直接 return。重排会让
     写批注时页数变化、关键盘又变回来，正文跳两次。浮层自己跟着键盘走（vv 的 resize/scroll）。
   - 注册 resize / touch 监听的 effect 依赖里**必须带上 `html`**：paged 的 DOM 是章节渲染后才有
     的，只在 `[mode]` 上跑时 `stageRef.current` 还是 null，监听器会永久缺失——2026-10-23 修的
     就是这个，此前桌面拉窗口也从不重排。
5f. **浮层不能吞掉手势**。swipe 监听挂在 `.reader` 根上（不是 `.reader-stage`）：词卡和工具条是
   stage 的兄弟节点，touchstart 到不了 stage，于是"查完词想翻页"完全没反应。且**只在手势结束后
   关闭浮层**（`onEnd`），在 `touchmove` 里卸载手指下的元素会让浏览器取消整个触摸序列（touchcancel），
   翻页照样不发生。抽屉（`.drawer-mask`）是模态，手势要排除。
6. **标注定位靠字符偏移**（`startOffset/endOffset`），高亮只包裹文本、不改文本。任何改变正文长度的做法
   （内联注音、往正文插入节点）都会让历史标注集体错位。浮层必须 `position: fixed`，
   任何进入文档流的元素都会改变 `contentHeight` → 页数变化 → 读者被莫名翻页。
7. **生词是跨书资产**：`vocab.book_id/chapter_id` 只是指针，**不加外键**。书删了词还在。
8. 所有 content 目录内的文件访问走 `storage.ContentPath()`（含路径穿越防护），别自己拼路径。
9. 删除章节只从目录移除，正文文件保留（可能被别处引用）。
10. **导入只认文件路径，不接受上传**。拖放走 Wails 原生桥（`main.go` 的 `DragAndDrop.EnableFileDrop`
    + `web/src/filedrop.ts`），**不要**改用 `e.dataTransfer.files` 读文件：webview 给的 `File`
    没有路径，而且缺了原生监听连默认行为都拦不住（拖进来会把 webview 导航到那个文件）。

## 移动端（Android）

宿主是独立入口 `app/cmd/mobile`（Wails **v3**），桌面仍是 `app/main.go`（v2），两份共用一个
`internal/app.Backend` 和一份 `web/dist`；`web/src/api.ts` 按宿主选传输层。构建 **只走
`app/cmd/mobile/build-android.ps1`**（`wails3 task` 在 Windows 上跑不通，见 `app/README-mobile.md`）。

11. **只能用 arm64 真机验证，x86_64 模拟器必崩**。`modernc.org/sqlite` 经 `modernc.org/libc`
    访问文件，libc 在 amd64 上照 musl 的做法，`fstatat` 先试已废弃的 `stat`/`lstat`（系统调用
    4/6），拿不到 `ENOSYS` 才降级 `newfstatat`。Android x86_64 的 seccomp 对这两条回
    `SECCOMP_RET_TRAP`，进程直接 `SIGSYS` 死掉——**第一次碰 SQLite 就崩**，tombstone 里是
    `seccomp prevented call to disallowed x86_64 system call 6`。libc v1.74.4 / v1.79.0 都一样，
    升级解决不了。arm64 上根本没有 `lstat`/`stat`，同一条 shim 发的是 `fstatat`(79)/`fstat`(80)，
    都在白名单，所以真机没事。想改前端样式可以在 x86_64 镜像上看（资源能加载、窗口能开），
    但**任何碰数据库的功能都别在这个镜像上测**。
    c-shared 进程的 `log` 输出**进不了 logcat**，启动崩溃是静默的：`cmd/mobile/main.go` 的
    `trace()` 往 `files/trace.log` 写启动标记（含 `db.Open` 失败原因），用
    `adb shell run-as com.wails.app cat files/trace.log` 读，别指望 logcat。

## 开发约定

- **首选入口 `.\run.ps1`**（无参数打印帮助）：`dev` / `build` / `nsis` / `test` / `clean` / `web` / `install`。
  底层是 `wails dev`、`wails build`，`web` 模式**没有 Go 后端**（`window.go` 不存在），只能调样式。
- 改后端必须过：`cd app && go build ./... && go vet ./... && go test ./...`；
  改前端必须过 `cd web && npx tsc --noEmit`。改了前端还要 `cd web && npm run build &&
  node ../scripts/sync-frontend-dist.js` 才会进入二进制（`//go:embed all:frontend/dist`）——
  这个脚本按 `path.resolve('dist')` 找产物，**必须在 `web/` 下跑**，在仓库根直接跑会报
  `frontend dist not found`。
- **格式化前端只用 `npm run format`**（= `prettier --write web/src`，配置在仓库根的
  `.prettierrc.json`：单引号、`printWidth: 100`、LF）。它已经对齐过基线，是幂等的：
  跑完只会改动你手写的那几行，`npm run format:check` 永远应该全绿。
  **不要裸跑 `npx prettier --write`**：没有配置时 npx 会拉最新版 + 默认双引号 + 80 宽，
  把 40 个文件整体重写，功能 diff 直接淹没（2026-10-25 踩过一次，花了半天还原）。
  同理 **prettier 版本 pin 死**（`devDependencies` 里是精确版本，不是 `^`）：升级必须单独
  一个 commit 并同时跑一遍基线，否则格式漂移会混进下一次功能提交。
  `.prettierignore` 只管 `web/src`——Markdown 的手工折行和 CHANGELOG 的措辞比换行重要，
  `package-lock.json` 是生成物，都不该被格式化。
- **行尾统一 LF**（`.gitattributes`：`* text=auto eol=lf`，只有 `.ps1`/`.bat`/`.cmd` 是
  CRLF）。不要改成 CRLF，否则 gofmt/prettier 每写一次文件 git 就警告一次。
- **涉及 SQLite 的测试在沙箱里会卡死**，运行时要关沙箱。
- **交互回归脚本在 `D:\tmp\epub-verify`（仓库外）**：`web/dist` 起 `vite preview --port 4173`，
  用系统 Edge（`channel: 'msedge'`，**必须 `--no-proxy-server`，地址用 `localhost` 而不是 127.0.0.1**）。
  `mobile.cjs` 是 390×844 触摸用例（tap / swipe / 长按选区），`verify.cjs` `esc.cjs` `drop.cjs`
  `shelf.cjs` `vocab-schedule.cjs` 是桌面用例。**动 Reader.tsx 就要两边都跑一遍。**
- 新增依赖克制：标准库 + Wails + modernc.org/sqlite。不要为 XML/WebDAV/EPUB 引第三方库。
- **git commit 信息用英文**，Conventional Commits（`feat:` / `fix:` / `refactor:` / `docs:`）。
  一个逻辑改动一个 commit，不要攒着一起提交。
- **禁止对项目目录用 `rm`/`rmdir`**（会级联到父目录，实测把整个 `app/` 挪进回收站）。删文件用 `git rm`。

## 数据位置

`~/.epubmaker/`：`data/epubmaker.db`、`data/books/<id>/content/`、`data/trash/`、
`dict/dict.db`（词库，约 98MB / 77 万条）、`exports/`、`logs/`、`tmp/`。
`EPUBMAKER_HOME` 可整体改根路径。完整字段见 README。
