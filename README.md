# Folio

极简、沉浸式的本地 Chrome 视觉书签画廊扩展（Manifest V3）。覆盖浏览器新标签页，实时联动 Chrome 原生书签文件夹，自动截取并缓存每个收藏站点的首屏预览。

## 核心特性

- **原生书签实时联动**：直接读取并监听 Chrome 原生书签树（`chrome.bookmarks`），增删改移即时同步，无需维护第二套数据库。
- **三层全自动首屏自更新引擎**：
  - **零弹窗静默补齐**：后台并发为公网书签静默获取真实首屏（WordPress mShots 优先，失败自动降级解析网页 `og:image` 封面），全程不弹任何窗口，支持 MV3 断点续传；
  - **内网与内部站自动跳过**：自动识别私有 IP、`.local`/`.internal` 以及 `公司`/`工作`/`内网` 等内部文件夹（可在设置中自定义），不外发地址、保持干净的图标占位；
  - **重定向追踪无感升级**：日常点开任意公网书签（即使发生多次跳转）时，自动将封面静默升级为浏览器真实渲染首屏；
  - **长周期定时保鲜**：通过 `chrome.alarms` 按周（7 天）或按月（30 天，默认）后台定期巡检更新，零高频打扰；新增公网书签自动静默出图。
- **极简沉浸画廊**：
  - 左侧极窄可收起侧边栏（`228px` 目录树 / `60px` 首字图标轨道），支持多级嵌套文件夹与卡片直接拖拽归类；
  - 紧凑 4 列响应式 `16:10` 首屏卡片网格，纯自动跟随浏览器/系统浅色与深色外观；
  - 卡片右下角悬浮星标一键收藏，在「全部书签」顶部生成轻量化快速入口条；
  - 72 小时内新收藏的书签自动展示轻量化 `New` 标签，超时自动消失。
- **Spotlight 全局秒搜**：按 `Cmd + K`、`/` 或在页面直接打字即可实时检索标题、网址与文件夹路径，方向键回车直达。
- **设置与书签体检**：按需呼出（`Shift + Cmd + O`），支持配置首屏刷新周期、内网跳过分组、静默补齐与缓存清理，并提供精确的重复收藏一键去重。
- **100% 本地隐私 & 零构建**：无后端服务、不上传任何书签地址、无需 `npm install` 或打包构建，直接加载即可使用。

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
| `Cmd + K` / `/` / 直接打字 | 呼出 Spotlight 全局搜索 |
| `[` 或 `Cmd + \` | 收起或展开左侧极窄侧边栏 |
| `Shift + Cmd + O` | 打开或关闭「设置」抽屉 |
| `Esc` | 关闭当前搜索弹窗、抽屉或菜单 |

## 本地预览（无需装入 Chrome）

在开发或调整 UI 时，可直接启动任意静态 HTTP 服务器打开 `newtab.html`：

```bash
python3 -m http.server 8765 --bind 127.0.0.1
```

访问 `http://127.0.0.1:8765/newtab.html` 时，[src/shared/chrome-bridge.js](src/shared/chrome-bridge.js) 会自动启用内置的模拟书签与首屏缩略图数据集；访问 `?onboarding=1` 可直接预览首次关联书签引导弹窗。

## 项目结构

```text
folio-bookmarks/
├── manifest.json            # Chrome Extension Manifest V3 配置
├── newtab.html              # 新标签页主界面骨架、引导弹窗、Spotlight 与整理抽屉
├── styles/
│   └── folio.css            # 浅/深双色设计 Token、3 级字号体系与微动效样式
├── icons/                   # 扩展图标 (16 / 32 / 48 / 128 px)
└── src/
    ├── app.js               # 主画廊渲染、实时联动、拖拽归类、72h New 标签与整理交互
    ├── background.js        # MV3 Service Worker：无感截屏、WebP 压缩与批量补采队列
    ├── icons.js             # 极简 1.5px 描边 SVG 图标集
    └── shared/
        ├── chrome-bridge.js # Chrome API 适配层（扩展外自动降级为预览 Mock）
        ├── db.js            # IndexedDB 缩略图存储与孤儿缓存回收
        └── url.js           # URL 规范化、域名解析、协议过滤与占位色相工具
```

## 权限说明

- `bookmarks`：读取书签树、监听实时变化及执行拖拽/整理移动。
- `tabs` & `<all_urls>`：在你访问已收藏网页时调用 `captureVisibleTab` 静默截取首屏。
- `storage` & `unlimitedStorage`：保存偏好设置并允许 IndexedDB 缓存大量书签首屏图。
- `favicon`：通过 Chrome 原生 `/_favicon/` 接口离线获取高清站点图标。
- `alarms`：按周或按月长周期唤醒后台任务，静默巡检并刷新过期首屏。

## 贡献者

- **[@AngelaRhythm](https://github.com/AngelaRhythm)** · 产品构想、需求定义与视觉审美把关
- **Antigravity (Google DeepMind)** · 技术架构设计与全栈实现

## 开源协议

本项目基于 [MIT License](LICENSE) 开源。
