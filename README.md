# Folio

极简、沉浸式的本地 Chrome 视觉书签画廊扩展（Manifest V3）。覆盖浏览器新标签页，实时联动 Chrome 原生书签文件夹，自动截取并缓存每个收藏站点的首屏预览。

## 核心特性

- **原生书签实时联动**：直接读取并监听 Chrome 原生书签树（`chrome.bookmarks`），增删改移即时同步，无需维护第二套数据库。
- **本地隐私优先的首屏截取引擎**：
  - **默认 100% 纯本地运行**：默认关闭一切第三方网络请求，不上传、不外发任何书签地址；仅在你日常实际打开并浏览已收藏网页时，通过 Chrome 原生 `captureVisibleTab` 在本地截取真实渲染首屏并缓存到 IndexedDB（支持重定向追踪）；
  - **内网与敏感目录硬拦截**：自动识别私有 IP、`.local`/`.internal` 以及 `公司`/`工作`/`内网` 等目录（可在设置中增删），前后端强制跳过且不展示封面，手动操作也无法绕过；
  - **可选的脱敏远程补齐（默认关闭）**：如希望提前为空白公网卡片补齐封面，可在首次引导页或「设置 → 常规设置 → 封面获取」中显式选择「补齐公网封面」。开启后，仅对未排除的公网标准域名发送**脱敏后的根域名（`origin`，如 `https://example.com`）**至 WordPress mShots（失败时无 Cookie 降级读取根域名 `og:image`），**绝不发送路径、文档 ID、查询参数（`?`）、哈希（`#`）或登录态 Cookie**；
  - **按周期本地保鲜**：支持在设置中配置刷新周期（7 天 / 30 天 / 90 天 / 仅手动），封面过期后在你下次访问时本地无感更新。
- **沉浸式单屏引导与轻量多态状态条**：
  - 首次安装自动打开独立引导页 `welcome.html`，一屏内通过实时 Chrome 顶栏预览图、双视觉封面卡片与文件夹胶囊完成配置（支持右上角一键「跳过」按默认进入）；
  - 画廊顶部的多态状态条将封面抓取进度与轻量操作引导合二为一，按当前场景切换显示进度、完成状态或待补齐提醒（点击「忽略」后静默 30 天再提醒）。
- **极简沉浸画廊**：
  - 左侧可收起侧边栏（`248px` 实体文件夹袋卡片 / `60px` 图标轨道），采用 Nucleo Glass 图标（默认态还原作者原生玻璃灰阶，悬停/激活态呈现 OKLCH 彩色玻璃渐变）、2–4 张扇形封面预览与底部交互式网格背景，支持多级嵌套文件夹、卡片内拖拽排序与跨文件夹拖拽归类；
  - 紧凑 1–4 列响应式 `16:10` 首屏卡片网格，纯自动跟随浏览器/系统浅色与深色外观；
  - 卡片右下角悬浮星标一键收藏，在「全部书签」顶部生成轻量化快速入口条；
  - 72 小时内新收藏的书签自动展示轻量化 `New` 标签，超时自动消失。
- **Spotlight 全局秒搜**：按 `Cmd + K`、`/` 或在页面直接打字即可实时检索标题、网址与文件夹路径，完整兼容中文输入法（IME）组合输入。
- **自定义打开方式**：在引导页或「设置 → 常规设置 → 打开方式」自由组合 4 种入口（可多选或全开，至少保留一项），下方迷你浏览器预览图实时高亮当前生效位置：**新标签页**（默认开）、**工具栏图标**（默认开，当前窗口已打开时直接切回，不重复开页签）、**浏览器首页**、**全局快捷键**（默认 `Alt+Shift+F` / macOS `⌥⇧F`，采用矢量键帽图标展示并支持一键跳转 Chrome 快捷键设置页改键）。
- **设置与书签体检**：顶栏一键展开右侧分屏设置（`Shift + Cmd + O`），常规设置与引导页保持一致的可视化交互，支持配置打开方式、封面获取模式、刷新周期、一键跳过封面文件夹胶囊、缓存清理以及重复收藏一键去重。
- **默认零外发 & 零构建**：无任何自建后端服务；默认状态下零第三方网络请求、不外发任何书签网址；无需 `npm install` 或打包构建，直接加载即可使用。

## 快速安装（Chrome 本地加载）

1. 克隆或下载本仓库到本地：
   ```bash
   git clone https://github.com/AngelaRhythm/folio-bookmarks.git
   ```
2. 在 Chrome 地址栏打开 `chrome://extensions/`，开启右上角 **「开发者模式」**。
3. 点击左上角 **「加载已解压的扩展程序」**，选择 `folio-bookmarks` 目录。
4. 按 `Cmd + T`（Windows 为 `Ctrl + T`）打开新标签页，点击「保留更改」即可启用。
5. 如需启动浏览器时自动打开，在 `chrome://settings/onStartup` 选择 **「打开新标签页」**。

## 快捷键一览

| 快捷键 | 功能 |
| :--- | :--- |
| `Alt + Shift + F`（macOS `⌥⇧F`） | 在任意网页一键切回或打开 Folio（需在「设置 → 打开方式」开启，支持改键） |
| `Cmd + K` / `/` / 直接打字 | 呼出 Spotlight 全局搜索 |
| `[` 或 `Cmd + \` | 收起或展开左侧极窄侧边栏 |
| `Shift + Cmd + O` | 打开或关闭「设置」抽屉 |
| `Esc` | 关闭当前搜索弹窗、抽屉或菜单 |

## 本地预览（无需装入 Chrome）

在开发或调整 UI 时，可直接启动任意静态 HTTP 服务器打开 `newtab.html`：

```bash
python3 -m http.server 8765 --bind 127.0.0.1
```

访问 `http://127.0.0.1:8765/newtab.html` 时，[src/shared/chrome-bridge.js](src/shared/chrome-bridge.js) 会自动启用内置的模拟书签与首屏缩略图数据集（支持附加 `?theme=light` 或 `?theme=dark` 预览指定主题）；访问 `http://127.0.0.1:8765/welcome.html`（或 `newtab.html?onboarding=1`）可直接预览独立沉浸式引导页。

## 项目结构

```text
folio-bookmarks/
├── manifest.json                 # Chrome Extension Manifest V3 配置
├── newtab.html                   # 新标签页主界面骨架、OKLCH 图标渐变、多态状态条、Spotlight 与右侧分屏设置
├── welcome.html                  # 首次安装自动打开的独立一屏式可视化引导页
├── styles/
│   ├── folio.css                 # OKLCH 浅/深双色 Token、共享可视化偏好组件、0.5px 描边体系、悬浮滚动条与自定义指针
│   └── welcome.css               # 独立引导页一屏布局与响应式样式
├── icons/                        # 扩展图标 (16 / 32 / 48 / 128 px)
├── src/
│   ├── app.js                    # 主画廊渲染、多态状态条、实时联动、拖拽排序与归类、IME 兼容搜索、设置与交互增强
│   ├── welcome.js                # 独立引导页控制器（实时预览、封面模式、跳过文件夹与跳过/完成流程）
│   ├── newtab-gate.js            # 新标签页早拦截闸门与侧栏收起防闪烁守卫
│   ├── shockwave.js              # Spotlight 唤起时的 WebGL2 + SVG 光学冲击波特效
│   ├── background.js             # MV3 Service Worker：安装自动引导、多入口启动调度、纯本地截屏、可选 Plan A 远程补齐与缓存回收
│   ├── icons.js                  # Nucleo Glass（侧栏）+ Tabler Icons（全站控件）+ 矢量修饰键帽渲染器
│   └── shared/
│       ├── chrome-bridge.js      # Chrome API 适配层（扩展外自动降级为 HTTP 预览 Mock）
│       ├── db.js                 # IndexedDB 缩略图存储与孤儿缓存回收
│       └── url.js                # URL 规范化、内网识别、Plan A 根域名脱敏与占位色相工具
├── AGENTS.md                     # AI Agent 改造总入口（核心约束、文件索引与验证命令）
└── docs/
    ├── ARCHITECTURE.md           # 模块架构、数据 Schema、消息协议与本地/远程链路详解
    ├── UI_DESIGN_SYSTEM.md       # OKLCH 视觉规范、排版、0.5px 描边与特色微交互文档
    └── CUSTOMIZATION_GUIDE.md    # 常见二次开发配方（Recipes）与避坑清单
```

## 文档与 AI 二次开发指南

仓库已为二次开发和 AI 编程助手（Antigravity、Claude Code、Cursor、Codex 等）准备好结构化文档，下载到本地后可直接让 Agent 阅读并按需定制：

- **[AGENTS.md](AGENTS.md)**：AI Agent 首读入口 —— 项目不可破坏的架构/隐私红线、快速「改哪里找哪个文件」速查表与自动化验收命令。
- **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**：完整技术架构 —— UI 线程与 Service Worker 边界、`chrome.storage.local` / IndexedDB 数据结构、消息协议与纯本地/脱敏远程截屏全链路。
- **[docs/UI_DESIGN_SYSTEM.md](docs/UI_DESIGN_SYSTEM.md)**：视觉与交互规范 —— `oklch.fyi` 风格无彩色中性 Token、Nucleo Glass / Tabler 双轨图标、左侧交互网格、内容区悬浮滚动条与零延迟自定义指针实现。
- **[docs/CUSTOMIZATION_GUIDE.md](docs/CUSTOMIZATION_GUIDE.md)**：实战改造配方 —— 新增设置项、改列数/比例、定制文件夹图标、扩展卡片操作与 8 条常见避坑指南。

## 权限与隐私说明

- `bookmarks`：读取书签树、监听实时变化及执行拖拽/整理移动。
- `tabs` & `<all_urls>`：在你实际访问已收藏且未排除的网页时，调用 Chrome 本地 `captureVisibleTab` 截取当前视口首屏（纯本地像素截屏，默认不产生任何后台网络请求）。
- `storage` & `unlimitedStorage`：在本地保存偏好设置，并允许 IndexedDB 缓存书签首屏图。
- `favicon`：通过 Chrome 原生 `/_favicon/` 接口本地获取站点图标。
- `alarms`：仅在你主动开启可选「远程补齐封面」且设置定期刷新时，按周/月周期唤醒后台任务；默认纯本地模式下不调度网络任务。

### 隐私边界（默认 vs 可选）

| 模式 | 网络外发行为 |
| :--- | :--- |
| **默认模式（纯本地）** | **零第三方请求**。所有封面均来自你实际打开网页时的本地 `captureVisibleTab` 截屏，任何书签 URL 均不会离开本机。 |
| **可选「补齐公网封面」（默认关闭）** | 仅对未排除的公网域名，将**脱敏后的根域名 `origin`**（例如 `https://example.com`，自动剥离路径、文档 ID、`?` 查询参数、`#` 哈希、端口与认证信息）发给 WordPress mShots（`s.wordpress.com`）；失败时以 `credentials: 'omit'` 无 Cookie 方式读取根域名 `og:image`。内网地址、私有 IP 及「跳过封面」列表内的文件夹前后端强制拦截，无法被手动刷新绕过。 |

## 贡献者

- **[@AngelaRhythm](https://github.com/AngelaRhythm)** · 产品构想、需求定义与视觉审美把关
- **Antigravity (Google DeepMind)** · 技术架构设计与全栈实现

## 开源协议

本项目基于 [MIT License](LICENSE) 开源。
