# AGENTS.md

改这个项目前必读。文档各管一段，**同一件事只写一处**：

| 文件 | 只回答 |
| --- | --- |
| `README.md` | 能做什么、怎么跑、数据存在哪、目录怎么分 |
| 本文件 | 怎么改才不出错：模块职责、红线、提交前门禁 |
| `docs/decisions.md` | 当初为什么这么选（ADR-1…44），以及被否决的方案 |
| `docs/troubleshooting.md` | 按现象查：症状 → 原因 → 处理 |
| `docs/platforms.md` | 多平台兼容现状、风险清单、新增平台检查表 |
| `app/README-mobile.md` | Android 工具链、构建参数、真机调试 |

加一条新规则前先想它属于哪一格：能写成「症状 → 处理」的进 troubleshooting，能写成「当初为什么」的
进 decisions，**只有「改坏了会出事」才配进下面的红线**。红线只写结论和一句为什么，**低频机制的
细节（某个平台为什么不支持、某段握手怎么算）一律写进另一份文件再指过去**——红线是"改之前必看"的
清单，不是手册。

## 是什么

本地桌面 / 安卓应用（Wails v3，Go 后端 + React/TS 前端，WebView2 / Android WebView）：EPUB 的导入 → 阅读 → 整理 → 拆分 → 导出，
外加英文阅读学习（划词查词 + 生词本）与 AI 辅助。后端全 Go，**无 Node 服务、无 HTTP、无端口**。

| 路径 | 职责 |
| --- | --- |
| `app/internal/app` | Wails 绑定。`Backend` = 全部数据操作；`App` = 原生集成（文件对话框、命令行 .epub）；`learning.go` = 查词/生词本 |
| `app/internal/epub` | OCF/OPF/NCX/NAV 解析与流式构建（零依赖，手写 XML） |
| `app/internal/library` | 导入 / 渲染 / 导出 / 封面 / 拆分 / 书架 |
| `app/internal/dict` | 本地 ECDICT 词库：CSV 导入、归一化、词形还原、频率分级（独立 SQLite） |
| `app/internal/vocab` | 生词本 + 查词信号 |
| `app/internal/storage` | zip 内路径 ↔ 磁盘映射、回收站（软删除） |
| `app/internal/db` | modernc.org/sqlite（纯 Go，无 cgo） |
| `app/internal/{html,config,mime,webdav,opds}` | 字符串改写 / 配置 / MIME / WebDAV 客户端 / OPDS 目录解析 |
| `web/src` | React 18 + Vite。`pages/` 每页一个文件，`api.ts` 是绑定的唯一封装层，`overlay.ts` 是浮层定位算法，`usePageTurns.ts` 是阅读器的触摸手势与翻页状态机（ADR-45），`useAnchoredOverlay.ts` 是浮层贴锚点定位，`textOffset.ts` 是字符偏移与 DOM 矩形互转，`tocNav.ts` + `components/Toc.tsx` 是目录的解析与渲染（ADR-46），`useListenSession.ts` 是听书会话（ADR-47） |
| `app/cmd/dictimport` | 命令行词库安装器，与界面按钮走同一条代码路径 |

## 红线（改代码别破坏）

### 数据与资源

1. **资源主键 = 原 zip 内完整路径**。落盘 `books/<id>/content/<原路径>`，导出原样还原，章节间相对引用
   （`../images/x.png`）因此永远有效。禁止扁平化命名。
2. 所有 content 目录内的文件访问走 `storage.ContentPath()`（含路径穿越防护），别自己拼路径。
3. **SQLite 层只用位置参数 `?`**，事务手写 `BEGIN`/`COMMIT`，`SetMaxOpenConns(1)`。别用命名参数或驱动特有的封装。
4. 删除章节只从目录移除，正文文件保留（可能被别处引用）。
5. **生词是跨书资产**：`vocab.book_id/chapter_id` 只是指针，**不加外键**。书删了词还在。
6. **标注定位靠字符偏移**（`startOffset/endOffset`），高亮只包裹文本、不改文本。任何改变正文长度的做法
   （内联注音、往正文插入节点）都会让历史标注集体错位。浮层必须 `position: fixed`，
   任何进入文档流的元素都会改变 `contentHeight` → 页数变化 → 读者被莫名翻页。

### 宿主与传输

7. **没有 HTTP、没有端口**。前端只用进程内绑定（`web/src/api.ts` 的 `Call.ByName`，运行时由宿主自己的
   `/wails/runtime.js` 提供）；二进制（封面/图片/渲染章节/导出）一律内联 base64。禁止引入 `/api` 路由、
   TCP 监听、multipart 上传。
   **出站请求是另一回事**（现存三个实现：`internal/webdav`、`internal/opds`、`internal/dict/online.go`），
   新加一个必须同时满足三条——(a) 由用户的显式动作触发，不在打开页面时偷偷发；(b) 有超时，失败不阻塞
   UI；(c) 结果落本地（`dictcache` 那张表），同一个词不重复问。**OPDS 只读目录 XML 与 epub 文件，不做书源
   引擎**——边界、`PickEpub` 唯一实现、生词本补全的墓碑逻辑见 ADR-42；在线书库「一行一个动作」「下载前
   先确认」「`busyRows` 按行记状态、允许并发」见 ADR-26 / ADR-27。
8. **导入只认文件路径，不接受上传**。拖放走原生（`EnableFileDrop` → `WindowFilesDropped` →
   `epub:dropped` 事件，`web/src/filedrop.ts` 订阅），**不要**读 `e.dataTransfer.files`：webview 给的
   `File` 没有路径，缺了原生监听连默认行为都拦不住。为什么见 ADR-9。

### 正文渲染

9. **正文渲染后必须 DOMPurify 净化**，且只经 `library.RenderChapter` 改写资源链接。清理时
   `FORBID_ATTR: ['class','id']`——epub 自带的 `id="root"` 会抢宿主的 `#root`。因此**章节 HTML 里永远
   不要指望 `id`**：nav 指向的 `#filepos…` 由 `RenderChapter` 改写成 `data-anc`（`data-*` 默认放行），
   前端用 `[data-anc="…"]` 查、`sentence.ts` 的 `anchorOffset()` 换成文本偏移再落页。

### 阅读器

10. **分页阅读器翻页不做动画**：章内翻页是一次 `setPageIndex` + `translate3d`，禁止 3D 翻页/卷曲/投影；
    一次翻页只允许一个活动图层，**绝不能复制整章 HTML**。章节切换保留 130ms 淡入淡出（盖住异步加载空窗）。
11. **触摸设备没有 hover，每个靠悬停的入口都要有 tap 等价物**。`device.ts` 的 `isTouchPrimary()`
    （`pointer: coarse` / `hover: none`，且 `any-pointer: fine` 为假）是唯一判定：阅读器的
    `touchPrimary`、书架的卡片交互都 import 这一份，**不要在页面里另抄一份**——抄出来的第二份
    总有一天只改一边，症状是同一个手势在一个页面能用、在另一个页面失灵。别用
    `maxTouchPoints > 0`——带触摸屏的笔记本会因此丢掉桌面行为。手机上的点击分工只有一条规则：
    **点按永不翻页，翻页只由横向 swipe 承担**。`routeTap()` 是唯一的点击路由器，两个模式共用，
    顺序即优先级：词卡外点关闭 → 划线开弹层 → 落在词上查词 → 其余开合工具条。两个模式只有
    **一条**差异，写在路由器内部：滚动模式只有中间 1/3 开合工具条（滚动时点按常是滑动的尾巴，
    全屏弹菜单读起来像 bug），分页模式任意点都开。别把这句差异复制成第二份点击处理——
    scroll 的 `click` 监听现在只是把坐标交给 `routeTap`，它自己不再判断区域。
    关词卡的那一次点按**什么都别做**：`mouseup` 关卡片后浏览器还会补一个 `click`，它属于关卡片，
    不该顺手查掉手指底下的词（scroll 的那套监听器不随卡片打开而重注册，所以它问 DOM
    `.dict-card` 而不是问状态变量）。长按命中词是"选中"，
    **长按没命中仍算一次点按**（`lpArmed` / `lpFired` 两个变量，只有后者能吞掉点按）。
    不要再引入"左右边 = 翻页"或"顶/底边距带 = 开合工具条"——那正是"歪一点就翻页"的来源，
    几何与理由见 ADR-43。`turnZoneAt()` 的 14px 带只服务鼠标拖动，触摸路径不调用它。
    横向 swipe 由原生非 passive 监听实现（`touchmove` 必须能 `preventDefault`，配合
    `.reader-paged .reader-stage { touch-action: pan-y }`，**不要**改成 React 的 onTouchMove，
    那是 passive 的）。**手势 handler 读 ref，不读闭包**：`pageIndex`/`pageCount`/邻居章节
    一律经 ref，effect 依赖里只该出现 `mode`——图片加载完 `setPageCount` 就会重挂 effect，
    重挂会钉回页面并作废 `active`，正在滑的那一页"弹回去且手势失效"。漏掉这条时的样子：
    `dragAvailable()` 一直读闭包里的 `pageIndex`，翻到章末再拖还以为自己在第一页，
    "这一拖是翻页还是换章"整个判反（`pageturn-chapter` 9 条红，2026-11-01 改成 `pageIndexRef`）。
12. **划词工具栏由"选区"驱动，不由"手势"驱动**。`mouseup` 和 `selectionchange`（140ms 防抖）
    都走 `syncSelectionFromDom()`：手机长按只产生选区、永远没有 `mouseup`，只监听 mouseup 等于
    触摸下划词失效。
13. **下拉贴标签：只在 paged 模式，"松手"才是写入**（ADR-39）。三条最容易改坏的：跨过阈值只改外观
    （`.page-tag-wrap[data-armed]` + 一次 `vibrate(8)`），写库发生在 `touchend`，`touchcancel` /
    换页 / 旋转一律回缩不写；**短拖不是点击**（`pulling` 为真时 `onEnd` 直接返回，不能落到
    `routeTap`）；标签高度只有 CSS 的 `.on` 与手势的 inline `height` 两个写入者，松手就是删掉那个
    inline height。真相只有 `AddBookmark`/`DeleteBookmark` 那一行，别给标签另建状态或字段。
    门禁：`D:\tmp\epub-verify\pull-mark.cjs`（26 项）。
14. **触摸端书页 = 屏幕，不是纸**。`measureAndLayout` 的 `fill` 分支（`touchPrimary`）放弃
    `PAGE_RATIO`/`OUTER_PAD`，sheet 直接取满视口，`MARGIN` 22px，并且：
    - 竖屏永远单页；横屏可用宽度超过 `MAX_COL_W` 才分两列（否则一行 40 多个汉字）。
    - `.reader-fill` 下 **不画任何"书"的装饰**：圆角、投影、书脊内阴影（`.page-sheet::after`）、
      `book-edge` 页堆全部去掉。它们表达的是"书躺在桌上"，屏幕铺满时只会变成两条灰边。
    - 翻页带收窄到 14px（`turnZoneAt`）：边距只有 22px，带宽超过它就会让点首字变成翻页。
    - 触屏一律不固定目录（268px 侧栏在 390px 屏上只剩 122px 正文），`tocDocked` 会被强制复位。
15. **尺寸来源是 `readViewport()`（visualViewport 优先），监听挂在阅读区根节点上**。三条铁律：
    - `measureAndLayout` 与 `useAnchoredOverlay` 都读 `readViewport()`，不要直接用
      `window.innerHeight`——软键盘弹出时布局视口和可视视口不一致，浮层会落到键盘下面。
      横向缩放（`vv.scale !== 1`）时退回布局视口，否则捏合缩放会触发重排。
    - **键盘弹出不许重排正文**：`readViewport().keyboard` 为真且高度变小时直接 return。重排会让
      写批注时页数变化、关键盘又变回来，正文跳两次。浮层自己跟着键盘走（vv 的 resize/scroll）。
    - 注册 resize / touch 监听的 effect 依赖里**必须带上 `html`**：paged 的 DOM 是章节渲染后才有
      的，只在 `[mode]` 上跑时 `stageRef.current` 还是 null，监听器会永久缺失——2026-10-23 修的
      就是这个，此前桌面拉窗口也从不重排。
16. **浮层不能吞掉手势**。swipe 监听挂在 `.reader` 根上（不是 `.reader-stage`）：词卡和工具条是
    stage 的兄弟节点，touchstart 到不了 stage，于是"查完词想翻页"完全没反应。且**只在手势结束后
    关闭浮层**（`onEnd`），在 `touchmove` 里卸载手指下的元素会让浏览器取消整个触摸序列（touchcancel），
    翻页照样不发生。抽屉（`.drawer-mask`）是模态，手势要排除。
17. **目录只有两种视图，各自忠实于自己的来源，不做拼接**：`目录` = 书自带的 nav/NCX 原样，`文件` =
    spine 一份文档一行。**不要**再把 nav 没点名的章节「织回」树里（ADR-31 已废弃：会凭空多出一行
    「书名」、一份文档里两个小节同时高亮）。两种粒度别混：`chapters` 是 spine 文档，`books.toc` 是
    nav 小节，`flattenTOC` 的键必须 `docKey()`（去 `#fragment`）。高亮永远只有一行，取「锚点已越过
    当前屏底」的最后一个（`offsetAfterLastPage()`）。详见 ADR-36。

### 界面

18. **一次只开一个底部弹层**（ADR-40）。`.sheet-mask` 全是 `inset:0` + `align-items:flex-end` +
    同一个 `z-index`，所以 DOM 里靠后的那层收点击。叠两层的结果不是"上面盖住下面"，而是**下层抢走
    上层输入框的点击** —— 表现成"点输入框没有键盘"（`document.activeElement` 压根不是那个 `input`）。
    换层要把来处写进状态（`ShelfDialog.returnTo: 'shelf' | 'move'`），取消时再放回去；别指望
    "下面那层还开着"能自动恢复。
19. **书架是一对多的容器，锁的边界在后端**（ADR-40）。`shelves` 表 + `books.shelf_id`，与
    `books.tags`（多对多、纯字符串）**正交**：别拿标签当书架——标签挂不了密码、也表达不了唯一归属。
    - **迁移只改一行 `shelf_id`**，别改成"按书架分目录存放"（会把一次 `UPDATE` 变成搬文件 + 断掉
      所有相对引用）。
    - **过滤必须在数据层，不在界面**：`ListBooks`、`GetBookRow`（导出 / 拆分 / 改名 / 换封面 /
      目录的共同上游）、`GetChapterRow`、`ListChapters`、`ListAssets`、`AssetFilePath`、
      `GetProgress`、`SaveProgress`、`AddBookmark`、`AddAnnotation`、`ListAllBookmarks`、
      `ListAllAnnotations`、`ListTrash`。前端过滤只是化妆。锁状态只在 `library` 包内存里、不落库。
    - **新增一个以 book id 取数的入口，就要加一行 `requireUnlocked`**（按自身 id 寻址的书签/批注用
      `requireUnlockedRow`）。守卫本身在 `GetBookRow` 里，新调用者会继承；`TestLockedShelfRefusesEveryExit`
      枚举全部出口，漏一个就红（ADR-52）。别在 SQL 里拼 `shelf_id NOT IN (…)`——子查询的漏点更难数。
    - 加锁只断言 `ErrShelfLocked` 还不够：`UpdateBook` 是**先写库再拿 `GetBook` 的返回值报错**的，
      测试要同时核对数据没动（`assertShelfUntouched`）。
    - **解锁只对这一次访问有效**：离开书架（`applyShelf` 切走）必须 `LockShelf(旧 id)`，`leaveLockRef`
      存着这次的 promise，`pickShelf` 切换前先 `await` 它。否则表现成"密码要重启才生效"。
    - 锁定书架**也不能写**；前端的 `locked` 可能是上一次会话的，判断前先 `loadShelves()`。
    - 系统分享 / Wi-Fi 分享一律落默认书架（`resolveImportShelf` 兜空、未知、锁定 id）。
    - 忘记密码**没有自助恢复**：逃生口是 `UPDATE shelves SET pw_hash='' WHERE id='…'`（不放进界面）。
    - `shelfCache` 必须按 `shelfId` 键控，否则切书架会先闪出上一个书架的书——那是泄密。
    - 门禁：`D:\tmp\epub-verify\shelves.cjs`（54 项）+ `app/internal/library/shelves_test.go`（9 个）
      + `app/internal/library/lock_guard_test.go`（33 个出口）。导出必须离开 WebView：桌面走原生保存
      对话框（`App.ExportBookTo`），手机走 staging 文件 + 分享面板，判断集中在 `web/src/exportEpub.ts`；
      门禁 `export-file.cjs`（8 项）。

### Android

20. **只能用 arm64 真机验证，x86_64 模拟器一碰 SQLite 就死**。`modernc.org/libc` 在 amd64 上先试
    已废弃的 `stat`/`lstat`，Android x86_64 的 seccomp 回 `SECCOMP_RET_TRAP`，进程直接 `SIGSYS`；
    升级 libc 解决不了（v1.74.4 / v1.79.0 都一样）。只改前端样式可以在 x86_64 镜像上看，**任何碰
    数据库的功能都别在这个镜像上测**。另外 c-shared 进程的 `log` 进不了 logcat，启动标记在
    `files/trace.log`。两项细节见 `app/README-mobile.md`。
21. **路由必须由 `internal/webassets` 回退到 `index.html`，别换回 `application.AssetFileServerFS`**，
    且 Java 侧要把**主框架**的 MIME 强制成 `text/html`——缺任何一半，安卓整页导航到深链接就是
    `net::ERR_CONNECTION_REFUSED`（宿主把"没有字节"映射成 `null`，Chromium 不当 404 而是去问网络）。
    为什么见 ADR-41。
22. **朗读只能走原生 `EpubMakerTts`，别指望 `speechSynthesis`**。本机 WebView 的
    `getVoices()` 返回空数组，Web 端再怎么写都是静音。桥在
    `app/cmd/mobile/build/android/app/src/main/java/com/wails/app/TtsBridge.java`
    （`@JavascriptInterface`，`MainActivity` 里 `addJavascriptInterface(..., "EpubMakerTts")`），
    事件从 `UtteranceProgressListener` 回到 `window.__epubTts`。改这里要连着 `styles.css` 的
    `.listen-marks` / `useListenSession.ts` 的 `pumpListen` 一起想：**熄屏后 JS 会冻结**，所以系统引擎
    一次把整章入队，靠 `start` 回调推进，`done` 不翻页。
23. **听书会话的所有权在阅读器手上，不在引擎手上**（ADR-38）。三条：会话由
    `setNowPlaying({active,...})` 声明，**别把 `startSession()` 挪回 `speakNow()` 里**——在线音色
    （`TtsEdge` + `<audio>`）根本不经过原生 TTS，挪回去就熄屏即死；通知栏按钮只把
    `window.__epubListen('toggle'|'prev'|'next'|'stop')` 交回 JS（`TtsBridge.dispatchCommand`），
    Java 不判断播放状态，加按钮 = 加 action 常量 + `useListenSession.ts` 的 `onListenCommand` 分支；队列
    见底**不等于**会话结束，`finished()` 只排一个 90 秒 `drainGrace`（换章那几秒全靠它保护），只有
    没人再说话或 `clear()` 才真正收掉。通知只在看得见的变化上更新，别往 payload 里塞"第 n 句"。
    门禁：`listen-native.cjs`（桌面跑桥的上下行）、`listen-follow.cjs`（跟随 / 标记 / 跳句带页）+ 真机 `listen-device.mjs`。
24. **Edge 音色的握手是 `Sec-MS-GEC` v2，别自己改算法**。`app/internal/app/edge_token.go` 是
    `edge-tts` 7.3.1 `drm.py` 的逐行移植，`tts_test.go` 钉着三组上游向量。403 了就照新版重新对照
    移植并重钉，不是"清理"成普通 SHA-256——旧算法早被拒了。私有接口，不在稳定承诺内。
25. **在线音色一个播放器只许有一个 `<audio>`，`stop()` 必须先结算在途 promise**；缓存是双上限
    （24 条 **且** 4 MB base64），退出阅读器清空；听书日志（cat=`tts`）只记异常与每 20 句的统计，
    逐句一条会在十分钟内把 300 条环形缓冲刷满。为什么见 ADR-33。

## 移动端（Android）

**只有一个宿主、一份 main**：`app/main.go` 同时是桌面和安卓的入口，平台差异只落在
`platform_android.go`（`EPUBMAKER_HOME` 与 `trace.log`）与 `platform_desktop.go`（空实现）两个文件。
工具链、`build-android.ps1` 的各个开关、真机调试手法全在 **`app/README-mobile.md`**，这里只留两条会
改坏的：

- **CLI 与模块版本必须钉在同一版**（`app/go.mod` 的 `github.com/wailsapp/wails/v3 v3.0.0` ↔
  `go install …/cmd/wails3@v3.0.0`）：`generate syso` 与 `android overlay:gen` 生成的东西是给这个版本
  的库用的，只升一半会得到"编译过、链接炸"的错位。当前 v3.0.0（桌面三平台在稳定承诺内，
  Android/iOS 仍是 experimental）。
- **不要走 `wails3 build|dev|package`**：它们只是 go-task 的壳，本仓库需要的 shell wrapper 在 Windows
  上跑不通（`gradlew` 无扩展名、`gradlew.bat` 也被拒）。用 `run.ps1`，CLI 只留上面那两条生成命令。

## 开发约定

- **首选入口 `.\run.ps1`**（`dev` / `build` / `nsis` / `mobile` / `mobile-install` / `test` / `clean`
  / `web` / `install`；各子命令做什么见 README）。它只做转发：`build` → `app/build-windows.ps1`，
  `dev` → `app/dev-windows.ps1`，`mobile` → `app/cmd/mobile/build-android.ps1`。
- **提交前门禁**：改后端 `cd app && go build ./... && go vet ./... && go test ./...`；改前端
  `cd web && npx tsc --noEmit`。改了前端还要 `cd web && npm run build && node ../scripts/sync-frontend-dist.js`
  才会进入二进制（`//go:embed all:frontend/dist`）——这个脚本按 `path.resolve('dist')` 找产物，
  **必须在 `web/` 下跑**，在仓库根直接跑会报 `frontend dist not found`。
- **交互回归脚本在 `D:\tmp\epub-verify`（仓库外）**：`web/dist` 起 `vite preview --port 4173`，
  用系统 Edge（`channel: 'msedge'`，**必须 `--no-proxy-server`，地址用 `localhost` 而不是 127.0.0.1**）。
  桌面向：`verify` `esc` `drop` `shelf` `vocab-schedule`；触摸向：`mobile.cjs`（390×844，tap / swipe /
  长按选区）；按功能：`shelves`（多书架）、`pull-mark`（下拉贴标签）、`listen-native`（听书桥）、
  `barfit`（听书条形不省略）、`listen-follow`（跟随 / 标记 / 跳句带页）。**动 `Reader.tsx`、
  `usePageTurns.ts`、`textOffset.ts`、`useAnchoredOverlay.ts` 或 `useListenSession.ts` 就要桌面向与
  触摸向都跑一遍**（翻页与手势另加 `pageturn-chapter` / `pageturn-drag` / `turn-sensitivity` /
  `tap-hold` / `scroll-tap` / `progress-hide`），具体条数与要钉住的断言写在各条红线里。
- **格式化前端只用 `npm run format`**（= `prettier --write web/src`，配置在仓库根的
  `.prettierrc.json`：单引号、`printWidth: 100`、LF；已对齐基线，幂等，跑完只动手写的那几行，
  `npm run format:check` 永远应该全绿）。**不要裸跑 `npx prettier --write`**：没有配置时 npx 会拉
  最新版 + 默认双引号 + 80 宽，把 40 个文件整体重写，功能 diff 直接淹没（2026-10-25 花了半天还原）。
  prettier 版本因此**pin 死**（`devDependencies` 里是精确版本），升级要单独一个 commit 并跑一遍基线。
  `.prettierignore` 只管 `web/src`：Markdown 的手工折行、CHANGELOG 的措辞、生成的
  `package-lock.json` 都不该被格式化。
- **行尾统一 LF**（`.gitattributes`：`* text=auto eol=lf`，只有 `.ps1`/`.bat`/`.cmd` 是
  CRLF）。不要改成 CRLF，否则 gofmt/prettier 每写一次文件 git 就警告一次。
- **涉及 SQLite 的测试在沙箱里会卡死**，运行时要关沙箱（细节见 `docs/troubleshooting.md`）。
- **版本号单一来源 = `app/build/config.yml` 的 `info.version`**，两个构建脚本注入 `-X …AppVersion`；
  仍需手工同步：根 `package.json`、`web/package.json`、`package-lock.json`（顶层 + `packages[""]` +
  `packages.web`）、`app/internal/app/version.go` 的 `AppVersion`（裸 `go run` 用的兜底）。**新分支开工即升版本**。
  发版：日常开发在 `v<YYYYMMDD>_<目标版本>` 分支上，合并到 `main` 才发布（tag 打 `main` 的合并点）；
  `gh release create <tag>` 的正文从 CHANGELOG 抽当前版本段落（**不要** `--notes-file CHANGELOG.md`），
  发布前按 `git log <上个 tag>..HEAD` 补齐 Unreleased。
- 新增依赖克制：标准库 + Wails + modernc.org/sqlite。不要为 XML/WebDAV/EPUB 引第三方库。
- **git commit 信息用英文**，Conventional Commits（`feat:` / `fix:` / `refactor:` / `docs:`）。
  一个逻辑改动一个 commit，不要攒着一起提交。
- **禁止对项目目录用 `rm`/`rmdir`**（会级联到父目录，实测把整个 `app/` 挪进回收站）。删文件用 `git rm`。

## 数据位置

`~/.epubmaker/`（`EPUBMAKER_HOME` 可整体改根）：`data/epubmaker.db`、`data/books/<id>/content/`、
`data/trash/`、`dict/dict.db`、`exports/`、`logs/`、`tmp/`。目录树与 `config.json` 字段见 README。
