# 多平台兼容性：现状、架构与风险（PC + 手机）

> 性质：**探索文档**，2026-10-29 起稿，对应 0.4。
> 本文只回答三件事：现在是什么样、以后会撞到什么、按什么顺序做最省。
> 定下来的取舍写进 `docs/decisions.md`（ADR），必须遵守的硬约束写进 `AGENTS.md`，
> 现象→原因的排查写进 `docs/troubleshooting.md`。本文是它们的上游，不重复它们的内容。

## 0. 结论

没有做不到的平台，成本集中在三件事上，按大小排序：

1. **引擎差异**：除了 Chromium 还要吃下 WebKit。触摸、选区、键盘、字体度量、分栏测量全部要重测。
   这是日历时间的主要来源，也是唯一"改代码改不出来、只能实测"的部分。
2. **宿主能力的翻译**：每个平台对"选文件/分享/保活/权限"各有一套说法。工作量可预估，
   而且 Wails v3 已经把大部分做成了跨平台函数（见其 `IOS.md` / `ANDROID.md` 的状态表）。
3. **分发与合规**：签名、公证、上架、隐私清单。一次性投入，但等待时间不可压缩。

业务层几乎是零成本的：`internal/*` 没有平台分支，`Backend` 不依赖 Wails，
`modernc.org/sqlite` 是纯 Go，一份 `web/dist` 进所有二进制。

## 1. 现状盘点

### 1.1 宿主 × 引擎

| 宿主 | 入口 | 框架 | 渲染引擎 | 传输 | 构建 | 状态 |
| --- | --- | --- | --- | --- | --- | --- |
| Windows 桌面 | `app/main.go` | Wails v3 | WebView2（Chromium，Evergreen） | `Call.ByName`，页面 `http://wails.localhost` | `run.ps1 build` / `nsis` | 发布中 |
| macOS 桌面 | 同上 | Wails v3 | WKWebView（WebKit） | 同上 | 未建立 | 未验证 |
| Linux 桌面 | 同上 | Wails v3 | WebKitGTK | 同上 | 未建立 | 未验证 |
| Android | 同上（+ `platform_android.go`） | Wails v3 | 系统 WebView（Chromium，随 Chrome 更新） | 同上，页面 `https://wails.localhost` | `run.ps1 mobile` | 发布中 |
| iOS | 待建 | Wails v3 | WKWebView（WebKit） | 同上，页面 `wails://localhost` | 待建（需 macOS） | 未做 |

**2026-10-29 起桌面已迁到 v3**（见 ADR-22）：`app/main.go` 是唯一入口，桌面和 Android 用
`//go:build` 分开的 `platform_*.go` 提供各自的 HOME/trace，构建脚本各一份（`build-windows.ps1`
/ `build-android.ps1`），都不走 `wails3 build|dev|package`（go-task 在本机跑不了）。

两个容易忽略的事实：

- **引擎只有两种，宿主协议有两种**。Chromium = {WebView2, Android WebView}；
  WebKit = {macOS, iOS, Linux 近亲}。也就是说 WebKit 的坑做一次能吃三个平台——
  **先做 macOS 桌面版是性价比最高的 WebKit 试验田**：不用开发者账号、不用签名、不用审核，
  Web Inspector 就在手边。
- **引擎版本的下限不是 OS 版本**。Android 侧的 `minSdk 21`（5.0）只代表"装得上"，
  真正决定能不能跑的是系统 WebView 的版本，而国行机常年在 60~90 之间不动。
  iOS 相反：WebKit 跟着 OS 走，**"支持 iOS 15"就等于"WebKit 15"**，可控得多。

### 1.2 前端实际吃到的"引擎下限"

扫一遍 `web/src/styles.css` 与 `Reader.tsx`，最硬的三条：

| 特性 | 最低版本 | 用在哪 |
| --- | --- | --- |
| flex `gap` | Chromium 84 / Safari 14.1 | 几乎每个行内控件、chip 行 |
| `env(safe-area-inset-*)` | Chromium 69 / Safari 11 | 底部工具行、浮层 |
| `backdrop-filter` | Chromium 76 / Safari 9（`-webkit-` 前缀） | 顶部工具条、面板 |

结论：**实际门槛 = Chromium 84+ / Safari 14.1+**。所以 iOS 15 的下限够用；
Android 的 `minSdk 21` 属于纸面数字，建议把明面下限提到"WebView ≥ 84"对应的版本，
或至少在启动时检测并给一句人话提示，而不是白屏。

另一个小坑：`scrollbar-width: none` 只有 Chromium 认得，**隐藏滚动条必须配
`::-webkit-scrollbar { display: none }`**。`.lib-tags` 现在配了，新增横向滚动区别只写一行。

## 2. 分层：共享什么，分叉什么

```
              ┌────────────── 一份 web/dist ──────────────┐
业务层     Go   internal/{epub,library,dict,vocab,storage,db}   0 处平台分支
           JS   pages/ components/（只通过 api.ts 访问后端）
              └────────────────────┬─────────────────────┘
                                   │  api.ts（前端唯一分叉点）
宿主能力   前端  host/capabilities：选文件 / 分享 / 剪贴板 / 键盘 / 提示
           Go   internal/platform：Dialogs / Storage / Share / Device
              └────────────────────┬─────────────────────┘
                                   │  每个平台一份实现
宿主壳      v3 桌面（Windows 已建）   v3 Android        v3 iOS
           文件对话框、拖放、文件关联   SAF、SEND、FGS     UIDocumentPicker、Share
```

三条边界要守住：

1. **业务层不许出现平台判断**。`internal/app` 今天没有一处 `runtime.GOOS` 分支，
   这个性质比"少写代码"更重要：它保证新平台不会把老平台改坏。
2. **平台差异只允许出现在两处**：`web/src/api.ts` 与 `internal/platform`。
   现在前端已有三个分叉（`call` / `callApp` / `pickAndroid` + `canShareEpubFile`），
   后端有两条导出路径（`ExportBook` 的 base64、`ExportBookFile` 的路径 + 原生分享）。
   每加一个平台，分叉是乘法增长——收敛方案见 §5。
3. **`web/dist` 只有一份**。同一份产物进所有二进制，靠运行时探测而不是构建期开关。
   这是"再加一个平台"的成本能压在交互层的前提，别为某个平台单独出 bundle。

## 3. 兼容性问题只有五类

命名成 E/H/R/D/L，风险清单、ADR、checklist 都引用这一套编号。

| 类 | 问题域 | 典型症状 | 谁负责修 |
| --- | --- | --- | --- |
| **E** engine | 渲染引擎 | 位置差 1px、手势不触发、长按弹系统菜单 | 前端 CSS/JS |
| **H** host | 宿主能力 | 按钮点了没反应、选不到文件、后台被掐 | 宿主壳 + 平台 API |
| **R** runtime | 运行时判定 | 启动就"后端尚未就绪" | `api.ts` / `main.go` |
| **D** data | 路径与存储 | 库是空的、数据在意外位置、备份被撑大 | 启动代码 |
| **L** legal | 分发与合规 | 审核被拒、装不上、签名失效 | 工程配置 |

## 4. 风险清单

标注：**已修** / **待做** / **需实测**。前两类是已知的、有证据的，第三类只能上机确认。

### R 运行时判定

| # | 问题 | 现在 | 处理 |
| --- | --- | --- | --- |
| R1 | 宿主判定：`isDesktopHost()` = UA 不含 `Android` | iOS 的 UA 也不是 Android → 走桌面分支（`App.SelectEpubFiles` → `Dialog.OpenFile`），在 iOS 上语义未必成立 | **需实测**：iOS 要么确认桌面分支可用，要么改判 `location.protocol === 'wails:'` |
| R2 | 绑定名是全限定字符串 `epubmaker-desktop/internal/app.Backend` | 改模块路径会静默断链，表现为所有调用都"方法不存在" | 与 `go.mod` 保持同步；测试里断言一次 |
| R3 | `window.wails` 的形状与 `@wailsio/runtime` 文档不一致 | 真机上只有 `invoke/invokeAsync/log`，`wails.Call` 是 undefined | 走 `import('/wails/runtime.js')` 拿 `Call`（见 `web/src/api.ts` 的 `loadV3Runtime`） |
| R4 | 桌面窗口之外的浏览器预览没有宿主 | `import('/wails/runtime.js')` 404 → 一句"后端未就绪" | 前端所有数据都该走 `api.ts`；`api.ts` 只在注入缝（`window.go` mock）下放行，不做第二套传输 |

### D 数据与路径

| # | 问题 | 现在 | 处理 |
| --- | --- | --- | --- |
| D1 | `androidAppHome()` 用 `/proc/self/cmdline` 推包名 | iOS 无此文件 → 回退 HOME（沙盒根，语义错误） | **待做**：`//go:build ios` + `application.IOS.StoragePath()`（Application Support） |
| D2 | 数据根：桌面 `~/.epubmaker`，Android `<files>/.epubmaker`，iOS 待定 | 三处不同语义 | 由 `config.AppHome` 吸收，业务层只认 `config.Get().AppHome`（现状已如此，别破坏） |
| D3 | iOS 的 `Documents` 对用户可见且进 iCloud 备份 | 98MB 词库 + 书库全进备份，体积级膨胀 | 数据放 Application Support；只有用户要拿走的（导出的 epub）进 Documents |
| D4 | 导出暂存在 `tmp/export`，24 小时清理 | iOS 的 `tmp` 会被系统随时清空，不能当稳定位置 | 分享前重建，失败重试一次 |

### E 引擎差异（WebKit 为主）

| # | 问题 | 症状 | 对策 |
| --- | --- | --- | --- |
| E1 | 字体与度量不同（Noto vs SF/PingFang） | 行高、断行位置、软连字符断点全变 → 页码不同 | 分页是运行时测量，逻辑自洽；**跨章 peek 的几何对齐必须重测**（ADR-18） |
| E2 | 长按触发系统 callout / 放大镜 / 选区手柄 | 自定义长按取词被系统菜单抢走 | `-webkit-touch-callout: none`；`user-select` 只在 `allow-sel` 时打开（现状已如此） |
| E3 | 橡皮筋回弹 | 整页会弹，而翻页的所有假设都是"纸面静止" | iOS 关 `DisableBounce`；`overscroll-behavior: none`（Safari 16+） |
| E4 | 侧滑返回手势与翻页抢手势 | 从右边缘滑动变成"返回"，翻不动页 | 不开 `EnableBackForwardNavigationGestures`；历史返回用页面内按钮 |
| E5 | 键盘是**覆盖**而非 resize | 查词卡/批注浮层落到键盘下面 | `IOS.SetKeyboardWatch` + `common:keyboard` 的 inset；`readViewport()` 已有 vv 逻辑，需要多接这一路 |
| E6 | `a[download]` 无效 | 导出点了没反应，且不报错 | `IOS.Share` 替代；`canShareEpubFile()` 扩展到 iOS |
| E7 | `<input type=file>` 没有 `WKUIDelegate.runOpenPanel` | 以后加文件输入会静默失效 | 一律走 `Dialogs.OpenFile`（现状已如此，写进 checklist） |
| E8 | `scrollbar-width` 不认 | 横向 chip 行露出滚动条 | 永远配 `::-webkit-scrollbar { display:none }` |
| E9 | `100vh` / `innerHeight` 语义不同 | 键盘或工具栏弹出时高度不一致 | 已改用 `readViewport()`（visualViewport 优先），保持 |
| E10 | 自定义 scheme 下 `localStorage` 的持久性 | 设置项可能每次重启丢失 | **需实测**：iOS 上"改字号 → 杀进程 → 重进" |

### H 宿主能力

| # | 能力 | Android 现在 | iOS 做法 | 成本 |
| --- | --- | --- | --- | --- |
| H1 | 选文件导入 | SAF + 复制到 cache | `Dialogs.OpenFile`（UIDocumentPicker，`asCopy`） | 免费 |
| H2 | 导出分享 | `ExportBookFile` + `EpubMakerNative.shareExport`（FileProvider） | `IOS.Share` | 0.5 天 |
| H3 | 别的 App 把书分享进来 | SEND/VIEW intent | Wails 没有 openURL 钩子 → 改生成工程或做 Share Extension | 1–3 天，可延后 |
| H4 | 发音 | 有道在线音频 + `speechSynthesis` 兜底 | WKWebView 自带语音，反而更强 | 0 |
| H5 | 系统事件（电量/网络/主题/锁屏） | BroadcastReceiver | `events.IOS.*` | 免费 |
| H6 | 本地网络传书 | 8787 端口 + 前台服务保活 | `NSLocalNetworkUsageDescription`；锁屏/后台即断 | 0.5 天 + 体验妥协 |
| H7 | 从相册选封面 | 其实也是 SAF（Files） | 同上；真"相册"要自己写 PHPicker | 1–2 天，可选 |
| H8 | 返回键 | `onBackPressed` → 页面回答（`window.__wailsBack`） | 无返回键，全走页面内路径 | 0 |

## 5. 架构建议：把"平台"挤到最边缘

现在的分叉已经有点散：前端三处判断 + 两个导出方法 + 一个 `EpubMakerNative`。
再加一个平台，判断就会长到业务组件里。建议分两步收。

**第一步（前端）**：把 `api.ts` 里已有的判断收成一张能力表，业务只问能力、不问平台。

```ts
// web/src/host.ts
export type Host = {
  kind: 'desktop' | 'android' | 'ios';
  canPickFiles: boolean;
  canShareFile: boolean; // 有系统分享就用它，没有才退回 data URL 下载（桌面临时兜底）
  shareFile(path: string, name: string): void;
  pickFiles(multiple: boolean, title: string): Promise<string[]>;
};
```

组件里只写 `if (host.canShareFile) host.shareFile(...)`；`wails.localhost` 这类字面量
收敛到这一处。

**第二步（Go）**：把宿主能力从 `app` 包抽出来，`Backend` 只依赖接口。

```go
// internal/platform/platform.go
type Host interface {
    StorageRoot() string // 数据根目录，各平台不同
    PickFiles(title string, multiple bool) ([]string, error)
    ShareFile(path, name string) error
}
```

桌面注入 `Dialog.OpenFile` 实现，移动注入各平台实现，`internal/app` 里不再出现 `if mobile`。
好处不是代码变短，而是**新平台只实现一个接口，不需要动业务**。

## 6. 双宿主已收成 Wails v3（2026-10-29，ADR-22）

原来桌面 v2 + 移动 v3，两套绑定（`window.go` vs `Call.ByName`），`api.ts` 靠运行时判定兼容。
当时写的「短期不建议迁」列了三条理由，逐条看现在都不成立了：

- 「迁 v3 要重做 `run.ps1`、NSIS、文件关联」—— 实际只花了这些钱，而且是一次性的：
  `build-windows.ps1` / `dev-windows.ps1` 替掉了 `wails build|dev`，NSIS 模板只是换了传参方式
  （`-DINFO_PRODUCTVERSION`），文件关联从 `wails.json` 搬到 `application.Options.FileAssociations`。
  **v2 一共只在两个 Go 文件、六处调用里被用到**，`Backend` 与 `webassets.Handler` 本来就是宿主无关的。
- 「v3 还是 beta，把桌面押上去风险翻倍」—— 风险的真实来源是**两套传输要各写一遍、各测一遍**。
  迁移后绑定只有一个形状，前端那份"运行时判定兼容"的代码整段删掉了。何况 v3.0.0 已在
  2026-10-26 转正式版，这条连字面都不成立了（beta.34 → 3.0.0 只有 5 个修复、没有公共 API 变化，
  升级就是把 `go.mod` 改一行）。**但要说清楚**：稳定承诺只覆盖 Windows / macOS / Linux 桌面，
  Android 与 iOS 在 3.0.0 里仍是 experimental，我们的手机端不在那个承诺里。
- 「抽 capability 层就能解决大部分」—— §5 仍然值得做，但它解决的是"加平台"，不是"少一套传输"。

**代价**：`wails3 build|dev|package` 用不了（go-task 在本机跑不动脚本），所以构建链是自写的；
Wails CLI 只剩两个用途——`generate syso`（图标/清单/版本资源）和 `android overlay:gen`。
版本号也从 `wails.json` 挪到 `app/build/config.yml`，两个脚本各自 `-X` 注入 `AppVersion`。

## 7. 验证策略

三层，越往下越贵，所以尽量把问题往上层压。

| 层 | 覆盖 | 工具 | 能发现 |
| --- | --- | --- | --- |
| 1 布局/逻辑 | 引擎差异（不含触摸） | Playwright（Chromium 用系统 Edge，WebKit 用 Playwright 自带内核）+ 现有 mock（`D:\tmp\epub-verify`） | 大部分 E、CSS 兼容、页码计算 |
| 2 真实桌面 | WebView2 / WKWebView 的真实行为 | 手动 + `run.ps1 web` | E3、E5、性能、字体 |
| 3 真机 | 触摸语义、系统手势、键盘 | Android：`adb` + CDP（`D:\tmp\phone.mjs`）；iOS：macOS + Safari Web Inspector / XCUITest | E2、E4、长按、翻页、双击缩放 |

两条经验：

- **同一套 mock 断言换引擎跑**，成本几乎为零（脚本形状不用改），是提前暴露 WebKit 差异最便宜的
  办法。建议给 `mobile.cjs` / `three-rows.cjs` 加一个 `--engine=webkit` 开关。
- **iOS 没有 `adb + CDP` 的等价物**：真机回归只能在 macOS 上做（Safari 的 Develop 菜单 attach
  WKWebView，或 XCUITest / Appium）。这决定了 iOS 的"改一行验一遍"比 Android 贵，
  也就决定了 iOS 的功能要**按块验证**，不是按行。

## 8. 路线图

| 阶段 | 内容 | 前置 | 估时 | 产出 |
| --- | --- | --- | --- | --- |
| P0 | 抽 capability 层（纯重构，行为不变） | — | 1–2 天 | `host.ts` + 回归全绿 |
| P1 | macOS 桌面 | P0 | 2–3 天 | WebKit 真机试验田，签名 + 公证跑通 |
| P2 | Linux 桌面 | P0 | 1–2 天 | webkitgtk 4.1、AppImage |
| P3 | iOS 只读闭环（导入/阅读/取词/翻页/词典） | P1 的 WebKit 结论 | 8–10 人日 | TestFlight |
| P4 | iOS 对齐（导出/分享/键盘/相册）+ 上架 | P3 | 10–15 人日 | App Store |
| P5 | ~~桌面迁 v3~~ | 已于 2026-10-29 完成（ADR-22） | — | 一份 `main.go`、一套绑定 |

P1 排在 P3 前面的理由：iOS 上每个"能不能"的问题（长按能不能抑制、翻页手感、字体度量会不会
把页码打乱）**在 macOS 上用同一份代码就能先问一遍**，还不用等审核、不用买账号。
唯一在 macOS 上测不到的是触摸与键盘覆盖——恰好是 P3 里最贵的部分，所以 P3 仍然要真机。

## 9. 新增平台检查清单

给下一个平台（Linux / iOS / 未来的 iPad）用，逐条过，别跳：

- [ ] 引擎内核与版本下限（Chromium ≥ 84 / Safari ≥ 14.1）写进 README
- [ ] 运行时判定：`isDesktopHost()` 在该平台上落到正确分支（R1）
- [ ] 数据根目录：`EPUBMAKER_HOME` 有值、`db.Open` 成功、杀进程重进库还在（D1–D3）
- [ ] 选文件导入：能选中 epub、路径可读、重复导入按"已存在"处理
- [ ] 导出：文件落到暂存目录 + 系统分享弹出（H2）
- [ ] 发音：在线音频可达（HTTPS）；断网时有兜底
- [ ] 长按取词 / 选区工具栏：位置在视口内，不被系统菜单抢（E2）
- [ ] 翻页：横向 swipe 生效、边缘不触发系统手势、无橡皮筋（E3、E4）
- [ ] 键盘：查词卡/批注浮层跟着键盘走，正文不重排（E5、ADR-17）
- [ ] 安全区：底部工具行不被 home indicator / 手势条盖住
- [ ] 滚动条不露出；横向行能拖到屏幕边缘（E8）
- [ ] 深色/浅色跟随系统
- [ ] 后台/锁屏：正在做的事（传书、导出）有明确的中断行为（H6）
- [ ] 字体：中英文混排无 fallback 突变，页码稳定（E1）
- [ ] 包体与首屏：词库不进包（98MB），首次启动 < 2s
- [ ] 签名/分发：能装、能升级、卸载干净
- [ ] 文件关联：.epub 双击/分享能进得来，或明确写"不做"（H3）
- [ ] 隐私清单 / 权限文案与实际行为一致（只声明真正用到的）

## 10. 跨平台也不许破的红线

这些不是"兼容性问题"，而是**为了兼容最容易犯的错**，重申一遍：

1. **不许为了某个平台的显示效果改渲染文本**（删软连字符、内联注音、插节点）。offset 的语义是
   "当前渲染文本的第 N 个字符"，一改，所有历史标注/进度/书签订位整体错位且无法迁移。
2. **不许用 `maxTouchPoints` 判触摸**，只有 `pointer: coarse`（AGENTS.md 5b）。
3. **不许开 `NSAllowsArbitraryLoads`**：本地模型用 `NSAllowsLocalNetworking` 就够，
   前者会在审核时被追问用途。
4. **不许为 iOS 单独出一份 bundle**：一份 `web/dist` 进所有宿主，是成本可控的前提。
5. **mock 不许进二进制**：验证完必须重新 `npm run build` + `sync-frontend-dist.js`。
6. **不许把 `100vh` / `innerHeight` 直接当尺寸源**，只用 `readViewport()`（AGENTS.md 5e）。
7. **不许为某个平台改 `Backend` 方法签名**：它是前端唯一的契约。

## 附录 A 证据索引

| 事实 | 位置 |
| --- | --- |
| `Backend` 不依赖 Wails，桌面与 Android 共用同一份 `main.go` | `app/main.go` |
| Android 数据根靠 `/proc/self/cmdline` 推导 | `app/platform_android.go` 的 `androidAppHome()` |
| 前端按 host 选传输层 | `web/src/api.ts` 的 `isDesktopHost()` / `callApp()` |
| 导出只有 Android 走系统分享 | `web/src/api.ts:665` `canShareEpubFile()` |
| 内置"Ollama（本地）"预设是 `http://` | `app/internal/aiconfig/aiconfig.go:47` |
| Wails v3 的 iOS 能力矩阵与限制 | `wails/v3@v3.0.0/IOS.md` |
| iOS 页面 URL 是 `wails://localhost` | 同上 `pkg/application/webview_window_ios.m:506` |
| Android 页面 URL 是 `https://wails.localhost` | 同上 `pkg/application/application_android.go:958` |
| Android 宿主 = Wails 模板 + 定制 | `app/README-mobile.md` |
| 触摸语义、分页不变量 | `AGENTS.md` 5b–5f；`docs/decisions.md` ADR-3 / ADR-18 / ADR-21 |

## 附录 B 名词

- **宿主（host）**：承载 WebView 的原生程序。本文指 v3 桌面壳 / v3 Android 壳 / v3 iOS 壳。
- **引擎（engine）**：渲染并执行网页的内核，Chromium（WebView2、Android WebView）
  或 WebKit（WKWebView、WebKitGTK）。
- **能力（capability）**：抽象后的用户动作，如"选文件""分享文件"，由各宿主实现。
- **契约（contract）**：`Backend` 的方法签名 + `api.ts` 的封装，任何平台都不许为特例改动。
