// Unified Chrome API adapter
// Uses real chrome.* APIs inside the unpacked Chrome extension,
// and falls back to an interactive in-memory demo tree (mirroring the user's 8 folders)
// when previewed over HTTP for design verification.

import { normalizeUrl } from './url.js';
import { getThumbnail, saveThumbnail } from './db.js';

export const IS_EXTENSION = typeof chrome !== 'undefined' && Boolean(chrome.bookmarks && chrome.runtime && chrome.runtime.id);

// --- In-memory fallback state (only used outside Chrome Extension) ---
let mockIdCounter = 500;
const mockBookmarkListeners = new Set();
const mockMessageListeners = new Set();
const now = Date.now();
const day = 24 * 60 * 60 * 1000;

let mockTree = [
  {
    id: '0',
    title: '',
    children: [
      {
        id: '1',
        title: '书签栏',
        children: [
          {
            id: 'f-company',
            parentId: '1',
            title: '公司',
            children: [
              { id: 'b-1', parentId: 'f-company', title: '飞书工作台与 OKR 看板', url: 'https://feishu.cn/workbench', dateAdded: now - 1 * day },
              { id: 'b-2', parentId: 'f-company', title: '内部设计系统文档中心', url: 'https://wiki.internal.company/design', dateAdded: now - 3 * day },
              { id: 'b-3', parentId: 'f-company', title: 'Q4 需求排期与评审表', url: 'https://jira.internal.company/board', dateAdded: now - 5 * day },
              { id: 'b-4', parentId: 'f-company', title: 'Figma 团队组件库总览', url: 'https://figma.com/files/team-core', dateAdded: now - 7 * day }
            ]
          },
          {
            id: 'f-forum',
            parentId: '1',
            title: '论坛博客',
            children: [
              { id: 'b-5', parentId: 'f-forum', title: 'Hacker News', url: 'https://news.ycombinator.com', dateAdded: now - 2 * day },
              { id: 'b-6', parentId: 'f-forum', title: 'V2EX 创意工作者社区', url: 'https://v2ex.com', dateAdded: now - 6 * day },
              { id: 'b-7', parentId: 'f-forum', title: '少数派 · 高效工作与品质生活', url: 'https://sspai.com', dateAdded: now - 9 * day },
              { id: 'b-8', parentId: 'f-forum', title: 'Dribbble 精选动效合集', url: 'https://dribbble.com/shots/popular/animation', dateAdded: now - 11 * day }
            ]
          },
          {
            id: 'f-visual',
            parentId: '1',
            title: '视觉灵感',
            children: [
              { id: 'b-9', parentId: 'f-visual', title: 'Minimal Gallery · 极简网站策展', url: 'https://minimal.gallery', dateAdded: now - 0.5 * day },
              { id: 'b-10', parentId: 'f-visual', title: 'Godly · Web Design Inspiration', url: 'https://godly.website', dateAdded: now - 1.5 * day },
              { id: 'b-11', parentId: 'f-visual', title: 'Awwwards · 年度网页设计赏析', url: 'https://awwwards.com', dateAdded: now - 4 * day },
              { id: 'b-12', parentId: 'f-visual', title: 'Mobbin · 移动端与网页交互模式库', url: 'https://mobbin.com', dateAdded: now - 8 * day },
              { id: 'b-13', parentId: 'f-visual', title: 'Cosmos · 视觉情绪板与灵感收藏', url: 'https://cosmos.so', dateAdded: now - 12 * day },
              {
                id: 'f-visual-sub1',
                parentId: 'f-visual',
                title: '字体与排版',
                children: [
                  { id: 'b-14', parentId: 'f-visual-sub1', title: 'Typewolf · 现代网页字体搭配参考', url: 'https://typewolf.com', dateAdded: now - 15 * day },
                  { id: 'b-15', parentId: 'f-visual-sub1', title: 'Fonts In Use · 数字与印刷排版案例', url: 'https://fontsinuse.com', dateAdded: now - 18 * day }
                ]
              }
            ]
          },
          {
            id: 'f-sites',
            parentId: '1',
            title: '优秀个站',
            children: [
              { id: 'b-16', parentId: 'f-sites', title: 'Rauno Freiberg · 交互工程作品集', url: 'https://rauno.me', dateAdded: now - 0.8 * day },
              { id: 'b-17', parentId: 'f-sites', title: 'Emil Kowalski · 微动效与组件工艺', url: 'https://emilkowal.ski', dateAdded: now - 2.4 * day },
              { id: 'b-18', parentId: 'f-sites', title: 'Paco Coursey · 极简个人主页', url: 'https://paco.me', dateAdded: now - 10 * day },
              { id: 'b-19', parentId: 'f-sites', title: 'Linear Method · 现代软件设计哲学', url: 'https://linear.app/method', dateAdded: now - 14 * day }
            ]
          },
          {
            id: 'f-tools',
            parentId: '1',
            title: '小工具',
            children: [
              { id: 'b-20', parentId: 'f-tools', title: 'Excalidraw · 手绘风格白板工具', url: 'https://excalidraw.com', dateAdded: now - 1.2 * day },
              { id: 'b-21', parentId: 'f-tools', title: 'Easings.net · 缓动函数速查表', url: 'https://easings.net', dateAdded: now - 5.5 * day },
              { id: 'b-22', parentId: 'f-tools', title: 'Squoosh · 本地无损图片压缩', url: 'https://squoosh.app', dateAdded: now - 13 * day },
              { id: 'b-23', parentId: 'f-tools', title: 'Lucide Icons · 极简开源图标库', url: 'https://lucide.dev', dateAdded: now - 17 * day }
            ]
          },
          {
            id: 'f-code',
            parentId: '1',
            title: 'Code',
            children: [
              { id: 'b-24', parentId: 'f-code', title: 'GitHub · 代码托管与开源协作', url: 'https://github.com', dateAdded: now - 0.3 * day },
              { id: 'b-25', parentId: 'f-code', title: 'MDN Web Docs · CSS 与浏览器标准', url: 'https://developer.mozilla.org', dateAdded: now - 4.2 * day },
              { id: 'b-26', parentId: 'f-code', title: 'Tailwind CSS 文档与配色表', url: 'https://tailwindcss.com', dateAdded: now - 9.5 * day },
              { id: 'b-27', parentId: 'f-code', title: 'Vite · 下一代前端构建工具', url: 'https://vitejs.dev', dateAdded: now - 19 * day }
            ]
          },
          {
            id: 'f-spec',
            parentId: '1',
            title: '规范',
            children: [
              { id: 'b-28', parentId: 'f-spec', title: 'Apple Human Interface Guidelines', url: 'https://developer.apple.com/design/human-interface-guidelines', dateAdded: now - 3.1 * day },
              { id: 'b-29', parentId: 'f-spec', title: 'Material Design 3 交互与色彩体系', url: 'https://m3.material.io', dateAdded: now - 11.4 * day },
              { id: 'b-30', parentId: 'f-spec', title: 'WCAG 2.2 无障碍对比度标准', url: 'https://w3.org/WAI/standards-guidelines/wcag', dateAdded: now - 22 * day }
            ]
          },
          {
            id: 'f-ai',
            parentId: '1',
            title: 'AI社区',
            children: [
              { id: 'b-31', parentId: 'f-ai', title: 'Google AI Studio · Gemini 开发工作台', url: 'https://aistudio.google.com', dateAdded: now - 0.2 * day },
              { id: 'b-32', parentId: 'f-ai', title: 'Hugging Face · 开源模型与数据集社区', url: 'https://huggingface.co', dateAdded: now - 2.8 * day },
              { id: 'b-33', parentId: 'f-ai', title: 'WaytoAGI · 通往 AGI 之路知识库', url: 'https://waytoagi.com', dateAdded: now - 6.8 * day },
              { id: 'b-34', parentId: 'f-ai', title: 'GitHub Trending AI 开源项目', url: 'https://github.com/trending', dateAdded: now - 8.5 * day },
              { id: 'b-35', parentId: 'f-ai', title: 'Minimal Gallery (重复收藏示例)', url: 'https://minimal.gallery/', dateAdded: now - 25 * day }
            ]
          },
          // Two loose bookmarks on the root bookmark bar to demonstrate Inbox suggestion
          { id: 'b-36', parentId: '1', title: 'Ray.so · 优雅代码截图工具', url: 'https://ray.so', dateAdded: now - 0.6 * day },
          { id: 'b-37', parentId: '1', title: 'Read.cv · 设计师与工程师档案', url: 'https://read.cv', dateAdded: now - 1.9 * day }
        ]
      }
    ]
  }
];

function findNodeAndParent(nodes, id, parent = null) {
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (node.id === id) return { node, parent, index: i };
    if (node.children) {
      const found = findNodeAndParent(node.children, id, node);
      if (found) return found;
    }
  }
  return null;
}

function emitMockBookmarkChange() {
  for (const fn of mockBookmarkListeners) fn();
}

// Generate crisp architectural editorial preview canvases for preview mode only
const MOCK_VISUAL_PRESETS = {
  'minimal.gallery': { bg: '#F4F4F1', fg: '#151618', accent: '#1A56DB', style: 'editorial', label: 'MINIMAL GALLERY', sub: 'Hand-picked functional minimalism' },
  'godly.website': { bg: '#0E0F12', fg: '#F3F4F6', accent: '#7C9CFF', style: 'dark-poster', label: 'GODLY', sub: 'Astronomically good web design' },
  'awwwards.com': { bg: '#F7F5F2', fg: '#171717', accent: '#E04F26', style: 'grid', label: 'AWWWARDS', sub: 'Site of the Day · 8.42' },
  'mobbin.com': { bg: '#FFFFFF', fg: '#111315', accent: '#2563EB', style: 'cards', label: 'Mobbin', sub: '300,000+ real product screens' },
  'cosmos.so': { bg: '#111113', fg: '#ECECE8', accent: '#C6A87D', style: 'masonry', label: 'Cosmos', sub: 'Curated visual clusters' },
  'rauno.me': { bg: '#101114', fg: '#F2F2F2', accent: '#60A5FA', style: 'craft', label: 'Rauno Freiberg', sub: 'Interaction Craft & Interfaces' },
  'emilkowal.ski': { bg: '#FAFAFA', fg: '#141414', accent: '#18181B', style: 'editorial', label: 'Emil Kowalski', sub: 'Animations on the Web' },
  'paco.me': { bg: '#131315', fg: '#E6E6E6', accent: '#A1A1AA', style: 'minimal-type', label: 'Paco Coursey', sub: 'Building interfaces at Linear' },
  'linear.app/method': { bg: '#0B0C10', fg: '#F5F7FA', accent: '#5E6AD2', style: 'dark-poster', label: 'Linear Method', sub: 'Principles for modern software' },
  'excalidraw.com': { bg: '#FFFFFF', fg: '#1E1E2E', accent: '#6965DB', style: 'diagram', label: 'Excalidraw', sub: 'Virtual whiteboard sketch' },
  'easings.net': { bg: '#F5F7FB', fg: '#111827', accent: '#2563EB', style: 'curve', label: 'Easings.net', sub: 'cubic-bezier(0.22, 1, 0.36, 1)' },
  'github.com': { bg: '#0D1117', fg: '#E6EDF3', accent: '#2F81F7', style: 'code', label: 'GitHub', sub: 'Build and ship software' },
  'developer.mozilla.org': { bg: '#1B1B1E', fg: '#F3F4F6', accent: '#8CB4FF', style: 'docs', label: 'MDN Web Docs', sub: 'Resources for Developers' },
  'tailwindcss.com': { bg: '#0B1120', fg: '#F8FAFC', accent: '#38BDF8', style: 'code', label: 'Tailwind CSS', sub: 'Rapidly build modern websites' },
  'aistudio.google.com': { bg: '#121318', fg: '#F1F3F8', accent: '#4C8DF6', style: 'craft', label: 'Google AI Studio', sub: 'Build with Gemini models' },
  'huggingface.co': { bg: '#FAF9F5', fg: '#18181B', accent: '#D97706', style: 'cards', label: 'Hugging Face', sub: 'The AI community building the future' },
  'feishu.cn/workbench': { bg: '#F4F7FB', fg: '#141B29', accent: '#3370FF', style: 'workspace', label: '工作台 · Q4 OKR', sub: '项目进度与文档协作' },
  'wiki.internal.company/design': { bg: '#F8F9FB', fg: '#1A1D24', accent: '#1A56DB', style: 'docs', label: 'Design System v4', sub: 'Token · Grid · Components' },
  'developer.apple.com/design/human-interface-guidelines': { bg: '#F5F5F7', fg: '#1D1D1F', accent: '#0071E3', style: 'editorial', label: 'Human Interface', sub: 'Apple Design Guidelines' },
  'm3.material.io': { bg: '#F4F6FA', fg: '#1A1C1E', accent: '#0B57D0', style: 'grid', label: 'Material 3', sub: 'Google Open-Source Design System' },
  'news.ycombinator.com': { bg: '#F6F6EF', fg: '#1A1A1A', accent: '#FF6600', style: 'list', label: 'Hacker News', sub: 'Show HN · Top Stories' },
  'sspai.com': { bg: '#FAFAFA', fg: '#1D1D1F', accent: '#D71A1B', style: 'editorial', label: '少数派', sub: '高效工作，品质生活' }
};

function drawMockScreenBlob(url) {
  const key = normalizeUrl(url);
  const hostPath = key.replace(/^https?:\/\/(www\.)?/, '');
  const preset = MOCK_VISUAL_PRESETS[hostPath];
  if (!preset) return null;

  const canvas = document.createElement('canvas');
  canvas.width = 640;
  canvas.height = 400;
  const ctx = canvas.getContext('2d');

  // Background
  ctx.fillStyle = preset.bg;
  ctx.fillRect(0, 0, 640, 400);

  // Subtle top bar hairline (realistic website header)
  ctx.fillStyle = preset.fg + '10';
  ctx.fillRect(0, 0, 640, 44);
  ctx.fillStyle = preset.fg + '18';
  ctx.fillRect(0, 44, 640, 1);

  // Tiny brand dot + nav bars in top chrome
  ctx.fillStyle = preset.accent;
  ctx.beginPath();
  ctx.arc(30, 22, 5, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = preset.fg + '30';
  ctx.fillRect(46, 19, 44, 6);
  ctx.fillRect(480, 19, 32, 5);
  ctx.fillRect(524, 19, 32, 5);
  ctx.fillRect(568, 19, 40, 5);

  // Bespoke stylized page layouts per style
  if (preset.style === 'curve') {
    ctx.strokeStyle = preset.accent;
    ctx.lineWidth = 3.5;
    ctx.beginPath();
    ctx.moveTo(80, 320);
    ctx.bezierCurveTo(180, 320, 220, 110, 560, 110);
    ctx.stroke();
    ctx.strokeStyle = preset.fg + '18';
    ctx.lineWidth = 1;
    for (let y = 110; y <= 320; y += 52) {
      ctx.beginPath();
      ctx.moveTo(80, y);
      ctx.lineTo(560, y);
      ctx.stroke();
    }
  } else if (preset.style === 'cards' || preset.style === 'masonry' || preset.style === 'grid') {
    const cols = 3;
    const gap = 16;
    const w = (576 - gap * (cols - 1)) / cols;
    for (let i = 0; i < 6; i++) {
      const c = i % cols;
      const r = Math.floor(i / cols);
      const x = 32 + c * (w + gap);
      const y = 158 + r * 112;
      ctx.fillStyle = i === 0 ? preset.accent + '26' : preset.fg + '0D';
      ctx.beginPath();
      ctx.roundRect(x, y, w, 96, 8);
      ctx.fill();
      ctx.strokeStyle = preset.fg + '14';
      ctx.stroke();
    }
  } else if (preset.style === 'code' || preset.style === 'docs') {
    // Sidebar + doc/code lines
    ctx.fillStyle = preset.fg + '08';
    ctx.fillRect(32, 162, 128, 206);
    for (let i = 0; i < 6; i++) {
      ctx.fillStyle = i === 1 ? preset.accent : preset.fg + '24';
      ctx.fillRect(46, 182 + i * 24, 72 + (i % 3) * 14, 7);
    }
    for (let i = 0; i < 7; i++) {
      ctx.fillStyle = i % 3 === 0 ? preset.accent + 'AA' : preset.fg + '22';
      ctx.fillRect(184, 174 + i * 24, 220 + ((i * 53) % 190), 8);
    }
  } else if (preset.style === 'diagram') {
    ctx.strokeStyle = preset.accent;
    ctx.lineWidth = 2;
    ctx.strokeRect(86, 176, 140, 82);
    ctx.strokeStyle = preset.fg + '66';
    ctx.beginPath();
    ctx.roundRect(360, 192, 170, 88, 12);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(226, 218);
    ctx.lineTo(356, 234);
    ctx.stroke();
  } else if (preset.style === 'workspace') {
    // Three clean kanban columns
    for (let c = 0; c < 3; c++) {
      const x = 32 + c * 198;
      ctx.fillStyle = preset.fg + '08';
      ctx.beginPath();
      ctx.roundRect(x, 162, 182, 204, 8);
      ctx.fill();
      for (let r = 0; r < 3; r++) {
        ctx.fillStyle = '#FFFFFF';
        ctx.beginPath();
        ctx.roundRect(x + 10, 178 + r * 58, 162, 46, 6);
        ctx.fill();
        ctx.fillStyle = r === 0 && c === 0 ? preset.accent : preset.fg + '25';
        ctx.fillRect(x + 20, 192 + r * 58, 86, 6);
        ctx.fillStyle = preset.fg + '15';
        ctx.fillRect(x + 20, 206 + r * 58, 120, 5);
      }
    }
  } else {
    // Architectural hero frame
    const grad = ctx.createLinearGradient(32, 164, 608, 368);
    grad.addColorStop(0, preset.accent + '22');
    grad.addColorStop(1, preset.fg + '08');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.roundRect(32, 168, 576, 200, 10);
    ctx.fill();
    ctx.strokeStyle = preset.fg + '14';
    ctx.stroke();
  }

  // Page masthead typography
  ctx.fillStyle = preset.fg;
  ctx.font = '600 32px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif';
  ctx.fillText(preset.label, 32, 108);

  ctx.fillStyle = preset.fg + '8C';
  ctx.font = '400 16px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif';
  ctx.fillText(preset.sub, 32, 138);

  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), 'image/webp', 0.85);
  });
}

export async function seedMockThumbnailsIfNeeded() {
  if (IS_EXTENSION) return;
  const flat = [];
  const walk = (nodes) => {
    for (const n of nodes) {
      if (n.url) flat.push(n);
      if (n.children) walk(n.children);
    }
  };
  walk(mockTree);

  for (const bm of flat) {
    const key = normalizeUrl(bm.url);
    const existing = await getThumbnail(key);
    if (existing) continue;
    const blob = await drawMockScreenBlob(bm.url);
    if (blob) {
      await saveThumbnail(key, blob, { status: 'ok', width: 640, height: 400 });
    }
  }
}

// --- Public Unified API ---

export async function getBookmarkTree() {
  if (IS_EXTENSION) {
    return chrome.bookmarks.getTree();
  }
  return structuredClone(mockTree);
}

export async function moveBookmark(id, destination) {
  if (IS_EXTENSION) {
    return chrome.bookmarks.move(id, destination);
  }
  const found = findNodeAndParent(mockTree, id);
  const destFound = findNodeAndParent(mockTree, destination.parentId);
  if (!found || !destFound || !destFound.node.children) return null;
  found.parent.children.splice(found.index, 1);
  found.node.parentId = destFound.node.id;
  destFound.node.children.push(found.node);
  emitMockBookmarkChange();
  return found.node;
}

export async function updateBookmark(id, changes) {
  if (IS_EXTENSION) {
    return chrome.bookmarks.update(id, changes);
  }
  const found = findNodeAndParent(mockTree, id);
  if (!found || !found.node) return null;
  if (typeof changes.title === 'string') found.node.title = changes.title;
  if (typeof changes.url === 'string') found.node.url = changes.url;
  emitMockBookmarkChange();
  return found.node;
}

export async function removeBookmark(id) {
  if (IS_EXTENSION) {
    return chrome.bookmarks.remove(id);
  }
  const found = findNodeAndParent(mockTree, id);
  if (!found || !found.parent) return;
  found.parent.children.splice(found.index, 1);
  emitMockBookmarkChange();
}

export async function createBookmarkFolder(parentId, title) {
  if (IS_EXTENSION) {
    return chrome.bookmarks.create({ parentId, title });
  }
  const dest = findNodeAndParent(mockTree, parentId);
  if (!dest || !dest.node.children) return null;
  const folder = {
    id: `f-${++mockIdCounter}`,
    parentId,
    title,
    children: []
  };
  dest.node.children.push(folder);
  emitMockBookmarkChange();
  return folder;
}

export function subscribeBookmarkChanges(callback) {
  if (IS_EXTENSION) {
    chrome.bookmarks.onCreated.addListener(callback);
    chrome.bookmarks.onRemoved.addListener(callback);
    chrome.bookmarks.onChanged.addListener(callback);
    chrome.bookmarks.onMoved.addListener(callback);
    chrome.bookmarks.onChildrenReordered.addListener(callback);
    chrome.bookmarks.onImportEnded.addListener(callback);
    return () => {
      chrome.bookmarks.onCreated.removeListener(callback);
      chrome.bookmarks.onRemoved.removeListener(callback);
      chrome.bookmarks.onChanged.removeListener(callback);
      chrome.bookmarks.onMoved.removeListener(callback);
      chrome.bookmarks.onChildrenReordered.removeListener(callback);
      chrome.bookmarks.onImportEnded.removeListener(callback);
    };
  }
  mockBookmarkListeners.add(callback);
  return () => mockBookmarkListeners.delete(callback);
}

export async function loadPreferences() {
  const defaults = {
    sidebarCollapsed: false,
    ttlDays: 30,
    autoCapture: true,
    remoteCoverEnabled: false,
    launchOnNewTab: true,
    launchOnAction: true,
    launchOnStartup: false,
    launchOnShortcut: false,
    initialCapturePrompted: false,
    favoriteKeys: [],
    blurredKeys: [],
    excludedFolderIds: null
  };

  if (IS_EXTENSION) {
    const stored = await chrome.storage.local.get(Object.keys(defaults));
    return { ...defaults, ...stored };
  }
  try {
    const raw = localStorage.getItem('folio_prefs');
    return raw ? { ...defaults, ...JSON.parse(raw) } : defaults;
  } catch {
    return defaults;
  }
}

export async function savePreferences(patch) {
  if (IS_EXTENSION) {
    return chrome.storage.local.set(patch);
  }
  const current = await loadPreferences();
  localStorage.setItem('folio_prefs', JSON.stringify({ ...current, ...patch }));
}

export async function getOpenShortcutLabel() {
  const isMac = typeof navigator !== 'undefined' && /mac/i.test(navigator.platform || navigator.userAgent || '');
  const fallback = isMac ? '⌥⇧F' : 'Alt+Shift+F';
  if (IS_EXTENSION && chrome.commands?.getAll) {
    try {
      const commands = await chrome.commands.getAll();
      const cmd = commands.find((c) => c.name === 'open-folio');
      if (cmd && cmd.shortcut) return cmd.shortcut;
      if (cmd && !cmd.shortcut) return '未设置';
    } catch {
      return fallback;
    }
  }
  return fallback;
}

export async function openExtensionShortcutsPage() {
  if (IS_EXTENSION && chrome.tabs?.create) {
    await chrome.tabs.create({ url: 'chrome://extensions/shortcuts', active: true });
    return true;
  }
  return false;
}

export function subscribeRuntimeMessages(callback) {
  if (IS_EXTENSION) {
    chrome.runtime.onMessage.addListener(callback);
    return () => chrome.runtime.onMessage.removeListener(callback);
  }
  mockMessageListeners.add(callback);
  return () => mockMessageListeners.delete(callback);
}

export async function sendBackgroundMessage(message) {
  if (IS_EXTENSION) {
    return chrome.runtime.sendMessage(message);
  }
  // Demo simulation for batch capture in browser preview mode
  if (message.type === 'START_BATCH_CAPTURE') {
    const items = message.items || [];
    let count = 0;
    for (const item of items) {
      count += 1;
      for (const fn of mockMessageListeners) {
        fn({
          type: 'BATCH_PROGRESS',
          running: true,
          current: count,
          total: items.length,
          captured: count,
          failed: 0,
          currentTitle: item.title
        });
      }
      await new Promise((r) => setTimeout(r, 260));
    }
    for (const fn of mockMessageListeners) {
      fn({ type: 'BATCH_PROGRESS', running: false, current: items.length, total: items.length, captured: items.length, failed: 0, currentTitle: '' });
    }
    return { ok: true };
  }
  if (message.type === 'GET_BATCH_STATE') {
    return { running: false, current: 0, total: 0, captured: 0, failed: 0, currentTitle: '' };
  }
  if (message.type === 'PRUNE_CACHE') {
    return { ok: true, removed: 0 };
  }
  return { ok: true };
}
