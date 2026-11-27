# Folio 技术架构与运行逻辑文档

本文档面向需要深度理解、改造或交由 AI Agent 二次开发 Folio 的开发者，完整覆盖模块边界、数据结构、核心运行链路、隐私安全边界及 MV3 生命周期细节。

---

## 1. 运行时架构总览

Folio 是一个**零构建、纯原生 ES Modules** 的 Chrome Extension（Manifest V3），运行时分为两个完全隔离的执行上下文，通过 `chrome.runtime` 消息、IndexedDB 与 `chrome.storage.local` 协同：

```text
┌──────────────────────────────────────────────────────────────────────┐
│  New Tab UI 线程 (newtab.html + styles/folio.css + src/app.js)        │
│  • 渲染侧边栏、画廊网格、顶部收藏条、Spotlight、右侧分屏设置、页脚     │
│  • 维护内存树模型 state 与懒加载 ObjectURL 缓存                       │
│  • 通过 src/shared/chrome-bridge.js 兼容扩展环境与 HTTP 本地预览      │
└───────────────────┬───────────────────────────────┬──────────────────┘
                    │ chrome.runtime.sendMessage    │ 共享本地存储
                    │ chrome.runtime.onMessage      │ • IndexedDB (WebP 缩略图)
                    ▼                               │ • chrome.storage.local (偏好与队列)
┌───────────────────────────────────────────────────┴──────────────────┐
│  MV3 Service Worker (src/background.js)                              │
│  • 监听 chrome.tabs / chrome.bookmarks / chrome.storage / chrome.alarms│
│  • 默认纯本地模式：仅在访问非排除书签时调用 captureVisibleTab 截屏     │
│  • 可选远程模式（默认关）：Plan A 根域名脱敏 -> mShots -> 无 Cookie OG │
│  • 使用 OffscreenCanvas 压缩为 640×400 WebP 写入 IndexedDB            │
└──────────────────────────────────────────────────────────────────────┘
```

### 模块职责清单

| 文件 | 运行环境 | 核心职责 |
| :--- | :--- | :--- |
| `manifest.json` | 扩展清单 | 声明 `newtab.html` 覆写、工具栏 `action`、全局快捷键 `commands`、`src/background.js`（`type: "module"`）与最小必要权限 |
| `newtab.html` | UI 线程 | 语义化页面骨架、早拦截脚本 `src/newtab-gate.js`、共享 OKLCH Nucleo Glass SVG `<defs>` 渐变、弹窗与右键菜单 DOM |
| `styles/folio.css` | UI 线程 | 完整样式系统（OKLCH 浅/深双色 Token、布局、动效、悬浮滚动条、自定义指针样式） |
| `src/newtab-gate.js` | UI 线程（`<head>`） | 新标签页启动方式闸门：当 `launchOnNewTab` 为 `false` 且非主动唤起时，首帧前隐藏页面并回退至 `chrome://new-tab-page/` |
| `src/app.js` | UI 线程 | 前端状态管理、树模型解析、画廊渲染、实时联动、拖拽归类、Spotlight、设置、滚动条与自定义指针 |
| `src/background.js` | Service Worker | 多入口启动调度（扩展图标/启动首页/全局快捷键与方案 A 切回）、本地被动截屏、重定向追踪、可选 Plan A 远程补齐队列与孤儿缓存清理 |
| `src/icons.js` | UI 线程 | 双轨 SVG 图标注册表（左侧栏 Nucleo Glass + 其余全部 Tabler Icons） |
| `src/shared/chrome-bridge.js` | UI 线程 | `IS_EXTENSION` 适配层：扩展内走原生 `chrome.*`，HTTP 预览时无缝切换内存 Mock 树与 Canvas 封面 |
| `src/shared/db.js` | UI & SW 共享 | IndexedDB（`folio_bookmark_gallery` / `thumbnails`）读写、统计与孤儿回收 |
| `src/shared/url.js` | UI & SW 共享 | URL 规范化、内网/私有地址识别、`toSafePublicOrigin()` 脱敏、原生 favicon URL、色相哈希 |

---

## 2. 数据模型与存储 Schema

### 2.1 `chrome.storage.local` 偏好与状态键

所有偏好在 `src/shared/chrome-bridge.js`（`loadPreferences()`）和 `src/background.js`（`getSettings()`）中定义，HTTP 预览模式下以 JSON 存在 `localStorage['folio_prefs']`：

| 键名 | 类型 | 默认值 | 说明 |
| :--- | :--- | :--- | :--- |
| `sidebarCollapsed` | `boolean` | `false` | 左侧栏是否处于 `60px` 图标轨道态 |
| `ttlDays` | `number` | `30` | 封面保鲜周期：`7`（每周）/ `30`（每月）/ `90`（每季度）/ `0`（仅手动） |
| `autoCapture` | `boolean` | `true` | 是否启用「浏览时本地截屏」（以及远程模式下的自动巡检） |
| `remoteCoverEnabled` | `boolean` | `false` | **是否显式开启「远程补齐封面」**。`false` 时严格禁止一切第三方请求 |
| `launchOnNewTab` | `boolean` | `true` | 是否在新标签页自动展示 Folio（关闭时由 `src/newtab-gate.js` 回退至原生 `chrome://new-tab-page/`） |
| `launchOnAction` | `boolean` | `true` | 是否允许点击浏览器工具栏扩展图标打开/切回 Folio（联动 `chrome.action.enable()/disable()`） |
| `launchOnStartup` | `boolean` | `false` | 是否在 Chrome 冷启动（`chrome.runtime.onStartup`）时自动作为首页打开 Folio |
| `launchOnShortcut` | `boolean` | `false` | 是否允许在任意网页通过全局快捷键（`Alt+Shift+F` / `⌥⇧F`）一键打开/切回 Folio |
| `initialCapturePrompted` | `boolean` | `false` | 首次欢迎弹窗是否已展示过 |
| `favoriteKeys` | `string[]` | `[]` | 顶部收藏条书签的 `normalizeUrl(url)` 列表（按收藏顺序） |
| `blurredKeys` | `string[]` | `[]` | 手动开启高斯模糊隐藏封面的书签 `normalizeUrl(url)` 列表 |
| `excludedFolderIds` | `string[] \| null` | `null` | 不获取封面的文件夹 ID 列表。首次启动为 `null` 时自动探测 `公司`/`工作`/`内网` 等目录并写入数组 |
| `folio_silent_queue_v1` | `QueueItem[]` | — | Service Worker 内部持久化远程队列（仅在 `remoteCoverEnabled === true` 时使用，关闭或启动纯本地模式时自动清除） |

### 2.2 IndexedDB 缩略图存储（`src/shared/db.js`）

- **数据库名**：`folio_bookmark_gallery`（版本 `1`）
- **ObjectStore**：`thumbnails`，主键 `keyPath: 'key'`，索引 `capturedAt`
- **Record 结构**：
  ```js
  {
    key: string,         // normalizeUrl(rawUrl) — 去 hash、去常见追踪参数、小写域名、去尾斜杠
    blob: Blob,          // 640×400 WebP 压缩图（quality: 0.8）
    size: number,        // blob.size 字节数
    capturedAt: number,  // 毫秒时间戳
    status: 'ok',        // 缓存状态
    source: 'capture' | 'mshots' | 'og', // 来源：真实本地截屏优先级最高，永不被远程覆盖降级
    width: 640,
    height: 400
  }
  ```

### 2.3 前端核心内存状态（`src/app.js` 中 `state`）

- `topFolders` / `folderMap` / `allBookmarks` / `looseBookmarks`：由 `buildTreeModel(tree)` 每次从 Chrome 原生书签树实时扁平解析；每条书签对象携带 `ancestorFolderIds`（从顶级文件夹到父文件夹的完整 ID 链），用于多级嵌套排除判断。
- `excludedKeys` (`Set<string>`)：由 `rebuildExcludedKeySet()` 汇总所有位于排除文件夹内或属于内网/不可抓取 URL 的规范化 `key`。只要同一 URL 在任意排除目录出现过，全局均按排除处理（Fail-Closed）。
- `thumbMeta` (`Map<key, meta>`)：仅保存轻量元数据，不预加载全部 Blob。
- `objectUrlCache` (`Map<key, blobUrl>`)：配合 `IntersectionObserver`（`rootMargin: '220px 0px'`）按视口懒解码；清理缓存时统一 `URL.revokeObjectURL()` 防内存泄漏。
- `expandedGroupsInAll` (`Set<groupId>`)：记录「全部书签」视图中已原地展开的分组。
- `duplicates`：按 `normalizeUrl(url)` 分组识别的重复收藏集合（按 `dateAdded` 升序保留最早一条，其余标为可一键去重的副本）。

---

## 3. 核心业务与技术链路

### 3.1 实时书签同步与无跳动刷新
1. `subscribeBookmarkChanges()` 监听 `onCreated` / `onRemoved` / `onChanged` / `onMoved` / `onChildrenReordered` / `onImportEnded`。
2. 回调经 `scheduleRefreshAllData()` 防抖 `150ms`，避免批量导入或拖拽时频繁重绘。
3. `refreshAllData()` 刷新前记录 `window.scrollY`，重绘后在 `requestAnimationFrame` 内无感恢复滚动位置；「全部书签」内分组的展开/收起采用原地 DOM 增删（不清空整个画廊），零跳动。

### 3.2 默认纯本地截屏链路（Zero-Exfiltration）
1. 用户在画廊卡片或 Spotlight 点击非排除书签时，前端发送 `REGISTER_OPEN_INTENT`（附带原始 `key`）。
2. `background.js` 在 `chrome.tabs.onCreated` 中将该新标签 `tabId` 绑定到 `tabOriginKeyMap`，即使目标网页发生 301/302 或 SSO 跳转，依然能正确归属回原书签。
3. 标签页 `status === 'complete'` 或切换激活（`onActivated`）时触发 `schedulePassiveCapture(tabId, url)`：
   - 校验 `autoCapture === true`、`meta && !meta.excluded`、是否缺图/远程待升级/已过 `ttlDays`。
   - 等待 `PASSIVE_SETTLE_MS`（`1800ms`）让页面首屏稳定渲染。
4. `captureActiveTab(tabId, targetKey)` 执行前**二次硬校验**：
   - 再次校验 `autoCapture`、`meta && !meta.excluded` 以及当前 `tab.url` 非私有/内网地址（防止重定向到内网页面被截屏）。
   - 调用 `chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 88 })`，用 `OffscreenCanvas` 顶部锚定裁切为 `640×400` WebP 并以 `source: 'capture'` 落库，随后广播 `SCREENSHOT_UPDATED` 给所有打开的 Folio 新标签页即时热更新卡片封面。

### 3.3 可选远程封面补齐链路（默认关闭，Plan A 根域名脱敏）
仅当用户在「设置 → 常规设置」中**主动打开「远程补齐封面」**（`remoteCoverEnabled: true`）后激活：

1. **五重硬门禁**：`enqueueSilentCapture`、`processSilentQueue`、`fetchSilentCoverForItem`、`onCreated`、`runPeriodicRefreshScan` 全部校验 `remoteCoverEnabled === true` 且 `meta && !meta.excluded`。
2. **Plan A 严格脱敏（`toSafePublicOrigin(rawUrl)`）**：
   - 拒绝 `http:`/`https:` 以外协议、拒绝私网/回环/CGNAT/IPv6/单段主机名、拒绝任意层级含 `internal`/`intranet`/`corp`/`lan`/`local`/`localhost` 的域名、拒绝纯 IPv4 字面量、拒绝非 80/443 自定义端口。
   - 仅返回 `${protocol}//${host}`（例如 `https://docs.google.com`），彻底剥离路径、文档 ID、`?` 参数、`#` 哈希与认证信息。
3. **无状态抓取**：
   - 优先请求 `https://s.wordpress.com/mshots/v1/${encodeURIComponent(safeOrigin)}?w=1280&h=800`（若冷启动返回生成中 GIF 则等待 `4500ms` 重试一次）。
   - 失败降级流式读取 `safeOrigin` 首页前 `90KB` `<head>` 解析 `og:image` / `twitter:image`。
   - **全部 `fetch` 均强制 `credentials: 'omit'`、`referrerPolicy: 'no-referrer'`、`cache: 'no-store'`**，绝不携带浏览器 Cookie。
4. **MV3 断点续传与防降级**：
   - 并发数 `SILENT_CONCURRENCY = 3`，剩余任务持久化在 `folio_silent_queue_v1` 并设 `2 分钟` 恢复闹钟 `folio_queue_resume` 应对 Service Worker 休眠。
   - 若某书签已有未过期的本地真实截屏（`source === 'capture'`），远程刷新不会将其降级。
   - 用户一旦关闭「远程补齐封面」或把文件夹加入排除列表，`chrome.storage.onChanged` 会立刻中止队列并清理残留项和闹钟。

---

## 4. 前后端消息协议（`chrome.runtime`）

### 前端 → Service Worker
| `type` | 载荷 | 说明 |
| :--- | :--- | :--- |
| `REGISTER_OPEN_INTENT` | `{ key, url }` | 记录点击打开意图以支持重定向截屏归属（排除项自动忽略） |
| `START_BATCH_CAPTURE` | `{ items, force }` | 触发远程补齐队列（仅 `remoteCoverEnabled: true` 生效；`force` 永不绕过排除规则） |
| `STOP_BATCH_CAPTURE` | `{}` | 立即取消正在运行的远程队列并清空持久化队列与恢复闹钟 |
| `GET_BATCH_STATE` | `{}` | 新标签页启动时同步后台批处理进度状态 |
| `PRUNE_CACHE` | `{}` | 重建书签索引并删除 IndexedDB 中已移除书签的孤儿缩略图 |

### Service Worker → 所有新标签页
| `type` | 载荷 | 说明 |
| :--- | :--- | :--- |
| `SCREENSHOT_UPDATED` | `{ key, capturedAt, size, source }` | 通知页面局部刷新对应 `key` 的所有书签卡片与收藏条缩略图 |
| `BATCH_PROGRESS` | `{ running, current, total, captured, failed, currentTitle }` | 实时更新顶部批处理进度条 `#batch-banner` |

---

## 5. URL 规范化与重复检测规则（`src/shared/url.js`）

- `normalizeUrl(rawUrl)`：去除 `#hash`、主机名转小写、剔除常见营销追踪参数（`utm_*`、`fbclid`、`gclid`、`yclid`、`mc_cid`、`mc_eid`、`spm`、`from`、`ref_src`）、对保留的功能性查询参数按 key 排序、去除路径末尾多余斜杠。
- 该规范化结果同时用作：IndexedDB 缩略图主键、收藏夹 `favoriteKeys` 主键、重复书签体检分组键与重定向归属键。
