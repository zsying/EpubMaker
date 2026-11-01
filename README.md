# EpubMaker

EPUB 电子书维护与生成工具。本地运行的**桌面应用**（Wails v3，Go 后端 + React 前端），
把手上的 epub 导进来，读、改、拆、再导出去。同时兼顾英文原著的阅读与学习。
同一份 Go 后端也交叉编译成 Android 包（WebView），见 [`app/README-mobile.md`](app/README-mobile.md)。

## 功能

- **导入** —— 拖入 epub，自动解析元数据、目录、章节与全部资源
- **在线书库** —— OPDS 目录浏览：内置 Project Gutenberg，也可添加 Calibre-Web / 私有书库，挑书后下载导入
- **书架** —— 可以建多个书架，标题处一键切换；单个书架可设密码，锁上后不列书、不可写，书签与批注
  也不再出现在全局列表；书籍可批量迁到别的书架（只改归属，文件、进度、书签、批注原地不动）
- **阅读** —— 侧栏目录 + 干净的排版，记住上次读到哪一章；滚动 / 分页两种模式，横向拖动多长才翻页可调（灵敏 / 标准 / 稳重）
- **朗读** —— 系统 TTS 或在线音色逐句朗读，熄屏继续；通知栏有上一句 / 播放暂停 / 下一句
- **查词** —— 划选单词即时查本地词库：音标、中文释义、原型、发音（离线）
- **生词本** —— 查过的词自动沉淀（跨书），带原句与出处，可跳回原文
- **AI 辅助** —— 划词解释、句子拆解、章节导读、多轮对话；自带 API Key（BYOK），不经任何中转
- **标注** —— 划线批注，按书或跨书检索，点一下回到原文
- **整理** —— 改书名/作者/简介/封面，改章节标题与正文 HTML，拖拽排序，新增、删除、合并章节
- **拆分** —— 按章节把一本书切成多本，每卷只携带真正引用到的图片、样式与字体
- **导出** —— 生成符合 EPUB 3 规范的文件（同时带 nav + ncx，兼容老阅读器）
- **传书与备份** —— 从 WebDAV 目录拉书；开一个局域网页面，在电脑浏览器里把 epub 传到手机；
  删掉的书先进回收站

## 技术栈

| 层 | 选型 |
| --- | --- |
| 语言 | Go（后端）+ TypeScript（前端） |
| 桌面框架 | Wails v3（WebView2，单可执行文件；同一份 `main.go` 也编 Android） |
| 后端 | Go，零依赖 EPUB/XML/WebDAV（`app/internal/*`） |
| 数据库 | SQLite（modernc.org/sqlite，纯 Go 无 cgo） |
| 词库 | ECDICT（CSV 导入 → 独立 SQLite） |
| 前端 | React 18 + Vite + React Router，DOMPurify 净化正文 |

前后端之间**只有 Wails 进程内绑定**（`Call.ByName('epubmaker-desktop/internal/app.Backend.*')`，
经由宿主自己的 `/wails/runtime.js`），没有 HTTP、没有端口。

## 快速开始

首选入口是仓库根的 `run.ps1`（PowerShell 7 / Windows PowerShell 5.1 均可，无参数即打印帮助）：

```powershell
.\run.ps1            # 帮助
.\run.ps1 dev        # 桌面开发：vite watcher + 编译 Go + 窗口随 Go 改动重启
.\run.ps1 build      # 生产 exe
.\run.ps1 nsis       # 生产 exe + NSIS 安装包（需本机装 NSIS）
.\run.ps1 mobile     # Android APK（arm64，交叉编译同一个 main.go）
.\run.ps1 test       # 前端 typecheck + go vet + go test
.\run.ps1 web        # 仅前端 vite（7800）；没有 Go 后端，只能调样式
.\run.ps1 clean      # 清 web/dist、app/frontend/dist、app/build/bin
```

短参数 `-d / -b / -n / -t / -w / -c`；`-Verbose` 打开子进程输出。

底层等价命令（排查时用）：

```bash
cd app && go build ./... && go vet ./... && go test ./...
cd app && ./build-windows.ps1          # 等价于 wails build：go build + wails3 generate syso
cd app && ./build-windows.ps1 -Installer
```

> 构建一律走 `run.ps1`。Wails CLI 只用来生成资源（`generate syso` / `android overlay:gen`），
> 不用它的 `build|dev|package` 子命令（原因见 [`AGENTS.md`](AGENTS.md)）。

## 词库

查词依赖本地 ECDICT 词库，需要在书架页点「导入词库」选 `ecdict.csv`，或用命令行：

```bash
cd app && go run ./cmd/dictimport /path/to/ecdict.csv
```

全量词库约 77 万条 / 98MB，导入约 8 秒，装到 `~/.epubmaker/dict/dict.db`。
词库**不从网络下载**（官方源实测 1.4 KB/s），请自备 csv 或随安装包分发。

不装词库时其他功能完全正常，只是划词会提示未收录。

## 存储位置

所有运行时数据都在 `~/.epubmaker`（`EPUBMAKER_HOME` 可整体改到别处）：

```
~/.epubmaker/
├── config.json          # 首次启动自动生成
├── data/
│   ├── epubmaker.db     # SQLite：书目、书架、章节、标注、书签、生词本
│   └── books/<bookId>/
│       ├── content/     # 解包后的章节 XHTML、图片、CSS、字体（保持 zip 内原路径）
│       └── original.epub
├── data/trash/          # 回收站（软删除的书目录整体 rename 到这里）
├── dict/dict.db         # 本地词库
├── exports/  logs/  tmp/
```

### config.json

```jsonc
{
  "dataDir": "data",        // 相对路径基于 ~/.epubmaker；也可填绝对路径挪到别的盘
  "exportDir": "exports",
  "logDir": "logs",
  "tmpDir": "tmp",
  "dictDir": "dict",
  "logLevel": "info",       // debug | info | warn | error
  "maxUploadSizeMb": 300,
  "keepOriginalEpub": true  // 导入时是否保留原始 epub 副本
}
```

改完重启应用生效。旧版遗留的 `port` / `host` 字段已无作用（本应用不监听端口）。

## 目录结构

```
EpubMaker/
├── app/
│   ├── main.go              # 唯一宿主入口：窗口、服务绑定、.epub 命令行、拖放
│   ├── platform_{android,desktop}.go   # 仅有的两处平台分支（HOME/trace 与空实现）
│   ├── build-windows.ps1    # 生产构建：web bundle → 版本资源 → go build →（可选）NSIS
│   ├── dev-windows.ps1      # 开发循环：vite + 反向代理 + Go 改动自动重编重启
│   ├── build/config.yml     # 版本号与产品信息的唯一来源（桌面 + Android 共用）
│   ├── frontend/dist/       # 构建时由 scripts/sync-frontend-dist.js 镜像，再被 //go:embed 打包
│   ├── cmd/{dictimport,mobile}/        # 命令行词库安装器 / Android 构建脚本 + Gradle 工程
│   └── internal/            # 后端。各包职责见 AGENTS.md 的模块表
├── web/src/
│   ├── pages/               # 每页一个文件：Library Reader Editor Split Bookmarks
│   │                        # Annotations Trash WebDav Opds Vocab Review AIChats …
│   ├── api.ts               # 绑定的唯一封装层（含测试用的注入缝）
│   ├── overlay.ts           # 浮层定位（保证不越出视窗）
│   └── styles.css
├── docs/                    # 设计取舍（decisions）、排查手册、多平台、书架设计稿与原型
├── scripts/sync-frontend-dist.js
└── run.ps1
```

## 设计取向

三条能一眼看见的后果。为什么这么定见文末的 `docs/decisions.md`，不许怎么改见 `AGENTS.md`：

- **路径保持原样** —— 资源以「原 zip 内完整路径」为键存盘，导入导出前后一致，章节间相对引用天然可用；
  导出包把生成物统一叫 `epubmaker.opf` / `epubmaker-nav.xhtml` / `epubmaker-toc.ncx`，不跟原书重名。
- **排版统一、翻页瞬时** —— 不加载原书 CSS，正文净化后套一套干净排版；章内翻页不做动画。
- **拆分带资源、删除留文件** —— 按正文引用递归收集（含 CSS 里的 `url()`）；删章节只从目录移除，
  正文文件留在磁盘。

更多「为什么这样设计」见 [`docs/decisions.md`](docs/decisions.md)，踩坑排查见
[`docs/troubleshooting.md`](docs/troubleshooting.md)，多平台兼容与风险见
[`docs/platforms.md`](docs/platforms.md)，改代码前的约定见 [`AGENTS.md`](AGENTS.md)。
