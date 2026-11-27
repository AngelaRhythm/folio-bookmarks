# Folio UI 设计系统与交互规范文档

本文档完整记录 Folio 的视觉 Token、排版层级、组件结构、微动效与特殊交互实现，方便人类设计师或 AI Agent 在保持极简建筑感风格一致的前提下扩展界面。

---

## 1. 色彩系统（`oklch.fyi` 风格严格无彩色中性基调 + OKLCH 色轮）

定义位于 `styles/folio.css` 顶部（`:root` 与 `[data-theme="dark"]`），通过 `applyTheme()` 自动跟随浏览器/系统 `prefers-color-scheme`，无手动主题开关。

### 1.1 中性表面与文本（`C = 0` 严格无彩色，消除蓝灰/棕灰偏色）

| Token | 浅色模式（Light） | 深色模式（Dark / Obsidian） | 用途 |
| :--- | :--- | :--- | :--- |
| `--bg-canvas` | `oklch(0.991 0 0)` | `oklch(0.17 0 0)` | 主画布背景 |
| `--bg-sidebar` | `oklch(0.984 0 0)` | `oklch(0.145 0 0)` | 左侧导航栏背景 |
| `--bg-surface` | `oklch(1 0 0)` | `oklch(0.185 0 0)` | 卡片、弹窗、分屏面板主体 |
| `--bg-surface-subtle` | `oklch(0.971 0 0)` | `oklch(0.215 0 0)` | 占位封面、设置子卡片、次级底面 |
| `--bg-hover` / `--bg-active` | `0.958` / `0.945` | `0.238` / `0.262` | 悬停态与选中态 |
| `--text-primary` | `oklch(0.16 0 0)` | `oklch(0.955 0 0)` | 标题与主文案 |
| `--text-secondary` | `oklch(0.36 0 0)` | `oklch(0.835 0 0)` | 次级说明与正文 |
| `--text-muted` | `oklch(0.51 0 0)` | `oklch(0.66 0 0)` | 域名、计数、辅助信息（WCAG AA >= 5.7:1） |
| `--border-hairline` | `oklch(0.885 0 0)` | `oklch(0.285 0 0)` | 全站统一的 **`0.5px`** 精致描边 |
| `--border-strong` | `oklch(0.79 0 0)` | `oklch(0.38 0 0)` | 悬停边框与弹窗轮廓 |
| `--accent` | `oklch(0.55 0.175 266)` | `oklch(0.73 0.16 270)` | 主强调色（Periwinkle Indigo） |
| `--danger` | `oklch(0.56 0.19 25)` | `oklch(0.7 0.17 24)` | 删除/清空等危险操作 |

### 1.2 感知均匀 OKLCH 图标色轮
左侧栏图标渐变和底部交互网格共用一组相同明度/色度（浅色 `--ok-l-hi: 0.72 / --ok-l-lo: 0.56`，深色自动提亮至 `0.78 / 0.61`）、仅按色相 `H` 步进的 OKLCH 变量：
- Indigo `268` · Blue `242` · Cyan `206` · Teal `182` · Emerald `156` · Amber `68` · Rose `8` · Violet `304`

---

## 2. 排版与描边规范

- **字体栈**：`--font-sans`（`"Inter", -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", ...`），数字与计数开启 `font-variant-numeric: tabular-nums`。
- **核心字号层级**：
  - 页面内文件夹标题（`.section-heading` 与 `.folder-view-title` 保持严格一致）：`22px` / `660`
  - 设置分屏四级层次：面板一级标题 `20px` > 分组卡片标题 `17px` > 条目标题 `14px` > 辅助说明 `13px`
  - 卡片标题与正文：`--text-body`（`15px`）；域名/角标：`--text-sm`（`13px`）
- **0.5px 全站描边**：顶栏底部常驻 `0.5px` 描边、侧栏与分屏分割线、卡片轮廓与阴影环、按钮/表单边框全部统一为 `0.5px`；页面内分组标题下方不加分割线。

---

## 3. 布局结构与响应式断点

```text
┌────────────┬────────────────────────────────────────┬─────────────────┐
│ #sidebar   │ #workspace (flex: 1, min-width: 0)     │ #settings-pane  │
│ 248px /    │ ┌────────────────────────────────────┐ │ 0px -> 420px    │
│ 60px rail  │ │ #topbar (sticky, 64px, 0.5px btm)  │ │ (flex 分屏推挤) │
│            │ │ [搜索触发器]           [设置图标]  │ │                 │
│ 文件夹树   │ ├────────────────────────────────────┤ │ 常规设置 | 体检 │
│            │ │ #gallery-root                      │ │ 分组卡片列表    │
│            │ │  • 顶部收藏条 (.favorites-rail)    │ │                 │
│ 底部交互   │ │  • 1–4 列 16:10 卡片网格           │ │                 │
│ 网格背景   │ │ #gallery-footer (FOLIO 水印 + ↑)   │ │                 │
└────────────┴────────────────────────────────────────┴─────────────────┘
```

- **动态卡片列数（`.card-grid`）**：`grid-template-columns: repeat(auto-fill, minmax(max(220px, calc((100% - 48px) / 4)), 1fr))` —— 视口宽时最多 4 列，当右侧设置分屏展开压缩 `#workspace` 或窗口缩窄时自动平滑重排为 3 列 → 2 列 → 1 列。
- **响应式断点**：
  - `<= 1200px`：主内容左右内边距收窄至 `24px`，`#settings-pane` 宽度调整为 `380px`。
  - `<= 960px`：`#settings-pane` 由 flex 分屏平滑降级为右侧 `position: fixed` 抽屉浮层。
  - `<= 720px`：`#sidebar` 切换为左侧抽屉（`248px`）+ 半透明遮罩 `#sidebar-backdrop`，卡片网格单列展示。

---

## 4. 图标体系（严格双轨制）

定义集中于 [src/icons.js](../src/icons.js)，线性渐变 `<defs>` 定义在 [newtab.html](../newtab.html#L11-L58)：

1. **左侧边栏导航图标（Nucleo Glass 风格）**：
   - 双层磨砂玻璃 + 高光描边叠加 OKLCH 渐变底色（`glassAllGrid`, `glassInbox`, `glassWork`, `glassForum`, `glassVisual`, `glassGlobe`, `glassTools`, `glassCode`, `glassSpec`, `glassAi`, `glassFolder`）。
   - 由 `getSidebarFolderIcon(title, isActive)` 按中英文语义关键字自动匹配；收起侧边栏时图标中心恒定锚定在 `x = 30px` 位置，展开/收起只对文字、箭头和底部网格做 `240ms` 透明度过渡，确保两侧动画完全对称流畅。
2. **其余全部 UI 图标（Tabler Icons 规范）**：
   - 统一 `viewBox="0 0 24 24"`、`stroke-width="1.75"`、圆角端点与连接（`sidebarCollapse`, `sidebarExpand`, `sidebarRightCollapse` 双右箭头, `search`, `settings`, `refresh`, `copy`, `move`, `star`, `starFilled`, `arrowRight`, `arrowUp`, `trash`, `plus`, `close`, `menu`, `chevron`）。

---

## 5. 特色组件与微交互实现

### 5.1 左侧栏底部可交互背景网格（`#sidebar-bg-boxes`）
- 灵感源自 Aceternity UI Background Boxes，位于 `initSidebarBackgroundBoxes()`（[src/app.js](../src/app.js)）。
- 高度 `24vh`（`min-height: 128px; max-height: 220px`），通过等距倾斜变换构建 `14×16` 网格，叠加从底到顶透明度 `1 → 0` 的渐变遮罩 `.sidebar-boxes-fade`。
- 鼠标移入单元格瞬间点亮随机 OKLCH 柔和色块，移出后平滑拖尾衰减（`1.4s`）。侧栏收起时自动淡出并禁用指针事件。

### 5.2 零占位悬浮滚动条与防闪烁机制（`.folio-scrollbar`）
- 全站隐藏原生滚动条并设置 `overscroll-behavior: none` 锁定顶部/底部边界防 macOS 橡皮筋抖动。
- `initOverlayScrollbars()` 创建全局垂直/水平两条 `4px` 胶囊滑块，仅在**真实位移 `>= 1px`** 时出现并在 `750ms` 无滚动后淡出。
- 主页面垂直滚动条实时锚定 `#workspace` 的右边缘（`wsRect.right`）且从顶栏下方起始：设置展开时自然落在内容区与设置分屏的交界线之间，设置收起后自动回到屏幕最右侧。
- 侧栏或设置分屏做宽度动画时调用 `suppressOverlayScrollbars(340)` 屏蔽布局压缩引发的合成 `scroll` 事件，彻底消除 `.favorites-rail` 滚动条闪烁。

### 5.3 零延迟自定义鼠标指针（参考 Nyx UI Custom Cursor）
- 实现于 `initCustomCursor()`（[src/app.js](../src/app.js)）与 `styles/folio.css` 末尾，仅在 `@media (hover: hover) and (pointer: fine)` 桌面端启用：
  - **指针本体（0ms 延迟）**：动态生成 `24×24`（1x）与 `48×48`（2x Retina）矢量几何箭头 SVG Data URI，通过 `cursor: image-set(...) 3 2` 交给系统硬件光标合成层渲染。默认态随明暗主题自动反色，交互区域按语义切换 6 种 OKLCH 配色（Indigo / Blue / Teal / Violet / Amber / Rose），输入框自动保留原生 `text` 光标。
  - **悬浮语义胶囊（`#folio-cursor-pill`）**：监听高频 `pointerrawupdate` + `pointermove` 直接同步写入 GPU `translate3d`（外层无 `transition`、无缓动插值、无每帧重排），仅在跨元素 `pointerover` 时更新文案与配色，靠近视口右/下边缘时自动反向避让防裁切。

### 5.4 Spotlight 搜索与中文输入法（IME）防误触
- 快捷键 `Cmd + K`、`/` 或画廊内直接打字唤起。
- 通过 `compositionstart` / `compositionend` + `e.isComposing` + `e.keyCode === 229` + 结束组合后 `80ms` 防抖窗口，确保中文拼音输入法按回车确认候选词时不会误触发打开书签。

### 5.5 极简水印页脚（`#gallery-footer`）
- 灵感源自 Aceternity 水印页脚：底部大号低透明度 `FOLIO` 字标 + 内容区正中单个 `36×36` 圆形 Tabler `arrow-up` 回到顶部图标按钮，零多余统计文案。
