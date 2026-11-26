# Folio 二次开发与 Agent 改造指南（Customization Playbook）

当你把 Folio 克隆到本地后，可以直接把本文件与根目录 `AGENTS.md` 提供给你的 AI 编程助手（Antigravity、Claude Code、Cursor、Codex 等），按下方对应「配方」安全改造，避免破坏隐私边界或引入回归问题。

---

## 1. 给 AI Agent 下达改造指令的推荐方式

在开启新对话时，可以这样开场：

> 「请先阅读 `AGENTS.md`，需要改动架构/隐私逻辑时参考 `docs/ARCHITECTURE.md`，改动界面样式时参考 `docs/UI_DESIGN_SYSTEM.md`。保持零构建原生 ESM 和默认纯本地隐私原则。现在我想做如下改造：……」

---

## 2. 常见改造配方（Recipes）

### 配方 A：新增一个设置开关或偏好项
涉及 4 处同步（缺一容易出现扩展/预览默认值不一致）：
1. **`src/shared/chrome-bridge.js` → `loadPreferences()`**：在 `defaults` 中添加新键及默认值。
2. **`src/app.js` → `state.prefs`**：补充同名默认值。
3. **`src/background.js` → `getSettings()`**（仅当后台 Service Worker 需要读取时）：从 `chrome.storage.local.get([...])` 读取并在 `chrome.storage.onChanged` 中响应变化。
4. **`src/app.js` → `renderTidyContent()` & `els.tidyContent` 事件监听**：在 `.settings-card` → `.settings-subcard-list` 中按既有 `.settings-item-row` 结构渲染控件并调用 `savePreferences({ key: value })`。

### 配方 B：修改卡片网格列数、封面比例或分组默认展示行数
- **最大列数**：编辑 `styles/folio.css` 中的 `.card-grid`（当前 `calc((100% - 48px) / 4)` 表示最多 4 列，改为 `/ 5` 或调整最小宽度 `220px` 即可）。
- **封面宽高比**：修改 `styles/folio.css` 中 `.card-media` 的 `aspect-ratio`（当前 `16 / 10`）；若需匹配新截屏比例，同步更新 `src/background.js` 顶部的 `TARGET_WIDTH` / `TARGET_HEIGHT`（当前 `640` / `400`）。
- **「全部书签」每个分组默认显示行数**：在 `src/app.js` 中搜索 `getAllViewGroupLimit()`（当前为 `cols * 2 - 1`，即固定 2 行且末尾留 1 格给「查看全部」卡片）。

### 配方 C：为自己的常用文件夹定制 Nucleo Glass 图标
1. 在 `src/icons.js` 中参照 `glassWork` / `glassCode` 添加新的 `19×19` 双层 SVG，引用 `newtab.html` 中已定义的 OKLCH 渐变（`#ng-cobalt`、`#ng-work`、`#ng-cyan`、`#ng-rose`、`#ng-emerald`、`#ng-amber`、`#ng-violet`、`#ng-slate`、`#ng-glass-pane`、`#ng-glass-stroke`）。
2. 在 `src/app.js` 的 `getSidebarFolderIcon(title, isActive)` 中添加你的文件夹名称关键词匹配规则。
3. 如需新增颜色渐变，直接在 `newtab.html` 顶部 `<svg><defs>` 中使用 `styles/folio.css` 的 OKLCH 变量添加 `<linearGradient>`，即可自动适配浅色与深色模式。

### 配方 D：新增卡片悬停操作或右键菜单项
- **悬停操作按钮**：在 `src/app.js` 的 `createCardElement()` 内 `.card-actions` 中添加 `<button data-action="your-action" ...>`，图标从 `src/icons.js`（Tabler 1.75px 规范）引入，在 `els.galleryRoot` 的 click 委托中处理 `action === 'your-action'`，并在 `resolveCursorPill()` 与 `styles/folio.css` 自定义指针区为其配置颜色与胶囊提示。
- **右键菜单项**：在 `newtab.html` 的 `#card-context-menu` 中增加按钮，并在 `src/app.js` 的 `openCardContextMenu()` 与点击事件中绑定逻辑。

### 配方 E：自定义主题色或增加手动深浅主题切换
- **微调主题强调色**：仅需修改 `styles/folio.css` 中 `:root` 与 `[data-theme="dark"]` 的 `--accent`、`--accent-soft`、`--accent-text`。
- **如用户希望增加手动切换浅/深/跟随系统**：在 `prefs` 中新增 `themeMode: 'system' | 'light' | 'dark'`，在 `applyTheme()` 中按该值设置 `document.documentElement.setAttribute('data-theme', ...)`，并确保调用 `updateCustomCursorTheme()` 同步更新指针配色。

### 配方 F：关闭或微调自定义指针 / 左侧交互网格 / 水印页脚
- **自定义指针**：在 `src/app.js` 的 `init()` 中注释或条件控制 `initCustomCursor()` 即可完全恢复系统默认光标；调整某区域胶囊文案或颜色直接编辑 `resolveCursorPill()` 与 `styles/folio.css` 末尾的 `html.has-custom-cursor` 规则。
- **左侧底部网格**：编辑 `styles/folio.css` 的 `.sidebar-boxes`（高度、渐变遮罩）与 `src/app.js` 的 `initSidebarBackgroundBoxes()`（色相数组 `hues`、行列数）。
- **页脚水印字样**：修改 `newtab.html` 中 `.footer-watermark` 文本（当前 `FOLIO`）及 `styles/folio.css` 中的 `.gallery-footer`。

### 配方 G：扩展内网自动识别或修改本地截屏压缩参数
- **内网域名与目录关键词**：编辑 `src/shared/url.js` 中的 `INTERNAL_FOLDER_HINTS`、`INTERNAL_TLD_SUFFIXES` 与 `INTERNAL_HOST_LABELS`。
- **截屏分辨率与质量**：编辑 `src/background.js` 中的 `TARGET_WIDTH`、`TARGET_HEIGHT`、`PASSIVE_SETTLE_MS` 以及 `compressBlobToWebP()` 内的 `quality`（当前 `0.8`）。

---

## 3. 二次开发避坑清单（Gotchas）

1. **不要引入构建工具链或 CDN 外部脚本**：Chrome MV3 默认 CSP 禁止加载远程 JS，且零构建是本项目即装即用的核心优势。所有第三方效果（如网格、指针、图标）请保持纯原生 CSS + ESM 实现。
2. **`src/shared/` 内部必须使用同级相对导入**：例如 `chrome-bridge.js` 引用 `url.js` 必须写 `'./url.js'`，写成 `'./shared/url.js'` 会导致 404。
3. **改完 `src/background.js` 或 `manifest.json` 必须去 `chrome://extensions/` 点刷新（`↻`）**：只在新标签页按 `Cmd + R` 不会重启 MV3 Service Worker。
4. **任何会改变页面/容器宽度的展开收起动画都要抑制滚动条闪烁**：在触发过渡前调用 `suppressOverlayScrollbars(340)`，否则压缩容器宽度产生的合成 `scroll` 事件会让悬浮滚动条误闪。
5. **绝对不要给 `.folio-cursor-pill` 外层加 `transition: transform` 或 `rAF` 缓动**：否则鼠标快速晃动时会产生明显拖尾延迟；动效只允许写在 `.folio-cursor-pill-inner` 的 `opacity`/`scale` 上。
6. **不要绕过隐私与排除门禁**：新增任何自动抓取、手动刷新或预览接口时，必须同时校验 `remoteCoverEnabled`、`toSafePublicOrigin(url)` 与 `meta.excluded`，并且网络请求一律带 `credentials: 'omit'` 和 `referrerPolicy: 'no-referrer'`。
7. **不要遗漏 `escapeHtml()` 与 `URL.revokeObjectURL()`**：书签标题/网址完全来自用户浏览器外部数据，插入 `innerHTML` 前必须转义；删除或清空缩略图时必须释放已创建的 Blob ObjectURL。
8. **HTTP 预览模式改完后记得强制刷新**：本地 `python3 -m http.server` 可能会命中浏览器对子模块的静态缓存，预览验证时注意硬刷新或清空缓存。
