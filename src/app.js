// Folio — Minimalist Visual Bookmark Gallery App Controller

import { ICONS, renderShortcutKeycapsHtml } from './icons.js';
import { stopSearchShockwave, triggerSearchShockwave, warmShockwaveEngine } from './shockwave.js';
import {
  getDisplayHost,
  getDomainHue,
  getFaviconUrl,
  isCapturableUrl,
  isLikelyInternalFolder,
  isPrivateOrInternalUrl,
  normalizeUrl,
  toSafePublicOrigin
} from './shared/url.js';
import {
  clearAllThumbnails,
  getStorageStats,
  getThumbnail,
  getThumbnailMetaMap
} from './shared/db.js';
import {
  IS_EXTENSION,
  getBookmarkTree,
  getOpenShortcutLabel,
  loadPreferences,
  moveBookmark,
  openExtensionShortcutsPage,
  removeBookmark,
  savePreferences,
  seedMockThumbnailsIfNeeded,
  sendBackgroundMessage,
  subscribeBookmarkChanges,
  subscribeRuntimeMessages,
  updateBookmark
} from './shared/chrome-bridge.js';

// New tag expires 72 hours after bookmark creation; missing-cover banner snoozes 30 days when dismissed
const NEW_TAG_TTL_MS = 72 * 60 * 60 * 1000;
const MISSING_BANNER_SNOOZE_MS = 30 * 24 * 60 * 60 * 1000;

function isNewBookmark(bm) {
  if (!bm || !bm.dateAdded) return false;
  const age = Date.now() - bm.dateAdded;
  return age >= 0 && age <= NEW_TAG_TTL_MS;
}

// --- Application State ---
const state = {
  prefs: {
    sidebarCollapsed: false,
    ttlDays: 30,
    autoCapture: true,
    remoteCoverEnabled: false,
    launchOnNewTab: true,
    launchOnAction: true,
    launchOnStartup: false,
    launchOnShortcut: false,
    initialCapturePrompted: false,
    bannerHintDismissed: false,
    missingBannerSnoozeUntil: 0,
    favoriteKeys: [],
    blurredKeys: [],
    excludedFolderIds: null
  },
  openShortcutLabel: '⌥⇧F',
  rootBarId: '1',
  topFolders: [],          // Top-level bookmark folders
  folderMap: new Map(),    // folderId -> folder node (with recursive items & children)
  allBookmarks: [],        // Flat list of all bookmarks with folder metadata
  looseBookmarks: [],      // Bookmarks sitting directly on bookmark bar / other root
  excludedKeys: new Set(), // Normalized URL keys excluded by any folder or internal host rule
  selectedFolderId: 'all', // 'all' | 'loose' | <folderId>
  activeSubfolderId: 'all',
  expandedSidebarFolders: new Set(),
  expandedGroupsInAll: new Set(),
  lastGridCols: 0,
  thumbMeta: new Map(),    // normalizedUrl -> { capturedAt, size, status }
  objectUrlCache: new Map(), // normalizedUrl -> blob objectURL
  duplicates: [],
  batch: { running: false, current: 0, total: 0, captured: 0, failed: 0, currentTitle: '' },
  bannerDone: null,        // { captured, failed } shown briefly right after a batch capture completes
  spotlight: { open: false, query: '', results: [], activeIndex: 0 },
  tidy: { open: false, tab: 'settings', stats: { count: 0, totalBytes: 0 } },
  dragBookmarkId: null,
  contextBookmarkId: null
};

// --- DOM References ---
const els = {
  app: document.getElementById('app'),
  sidebar: document.getElementById('sidebar'),
  sidebarPinned: document.getElementById('sidebar-pinned'),
  sidebarScroll: document.getElementById('sidebar-scroll'),
  sidebarBackdrop: document.getElementById('sidebar-backdrop'),
  sidebarNav: document.getElementById('sidebar-nav'),
  brandHome: document.getElementById('brand-home'),
  btnCollapseSidebar: document.getElementById('btn-collapse-sidebar'),
  btnMobileMenu: document.getElementById('btn-mobile-menu'),
  btnOpenTidy: document.getElementById('btn-open-tidy'),
  btnTopbarSearch: document.getElementById('btn-topbar-search'),
  topbar: document.getElementById('topbar'),
  batchBanner: document.getElementById('batch-banner'),
  batchBannerIndicator: document.getElementById('batch-banner-indicator'),
  batchBannerText: document.getElementById('batch-banner-text'),
  batchBarTrack: document.getElementById('batch-bar-track'),
  batchBarFill: document.getElementById('batch-bar-fill'),
  btnBannerPrimary: document.getElementById('btn-banner-primary'),
  btnBannerSecondary: document.getElementById('btn-banner-secondary'),
  subfolderBar: document.getElementById('subfolder-bar'),
  galleryRoot: document.getElementById('gallery-root'),
  galleryFooter: document.getElementById('gallery-footer'),
  btnBackToTop: document.getElementById('btn-back-to-top'),
  spotlightOverlay: document.getElementById('spotlight-overlay'),
  spotlightInput: document.getElementById('spotlight-input'),
  spotlightResults: document.getElementById('spotlight-results'),
  settingsPane: document.getElementById('settings-pane'),
  btnCloseTidy: document.getElementById('btn-close-tidy'),
  tidyTabs: document.getElementById('tidy-tabs'),
  tidyContent: document.getElementById('tidy-content'),
  movePopover: document.getElementById('move-popover'),
  cardContextMenu: document.getElementById('card-context-menu'),
  ctxRemoveBookmark: document.getElementById('ctx-remove-bookmark'),
  editBookmarkOverlay: document.getElementById('edit-bookmark-overlay'),
  editBookmarkForm: document.getElementById('edit-bookmark-form'),
  editBmTitle: document.getElementById('edit-bm-title'),
  editBmUrl: document.getElementById('edit-bm-url'),
  editBmError: document.getElementById('edit-bm-error'),
  btnEditBmCancel: document.getElementById('btn-edit-bm-cancel'),
  btnEditBmSave: document.getElementById('btn-edit-bm-save'),
  railTooltip: document.getElementById('rail-tooltip'),
  toast: document.getElementById('toast')
};

// --- Utilities ---
let toastTimer = null;
function showToast(text) {
  els.toast.textContent = text;
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    els.toast.hidden = true;
  }, 2400);
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatBytes(bytes) {
  if (!bytes || bytes < 1024) return '0 KB';
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// Single source of truth for folder icon + exact OKLCH palette token (so title color & icon gradient always match 1:1)
function getFolderVisualMeta(title, isActive = false) {
  const t = (title || '').toLowerCase();
  if (t.includes('公司') || t.includes('工作') || t.includes('work') || t.includes('company')) {
    return { icon: ICONS.glassWork, hue: 242, colorLight: 'var(--ok-blue-lo)', colorDark: 'var(--ok-blue-hi)' };
  }
  if (t.includes('论坛') || t.includes('博客') || t.includes('阅读') || t.includes('blog') || t.includes('forum')) {
    return { icon: ICONS.glassForum, hue: 206, colorLight: 'var(--ok-cyan-lo)', colorDark: 'var(--ok-cyan-hi)' };
  }
  if (t.includes('视觉') || t.includes('灵感') || t.includes('设计') || t.includes('design') || t.includes('ui')) {
    return { icon: ICONS.glassVisual, hue: 8, colorLight: 'var(--ok-rose-lo)', colorDark: 'var(--ok-rose-hi)' };
  }
  if (t.includes('个站') || t.includes('作品') || t.includes('site') || t.includes('web')) {
    return { icon: ICONS.glassGlobe, hue: 156, colorLight: 'var(--ok-emerald-lo)', colorDark: 'var(--ok-emerald-hi)' };
  }
  if (t.includes('工具') || t.includes('效率') || t.includes('tool')) {
    return { icon: ICONS.glassTools, hue: 68, colorLight: 'var(--ok-amber-lo)', colorDark: 'var(--ok-amber-hi)' };
  }
  if (t.includes('code') || t.includes('开发') || t.includes('前端') || t.includes('dev')) {
    return { icon: ICONS.glassCode, hue: 268, colorLight: 'var(--ok-indigo-lo)', colorDark: 'var(--ok-indigo-hi)' };
  }
  if (t.includes('规范') || t.includes('文档') || t.includes('spec') || t.includes('doc')) {
    return { icon: ICONS.glassSpec, hue: 182, colorLight: 'var(--ok-teal-lo)', colorDark: 'var(--ok-teal-hi)' };
  }
  if (t.includes('ai') || t.includes('大模型') || t.includes('智能')) {
    return { icon: ICONS.glassAi, hue: 304, colorLight: 'var(--ok-violet-lo)', colorDark: 'var(--ok-violet-hi)' };
  }
  return {
    icon: isActive ? ICONS.glassFolderActive : ICONS.glassFolder,
    hue: isActive ? 268 : 182,
    colorLight: 'var(--ok-indigo-lo)',
    colorDark: 'var(--ok-indigo-hi)'
  };
}

function getSidebarFolderIcon(title, isActive) {
  return getFolderVisualMeta(title, isActive).icon;
}

// --- Lazy Thumbnail Loader (IntersectionObserver + IndexedDB) ---
let thumbObserver = null;

function initThumbObserver() {
  if (thumbObserver) thumbObserver.disconnect();
  thumbObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const img = entry.target;
        thumbObserver.unobserve(img);
        loadThumbnailIntoImg(img);
      }
    },
    { rootMargin: '220px 0px' }
  );
}

async function resolveObjectUrl(key) {
  if (state.objectUrlCache.has(key)) {
    return state.objectUrlCache.get(key);
  }
  const rec = await getThumbnail(key);
  if (!rec || !rec.blob) return null;
  const objUrl = URL.createObjectURL(rec.blob);
  state.objectUrlCache.set(key, objUrl);
  return objUrl;
}

async function loadThumbnailIntoImg(img) {
  const key = img.dataset.thumbKey;
  if (!key) return;
  const objUrl = await resolveObjectUrl(key);
  if (!objUrl) return;
  img.src = objUrl;
  img.onload = () => {
    img.classList.add('is-loaded');
    img.closest('.card-stage')?.classList.add('has-thumb');
  };
}

function invalidateThumbnailUrl(key) {
  if (state.objectUrlCache.has(key)) {
    URL.revokeObjectURL(state.objectUrlCache.get(key));
    state.objectUrlCache.delete(key);
  }
}

async function refreshLiveCardsForKey(key) {
  invalidateThumbnailUrl(key);
  const imgs = document.querySelectorAll(`img.card-thumb[data-thumb-key="${CSS.escape(key)}"]`);
  for (const img of imgs) {
    await loadThumbnailIntoImg(img);
  }
}

// --- Bookmark Tree Parsing ---
function parseBookmarkTree(tree) {
  const topFolders = [];
  const folderMap = new Map();
  const allBookmarks = [];
  const looseBookmarks = [];

  const root = tree?.[0];
  const systemContainers = root?.children || [];
  if (systemContainers[0]?.id) {
    state.rootBarId = systemContainers[0].id;
  }

  function processFolder(node, topFolderId, topFolderTitle, pathParts, ancestorIds, depth) {
    const currentPath = [...pathParts, node.title];
    const currentAncestors = [...ancestorIds, node.id];
    const folderObj = {
      id: node.id,
      parentId: node.parentId,
      title: node.title || '未命名文件夹',
      topFolderId,
      topFolderTitle,
      path: currentPath.join(' / '),
      depth,
      directBookmarks: [],
      allBookmarks: [],
      subfolders: [],
      totalCount: 0
    };

    folderMap.set(folderObj.id, folderObj);

    for (let childIdx = 0; childIdx < (node.children || []).length; childIdx++) {
      const child = node.children[childIdx];
      const chromeIndex = typeof child.index === 'number' ? child.index : childIdx;
      if (child.url) {
        const bm = {
          id: child.id,
          parentId: node.id,
          chromeIndex,
          ancestorFolderIds: currentAncestors,
          title: child.title || getDisplayHost(child.url),
          url: child.url,
          key: normalizeUrl(child.url),
          host: getDisplayHost(child.url),
          dateAdded: child.dateAdded || 0,
          topFolderId,
          topFolderTitle,
          folderTitle: folderObj.title,
          folderPath: folderObj.path,
          isRootLoose: false
        };
        folderObj.directBookmarks.push(bm);
        folderObj.allBookmarks.push(bm);
        allBookmarks.push(bm);
      } else if (child.children) {
        const sub = processFolder(child, topFolderId, topFolderTitle, currentPath, currentAncestors, depth + 1);
        folderObj.subfolders.push(sub);
        folderObj.allBookmarks.push(...sub.allBookmarks);
      }
    }

    folderObj.totalCount = folderObj.allBookmarks.length;
    return folderObj;
  }

  // Flatten Chrome's default top containers ("书签栏", "其他书签", "移动设备书签")
  // so the user's real folders appear directly in the sidebar.
  for (const container of systemContainers) {
    for (let childIdx = 0; childIdx < (container.children || []).length; childIdx++) {
      const child = container.children[childIdx];
      const chromeIndex = typeof child.index === 'number' ? child.index : childIdx;
      if (child.url) {
        const bm = {
          id: child.id,
          parentId: container.id,
          chromeIndex,
          ancestorFolderIds: [container.id],
          title: child.title || getDisplayHost(child.url),
          url: child.url,
          key: normalizeUrl(child.url),
          host: getDisplayHost(child.url),
          dateAdded: child.dateAdded || 0,
          topFolderId: 'loose',
          topFolderTitle: '未归类书签',
          folderTitle: '未归类书签',
          folderPath: container.title || '书签栏',
          isRootLoose: true
        };
        looseBookmarks.push(bm);
        allBookmarks.push(bm);
      } else if (child.children) {
        const folderObj = processFolder(child, child.id, child.title || '未命名文件夹', [], [], 0);
        topFolders.push(folderObj);
      }
    }
  }

  state.topFolders = topFolders;
  state.folderMap = folderMap;
  state.allBookmarks = allBookmarks;
  state.looseBookmarks = looseBookmarks;

  // Auto-detect internal/company folders that skip cover capture on first launch
  if (!Array.isArray(state.prefs.excludedFolderIds)) {
    const detected = topFolders
      .filter((f) => isLikelyInternalFolder(f.title))
      .map((f) => f.id);
    state.prefs.excludedFolderIds = detected;
    savePreferences({ excludedFolderIds: detected });
  }
  rebuildExcludedKeySet();

  // Validate currently selected folder still exists
  if (
    state.selectedFolderId !== 'all' &&
    state.selectedFolderId !== 'loose' &&
    !folderMap.has(state.selectedFolderId)
  ) {
    state.selectedFolderId = 'all';
    state.activeSubfolderId = 'all';
  }

  // Detect exact/normalized duplicate URLs for Bookmarks Health tab
  const normMap = new Map();
  for (const bm of allBookmarks) {
    if (!bm.key) continue;
    if (!normMap.has(bm.key)) normMap.set(bm.key, []);
    normMap.get(bm.key).push(bm);
  }
  const dups = [];
  for (const [key, items] of normMap.entries()) {
    if (items.length > 1) {
      const sorted = [...items].sort((a, b) => (a.dateAdded || 0) - (b.dateAdded || 0));
      dups.push({ key, url: sorted[0].url, title: sorted[0].title, items: sorted });
    }
  }
  state.duplicates = dups;
}

// --- Theme & Preferences (Follows Browser Color Scheme) ---
const systemDarkQuery = window.matchMedia('(prefers-color-scheme: dark)');

function applyTheme() {
  const forced = new URLSearchParams(window.location.search).get('theme');
  const theme = forced === 'dark' || forced === 'light' ? forced : systemDarkQuery.matches ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', theme);
  updateCustomCursorTheme();
}

function applyLayoutPreferences() {
  const collapsed = Boolean(state.prefs.sidebarCollapsed);
  els.sidebar.classList.toggle('is-collapsed', collapsed);
  els.btnCollapseSidebar.setAttribute('aria-label', collapsed ? '展开侧边栏' : '收起侧边栏');
  try {
    localStorage.setItem('folio_sidebar_collapsed', collapsed ? '1' : '0');
  } catch {
    // Ignore storage restrictions
  }
}

function updateSegmentedControl(container, activeSelector) {
  if (!container) return;
  const options = Array.from(container.querySelectorAll('.segmented-option'));
  const thumb = container.querySelector('.segmented-thumb');
  let activeEl = null;

  for (const opt of options) {
    const match = opt.matches(activeSelector);
    opt.setAttribute('aria-selected', match ? 'true' : 'false');
    if (match) activeEl = opt;
  }

  if (thumb && activeEl) {
    requestAnimationFrame(() => {
      const left = activeEl.offsetLeft - 3;
      thumb.style.width = `${activeEl.offsetWidth}px`;
      thumb.style.transform = `translateX(${left}px)`;
    });
  }
}

// --- Sidebar Rendering (Tactile Folder Pocket Cards for folders; "全部书签" kept flat) ---
function pickFolderPeekKeys(folder) {
  if (!folder) return [null, null];
  const excludedSet = new Set(state.prefs.excludedFolderIds || []);
  if (excludedSet.has(folder.id)) return [null, null];

  const eligible = [];
  const seen = new Set();
  for (const bm of folder.allBookmarks || []) {
    if (!bm || seen.has(bm.key)) continue;
    if (isBookmarkExcludedFromCover(bm) || isBlurredKey(bm.key)) continue;
    seen.add(bm.key);
    eligible.push(bm);
  }

  // Show 2 to 4 cached local covers in an angled fan; fall back to wireframe cards when fewer than 2
  const withThumb = eligible.filter((bm) => state.thumbMeta.has(bm.key));
  const picks = withThumb.slice(0, 4).map((bm) => bm.key);
  while (picks.length < 2) picks.push(null);
  return picks;
}

function buildMiniPeekCardHtml(idx, thumbKey) {
  const keyAttr = thumbKey ? ` data-folder-thumb-key="${escapeHtml(thumbKey)}"` : '';
  const imgHtml = thumbKey ? `<img class="folder-mini-img" alt="" decoding="async" />` : '';
  return `
    <div class="folder-mini-card" data-peek-idx="${idx}"${keyAttr}>
      <div class="folder-mini-wire">
        <div class="folder-mini-wire-head">
          <span class="folder-mini-wire-dots"><i></i><i></i></span>
          <span class="folder-mini-wire-pill"></span>
        </div>
        <div class="folder-mini-wire-lines">
          <span></span>
          <span></span>
          <span></span>
        </div>
      </div>
      ${imgHtml}
    </div>
  `;
}

async function hydrateSidebarFolderThumbs() {
  const slots = els.sidebarNav?.querySelectorAll('.folder-mini-card[data-folder-thumb-key]');
  if (!slots || slots.length === 0) return;
  for (const card of slots) {
    const key = card.dataset.folderThumbKey;
    if (!key || state.excludedKeys.has(key) || isBlurredKey(key) || !state.thumbMeta.has(key)) continue;
    const objUrl = await resolveObjectUrl(key);
    if (!objUrl || !card.isConnected) continue;
    const img = card.querySelector('.folder-mini-img');
    if (img && img.src !== objUrl) {
      img.src = objUrl;
      img.classList.add('is-loaded');
    }
  }
}

// Smoothly sync active folder state in place so CSS grid-template-rows & spring fan-out animate!
function syncSidebarActiveState() {
  const items = els.sidebar?.querySelectorAll('.nav-item[data-folder-id]');
  if (!items) return;
  for (const item of items) {
    const fid = item.dataset.folderId;
    const isActive = state.selectedFolderId === fid;
    item.classList.toggle('is-active', isActive);
    if (fid !== 'all' && fid !== 'loose') {
      const folder = state.folderMap.get(fid);
      const iconEl = item.querySelector('.nav-item-icon');
      if (folder && iconEl) {
        iconEl.innerHTML = getSidebarFolderIcon(folder.title, isActive);
      }
    }
  }
}

function renderSidebar() {
  const prevScrollTop = els.sidebarScroll ? els.sidebarScroll.scrollTop : els.sidebarNav.scrollTop;

  // 1) Pinned top section ("全部书签" & optional "未归类") — stays fixed above the divider while scrolling
  const pinnedFrag = document.createDocumentFragment();
  const allBtn = document.createElement('button');
  allBtn.type = 'button';
  allBtn.className = `nav-item${state.selectedFolderId === 'all' ? ' is-active' : ''}`;
  allBtn.dataset.folderId = 'all';
  allBtn.dataset.tooltip = `全部书签 (${state.allBookmarks.length})`;
  allBtn.innerHTML = `
    <span class="nav-item-icon">${ICONS.glassAllGrid}</span>
    <span class="nav-label">全部书签</span>
    <span class="nav-count">${state.allBookmarks.length}</span>
  `;
  pinnedFrag.appendChild(allBtn);

  if (state.looseBookmarks.length > 0) {
    const looseBtn = document.createElement('button');
    looseBtn.type = 'button';
    looseBtn.className = `nav-item${state.selectedFolderId === 'loose' ? ' is-active' : ''}`;
    looseBtn.dataset.folderId = 'loose';
    looseBtn.dataset.dropFolderId = state.rootBarId;
    looseBtn.dataset.tooltip = `未归类 (${state.looseBookmarks.length})`;
    looseBtn.innerHTML = `
      <span class="nav-item-icon">${ICONS.glassInbox}</span>
      <span class="nav-label">未归类</span>
      <span class="nav-count">${state.looseBookmarks.length}</span>
    `;
    pinnedFrag.appendChild(looseBtn);
  }

  if (els.sidebarPinned) {
    els.sidebarPinned.innerHTML = '';
    els.sidebarPinned.appendChild(pinnedFrag);
  }

  // 2) Scrollable folder pocket list below the divider
  const frag = document.createDocumentFragment();

  // Nested subfolder row renderer (compact indented items under an expanded parent folder)
  function createSubfolderRow(folder) {
    const wrap = document.createElement('div');
    wrap.className = 'nav-item-wrap';

    const hasChildren = folder.subfolders.length > 0;
    const isExpanded = state.expandedSidebarFolders.has(folder.id);
    const isActive = state.selectedFolderId === folder.id;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `nav-item${isActive ? ' is-active' : ''}`;
    btn.dataset.folderId = folder.id;
    btn.dataset.dropFolderId = folder.id;
    btn.dataset.tooltip = `${folder.title} (${folder.totalCount})`;

    const chevronHtml = hasChildren
      ? `<span class="nav-chevron${isExpanded ? ' is-open' : ''}" data-toggle-expand="${folder.id}" role="button" aria-label="展开子文件夹">${ICONS.chevron}</span>`
      : '';

    btn.innerHTML = `
      ${chevronHtml}
      <span class="nav-item-icon">${getSidebarFolderIcon(folder.title, isActive)}</span>
      <span class="nav-label">${escapeHtml(folder.title)}</span>
      <span class="nav-count">${folder.totalCount}</span>
    `;

    wrap.appendChild(btn);

    if (hasChildren && isExpanded) {
      const childrenBox = document.createElement('div');
      childrenBox.className = 'nav-children';
      for (const sub of folder.subfolders) {
        childrenBox.appendChild(createSubfolderRow(sub));
      }
      wrap.appendChild(childrenBox);
    }

    return wrap;
  }

  // Top-level Tactile Folder Pocket Card renderer
  const folderList = document.createElement('div');
  folderList.className = 'nav-folder-list';

  for (const folder of state.topFolders) {
    const wrap = document.createElement('div');
    wrap.className = 'nav-item-wrap';

    const hasChildren = folder.subfolders.length > 0;
    const isExpanded = state.expandedSidebarFolders.has(folder.id);
    const isActive = state.selectedFolderId === folder.id;
    const visual = getFolderVisualMeta(folder.title, isActive);
    const peekKeys = pickFolderPeekKeys(folder);
    const peekCardsHtml = peekKeys.map((key, idx) => buildMiniPeekCardHtml(idx, key)).join('');

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `nav-item nav-folder-card${isActive ? ' is-active' : ''}`;
    btn.dataset.folderId = folder.id;
    btn.dataset.dropFolderId = folder.id;
    btn.dataset.tooltip = `${folder.title} (${folder.totalCount})`;
    btn.style.setProperty('--folder-hue', String(visual.hue));
    btn.style.setProperty('--folder-color-light', visual.colorLight);
    btn.style.setProperty('--folder-color-dark', visual.colorDark);

    const arrowAttrs = hasChildren
      ? `class="folder-pocket-arrow is-sub-toggle${isExpanded ? ' is-open' : ''}" data-toggle-expand="${escapeHtml(folder.id)}" role="button" aria-label="展开子文件夹"`
      : `class="folder-pocket-arrow" aria-hidden="true"`;

    btn.innerHTML = `
      <div class="folder-peek-slot" aria-hidden="true">
        <div class="folder-peek-inner">
          <div class="folder-peek-stage" data-peek-count="${peekKeys.length}">
            ${peekCardsHtml}
          </div>
        </div>
      </div>
      <div class="folder-pocket-face">
        <span class="nav-item-icon">${getSidebarFolderIcon(folder.title, isActive)}</span>
        <span class="folder-pocket-meta">
          <span class="nav-label">${escapeHtml(folder.title)}</span>
          <span class="folder-pocket-count">${folder.totalCount} 项</span>
        </span>
        <span ${arrowAttrs}>${ICONS.chevron}</span>
      </div>
    `;

    wrap.appendChild(btn);

    if (hasChildren && isExpanded) {
      const childrenBox = document.createElement('div');
      childrenBox.className = 'nav-children';
      for (const sub of folder.subfolders) {
        childrenBox.appendChild(createSubfolderRow(sub));
      }
      wrap.appendChild(childrenBox);
    }

    folderList.appendChild(wrap);
  }

  frag.appendChild(folderList);
  els.sidebarNav.innerHTML = '';
  els.sidebarNav.appendChild(frag);
  if (prevScrollTop > 0) {
    if (els.sidebarScroll) els.sidebarScroll.scrollTop = prevScrollTop;
    else els.sidebarNav.scrollTop = prevScrollTop;
  }
  hydrateSidebarFolderThumbs();
}

function isBlurredKey(key) {
  return Array.isArray(state.prefs.blurredKeys) && state.prefs.blurredKeys.includes(key);
}

async function toggleBlurKey(key) {
  const current = Array.isArray(state.prefs.blurredKeys) ? [...state.prefs.blurredKeys] : [];
  const idx = current.indexOf(key);
  let blurred = false;
  if (idx >= 0) {
    current.splice(idx, 1);
  } else {
    current.push(key);
    blurred = true;
  }
  state.prefs.blurredKeys = current;
  await savePreferences({ blurredKeys: current });

  const esc = CSS.escape(key);
  document.querySelectorAll(`.bookmark-card[data-key="${esc}"]`).forEach((card) => {
    card.classList.toggle('is-cover-blurred', blurred);
  });
  document.querySelectorAll(`.card-action-btn[data-action="toggle-blur"][data-key="${esc}"]`).forEach((btn) => {
    btn.classList.toggle('is-active', blurred);
    btn.setAttribute('aria-pressed', blurred ? 'true' : 'false');
    btn.setAttribute('aria-label', blurred ? '显示封面' : '隐藏封面');
    btn.innerHTML = blurred ? ICONS.eyeOff : ICONS.eye;
  });

  // Never let a newly blurred bookmark remain visible in sidebar folder pocket mini-cards
  renderSidebar();
}

function isFavoriteKey(key) {
  return Array.isArray(state.prefs.favoriteKeys) && state.prefs.favoriteKeys.includes(key);
}

function getFavoriteBookmarks() {
  const keys = Array.isArray(state.prefs.favoriteKeys) ? state.prefs.favoriteKeys : [];
  if (keys.length === 0) return [];
  const byKey = new Map();
  for (const bm of state.allBookmarks) {
    if (!byKey.has(bm.key)) byKey.set(bm.key, bm);
  }
  const result = [];
  for (const key of keys) {
    const bm = byKey.get(key);
    if (bm) result.push(bm);
  }
  return result;
}

async function toggleFavoriteKey(key, title = '') {
  const current = Array.isArray(state.prefs.favoriteKeys) ? [...state.prefs.favoriteKeys] : [];
  const idx = current.indexOf(key);
  let added = false;
  if (idx >= 0) {
    current.splice(idx, 1);
  } else {
    current.push(key);
    added = true;
  }
  state.prefs.favoriteKeys = current;
  await savePreferences({ favoriteKeys: current });

  // Sync star buttons in place without jarring full gallery re-animation
  document.querySelectorAll(`.card-fav-btn[data-key="${CSS.escape(key)}"]`).forEach((btn) => {
    btn.classList.toggle('is-favorited', added);
    btn.setAttribute('aria-pressed', added ? 'true' : 'false');
    btn.setAttribute('aria-label', added ? '取消收藏' : '加入顶部收藏');
    btn.innerHTML = added ? ICONS.starFilled : ICONS.star;
  });

  if (state.selectedFolderId === 'all') {
    syncFavoritesSection();
  }

  showToast(added ? `已添加到顶部收藏${title ? ` · ${title}` : ''}` : '已从顶部收藏移除');
}

function buildFavoritesSectionElement() {
  const favs = getFavoriteBookmarks();
  if (favs.length === 0) return null;

  const section = document.createElement('section');
  section.id = 'favorites-section';
  section.className = 'favorites-section';

  section.innerHTML = `
    <div class="gallery-section-header">
      <div class="section-heading-group">
        <h2 class="section-heading">收藏</h2>
        <span class="section-count">${favs.length}</span>
      </div>
    </div>
    <div class="favorites-rail"></div>
  `;

  const rail = section.querySelector('.favorites-rail');
  rail.dataset.sortKind = 'favorites';
  rail.dataset.gridLabel = '收藏';
  favs.forEach((bm, idx) => {
    rail.appendChild(createCardElement(bm, idx));
  });

  return section;
}

function createViewAllCard(group, index) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'view-all-card';
  btn.style.setProperty('--stagger-i', String(Math.min(index, 12)));
  btn.dataset.jumpFolder = group.id;
  btn.setAttribute('aria-label', `查看「${group.title}」全部 ${group.items.length} 个书签`);
  btn.innerHTML = `
    <div class="view-all-stage">
      <span class="view-all-icon">${ICONS.arrowRight}</span>
      <span class="view-all-label">查看全部</span>
      <span class="view-all-count">共 ${group.items.length} 项</span>
    </div>
  `;
  return btn;
}

function syncFavoritesSection() {
  const existing = document.getElementById('favorites-section');
  const next = buildFavoritesSectionElement();
  if (!next) {
    if (existing) existing.remove();
    return;
  }
  if (existing) {
    existing.replaceWith(next);
  } else {
    els.galleryRoot.prepend(next);
  }
}

// --- Card Element Builder ---
function createCardElement(bm, index) {
  const card = document.createElement('article');
  const isBlurred = isBlurredKey(bm.key);
  card.className = `bookmark-card${isBlurred ? ' is-cover-blurred' : ''}`;
  card.style.setProperty('--stagger-i', String(Math.min(index, 12)));
  card.style.setProperty('--card-hue', String(getDomainHue(bm.url)));
  card.dataset.bookmarkId = bm.id;
  card.dataset.key = bm.key;

  const faviconUrl = getFaviconUrl(bm.url, 32);
  const initialLetter = escapeHtml((bm.host || bm.title || '?')[0].toUpperCase());
  const hideCover = isBookmarkExcludedFromCover(bm);
  const hasThumbMeta = !hideCover && state.thumbMeta.has(bm.key);
  const cachedObjUrl = hasThumbMeta ? state.objectUrlCache.get(bm.key) || null : null;
  const isNew = isNewBookmark(bm);
  const isFav = isFavoriteKey(bm.key);
  const subtitle = bm.host;

  const faviconSmallHtml = faviconUrl
    ? `<img class="card-favicon" src="${escapeHtml(faviconUrl)}" alt="" loading="lazy" onerror="this.style.display='none'" />`
    : `<span class="card-favicon-fallback" aria-hidden="true">${initialLetter}</span>`;

  const placeholderFaviconHtml = faviconUrl
    ? `<img class="placeholder-favicon" src="${escapeHtml(faviconUrl)}" alt="" loading="lazy" />`
    : `<span class="placeholder-letter">${initialLetter}</span>`;

  card.innerHTML = `
    <div class="card-stage${cachedObjUrl ? ' has-thumb' : ''}">
      <a href="${escapeHtml(bm.url)}" class="card-link" draggable="false" target="_blank" rel="noopener noreferrer" aria-label="${escapeHtml(bm.title)}">
        <div class="card-placeholder">
          <div class="placeholder-chrome" aria-hidden="true">
            <span class="placeholder-dot"></span>
            <span class="placeholder-dot"></span>
            <span class="placeholder-dot"></span>
          </div>
          <div class="placeholder-icon-wrap">${placeholderFaviconHtml}</div>
          <span class="placeholder-host">${escapeHtml(bm.host)}</span>
        </div>
        ${hideCover ? '' : `<img class="card-thumb${cachedObjUrl ? ' is-loaded' : ''}"${cachedObjUrl ? ` src="${cachedObjUrl}" decoding="sync"` : ' decoding="async"'} data-thumb-key="${escapeHtml(bm.key)}" draggable="false" alt="" />`}
        <div class="card-blur-veil" aria-hidden="true">${ICONS.eyeOff}</div>
      </a>
      <div class="card-actions">
        <button type="button" class="card-action-btn${isBlurred ? ' is-active' : ''}" data-action="toggle-blur" data-id="${escapeHtml(bm.id)}" data-key="${escapeHtml(bm.key)}" aria-label="${isBlurred ? '显示封面' : '隐藏封面'}" aria-pressed="${isBlurred ? 'true' : 'false'}">${isBlurred ? ICONS.eyeOff : ICONS.eye}</button>
        ${!hideCover && state.prefs.remoteCoverEnabled && toSafePublicOrigin(bm.url) ? `<button type="button" class="card-action-btn" data-action="recapture" data-id="${escapeHtml(bm.id)}" aria-label="重新抓取首屏">${ICONS.refresh}</button>` : ''}
        <button type="button" class="card-action-btn" data-action="copy" data-id="${escapeHtml(bm.id)}" aria-label="复制链接">${ICONS.copy}</button>
        <button type="button" class="card-action-btn" data-action="move" data-id="${escapeHtml(bm.id)}" aria-label="移动到其他文件夹">${ICONS.move}</button>
      </div>
      <button type="button" class="card-fav-btn${isFav ? ' is-favorited' : ''}" data-action="favorite" data-id="${escapeHtml(bm.id)}" data-key="${escapeHtml(bm.key)}" aria-label="${isFav ? '取消收藏' : '加入顶部收藏'}" aria-pressed="${isFav ? 'true' : 'false'}">${isFav ? ICONS.starFilled : ICONS.star}</button>
    </div>
    <a href="${escapeHtml(bm.url)}" class="card-meta" draggable="false" target="_blank" rel="noopener noreferrer">
      <span class="card-meta-leading" aria-hidden="true">
        ${faviconSmallHtml}
        <span class="card-drag-handle">${ICONS.gripVertical}</span>
      </span>
      <div class="card-text">
        <div class="card-title-row">
          <span class="card-title">${escapeHtml(bm.title)}</span>
          ${isNew ? `<span class="card-new-tag" data-added="${bm.dateAdded}" title="72 小时内新收藏">New</span>` : ''}
        </div>
        <span class="card-sub">${escapeHtml(subtitle)}</span>
      </div>
    </a>
  `;

  // Observe thumbnail image for lazy IndexedDB decoding only if not already warm in memory
  const thumbImg = card.querySelector('img.card-thumb');
  if (thumbImg && hasThumbMeta && !cachedObjUrl) {
    thumbObserver.observe(thumbImg);
  }

  return card;
}

// --- Main Gallery View Rendering ---
function renderSubfolderBar() {
  // Subfolders are now rendered inline as continuous scrollable sections inside the folder view
  els.subfolderBar.hidden = true;
  els.subfolderBar.innerHTML = '';
}

function getGridColumnCount() {
  if (window.innerWidth <= 720) return 1;
  const style = getComputedStyle(els.galleryRoot);
  const padX = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
  const innerWidth = Math.max(220, els.galleryRoot.clientWidth - padX);
  const minCard = 220;
  const colGap = 16;
  return Math.min(4, Math.max(1, Math.floor((innerWidth + colGap) / (minCard + colGap))));
}

function getGroupPreviewLimit() {
  const cols = getGridColumnCount();
  state.lastGridCols = cols;
  return cols === 1 ? 6 : cols * 2; // Exactly 2 full rows on desktop/tablet
}

function updateFooterVisibility() {
  if (!els.galleryFooter) return;
  els.galleryFooter.hidden = state.allBookmarks.length === 0;
}

let galleryEnterTimer = 0;

function renderGallery(options = {}) {
  const animateEnter = Boolean(options.animate);
  clearTimeout(galleryEnterTimer);
  els.galleryRoot.classList.toggle('is-entering', animateEnter);
  if (animateEnter) {
    galleryEnterTimer = setTimeout(() => {
      els.galleryRoot.classList.remove('is-entering');
    }, 420);
  }

  initThumbObserver();
  renderSubfolderBar();

  const root = els.galleryRoot;
  root.innerHTML = '';

  if (state.allBookmarks.length === 0) {
    root.innerHTML = `
      <div class="empty-state">
        <h2 class="empty-title">还没有书签</h2>
        <p class="empty-desc">在 Chrome 中添加任意书签或文件夹，这里会自动同步并展示网页首屏画廊。</p>
      </div>
    `;
    return;
  }

  // View 1: All Bookmarks -> Grouped by Folder
  if (state.selectedFolderId === 'all') {
    const groups = [];
    for (const folder of state.topFolders) {
      if (folder.allBookmarks.length > 0) {
        groups.push({ id: folder.id, title: folder.title, items: folder.allBookmarks });
      }
    }
    if (state.looseBookmarks.length > 0) {
      groups.push({ id: 'loose', title: '未归类书签', items: state.looseBookmarks });
    }

    const frag = document.createDocumentFragment();
    const favSection = buildFavoritesSectionElement();
    if (favSection) {
      frag.appendChild(favSection);
    }

    let cardOffset = 0;
    const previewLimit = getGroupPreviewLimit();
    const maxBookmarksCollapsed = Math.max(1, previewLimit - 1);

    for (const group of groups) {
      const section = document.createElement('section');
      section.className = 'gallery-section';
      section.dataset.groupId = group.id;

      const isExpanded = state.expandedGroupsInAll.has(group.id);
      const limit = isExpanded ? group.items.length : maxBookmarksCollapsed;
      const visibleItems = group.items.slice(0, limit);
      const hiddenCount = Math.max(0, group.items.length - visibleItems.length);
      const canCollapse = isExpanded && group.items.length > maxBookmarksCollapsed;

      section.innerHTML = `
        <div class="gallery-section-header">
          <div class="section-heading-group">
            <h2 class="section-heading">${escapeHtml(group.title)}</h2>
            <span class="section-count">${group.items.length}</span>
          </div>
          <div class="section-actions">
            ${hiddenCount > 0 ? `<button type="button" class="text-action is-accent" data-expand-group="${escapeHtml(group.id)}">展开</button>` : ''}
            ${canCollapse ? `<button type="button" class="text-action" data-collapse-group="${escapeHtml(group.id)}">收起</button>` : ''}
          </div>
        </div>
        <div class="card-grid"></div>
      `;

      const grid = section.querySelector('.card-grid');
      grid.dataset.sortKind = 'bookmarks';
      grid.dataset.gridFolderId = group.id === 'loose' ? state.rootBarId : group.id;
      grid.dataset.gridLabel = group.title;
      for (const bm of visibleItems) {
        grid.appendChild(createCardElement(bm, cardOffset++));
      }
      if (!isExpanded) {
        grid.appendChild(createViewAllCard(group, cardOffset++));
      }
      frag.appendChild(section);
    }

    root.appendChild(frag);
    updateFooterVisibility();
    return;
  }

  // View 2: Single Folder View (all direct bookmarks + nested subfolders rendered as continuous scrollable sections)
  const selectedFolder = state.selectedFolderId === 'loose' ? null : state.folderMap.get(state.selectedFolderId);
  const items = selectedFolder ? selectedFolder.allBookmarks : state.looseBookmarks;
  const folderName = state.selectedFolderId === 'loose' ? '未归类书签' : selectedFolder?.title || '书签';
  updateFooterVisibility();

  const folderHeader = document.createElement('div');
  folderHeader.className = 'folder-view-header';
  folderHeader.innerHTML = `
    <h1 class="folder-view-title">${escapeHtml(folderName)}</h1>
    <span class="section-count">${items.length}</span>
  `;
  root.appendChild(folderHeader);

  if (items.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.innerHTML = `
      <h2 class="empty-title">该文件夹暂时为空</h2>
      <p class="empty-desc">你可以直接从其他分组拖动书签卡片到左侧这个文件夹，或在 Chrome 书签栏中收藏新网页。</p>
    `;
    root.appendChild(empty);
    return;
  }

  // If this folder has nested subfolders, show direct items first followed by each subfolder section
  if (selectedFolder && selectedFolder.subfolders.length > 0) {
    const frag = document.createDocumentFragment();
    let cardOffset = 0;

    if (selectedFolder.directBookmarks.length > 0) {
      const directGrid = document.createElement('div');
      directGrid.className = 'card-grid';
      directGrid.dataset.sortKind = 'bookmarks';
      directGrid.dataset.gridFolderId = selectedFolder.id;
      directGrid.dataset.gridLabel = selectedFolder.title;
      for (const bm of selectedFolder.directBookmarks) {
        directGrid.appendChild(createCardElement(bm, cardOffset++));
      }
      frag.appendChild(directGrid);
    }

    const walkSubfolders = (subs, prefixParts = []) => {
      for (const sub of subs) {
        const labelParts = [...prefixParts, sub.title];
        if (sub.directBookmarks.length > 0) {
          const section = document.createElement('section');
          section.className = 'gallery-section';
          section.innerHTML = `
            <div class="gallery-section-header">
              <div class="section-heading-group">
                <h2 class="subfolder-section-heading">${escapeHtml(labelParts.join(' / '))}</h2>
                <span class="section-count">${sub.directBookmarks.length}</span>
              </div>
            </div>
            <div class="card-grid"></div>
          `;
          const subGrid = section.querySelector('.card-grid');
          subGrid.dataset.sortKind = 'bookmarks';
          subGrid.dataset.gridFolderId = sub.id;
          subGrid.dataset.gridLabel = sub.title;
          for (const bm of sub.directBookmarks) {
            subGrid.appendChild(createCardElement(bm, cardOffset++));
          }
          frag.appendChild(section);
        }
        if (sub.subfolders.length > 0) {
          walkSubfolders(sub.subfolders, labelParts);
        }
      }
    };

    walkSubfolders(selectedFolder.subfolders);
    root.appendChild(frag);
    return;
  }

  const grid = document.createElement('div');
  grid.className = 'card-grid';
  grid.dataset.sortKind = 'bookmarks';
  grid.dataset.gridFolderId = state.selectedFolderId === 'loose' ? state.rootBarId : selectedFolder?.id || state.rootBarId;
  grid.dataset.gridLabel = folderName;
  items.forEach((bm, idx) => {
    grid.appendChild(createCardElement(bm, idx));
  });
  root.appendChild(grid);
}

// --- Unified Smart Status Banner (Progress + Completion + Lightweight Onboarding Guide) ---
let bannerDoneTimer = 0;

function clearBannerDone() {
  clearTimeout(bannerDoneTimer);
  bannerDoneTimer = 0;
  state.bannerDone = null;
}

function getCapturablePublicBookmarks() {
  const seen = new Set();
  const list = [];
  for (const b of state.allBookmarks) {
    if (!b || seen.has(b.key)) continue;
    if (isBookmarkExcludedFromCover(b) || !toSafePublicOrigin(b.url)) continue;
    seen.add(b.key);
    list.push(b);
  }
  return list;
}

function renderBatchBanner() {
  if (!els.batchBanner) return;
  const b = state.batch;

  // State 1: Actively capturing remote covers (highest priority)
  if (b.running) {
    els.batchBanner.hidden = false;
    els.batchBanner.dataset.state = 'capturing';
    els.batchBannerIndicator.innerHTML = `<span class="batch-spinner"></span>`;
    const pct = b.total > 0 ? Math.round((b.current / b.total) * 100) : 0;
    els.batchBannerText.textContent = `正在静默补齐首屏 (${b.current}/${b.total}) · ${b.currentTitle || ''}`;
    els.batchBarTrack.hidden = false;
    els.batchBarFill.style.width = `${pct}%`;
    els.btnBannerPrimary.hidden = true;
    els.btnBannerSecondary.hidden = false;
    els.btnBannerSecondary.dataset.bannerAction = 'stop-batch';
    els.btnBannerSecondary.textContent = '停止';
    return;
  }

  // State 2: Brief completion confirmation right after batch finishes
  if (state.bannerDone) {
    els.batchBanner.hidden = false;
    els.batchBanner.dataset.state = 'done';
    els.batchBannerIndicator.innerHTML = `<span class="batch-status-dot is-success"></span>`;
    els.batchBannerText.textContent = `已完成本次封面补齐（更新 ${state.bannerDone.captured} 张），后续浏览网页时将自动本地刷新`;
    els.batchBarTrack.hidden = true;
    els.btnBannerPrimary.hidden = true;
    els.btnBannerSecondary.hidden = false;
    els.btnBannerSecondary.dataset.bannerAction = 'dismiss-done';
    els.btnBannerSecondary.textContent = '知道了';
    return;
  }

  const publicBms = getCapturablePublicBookmarks();
  const coveredPublicCount = publicBms.filter((bm) => state.thumbMeta.has(bm.key)).length;
  const missingPublic = publicBms.filter((bm) => !state.thumbMeta.has(bm.key));

  // State 3: Pure-local zero-cover lightweight guide (auto-disappears forever once 1st local cover is captured)
  if (
    !state.prefs.remoteCoverEnabled &&
    !state.prefs.bannerHintDismissed &&
    publicBms.length > 0 &&
    coveredPublicCount === 0
  ) {
    els.batchBanner.hidden = false;
    els.batchBanner.dataset.state = 'local-empty';
    els.batchBannerIndicator.innerHTML = `<span class="batch-status-dot"></span>`;
    els.batchBannerText.textContent = '当前为纯本地模式：点开任意书签浏览约 2 秒即可本地生成首屏封面';
    els.batchBarTrack.hidden = true;
    els.btnBannerPrimary.hidden = false;
    els.btnBannerPrimary.dataset.bannerAction = 'enable-and-backfill';
    els.btnBannerPrimary.textContent = '补齐公网封面';
    els.btnBannerSecondary.hidden = false;
    els.btnBannerSecondary.dataset.bannerAction = 'dismiss-local-hint';
    els.btnBannerSecondary.textContent = '知道了';
    return;
  }

  // State 4: Remote cover enabled with remaining missing public covers (respects 30-day snooze)
  if (
    state.prefs.remoteCoverEnabled &&
    Date.now() >= (Number(state.prefs.missingBannerSnoozeUntil) || 0) &&
    missingPublic.length > 0
  ) {
    els.batchBanner.hidden = false;
    els.batchBanner.dataset.state = 'remote-missing';
    els.batchBannerIndicator.innerHTML = `<span class="batch-status-dot"></span>`;
    els.batchBannerText.textContent = `还有 ${missingPublic.length} 个公网书签暂缺首屏封面（仅按根域名补齐）`;
    els.batchBarTrack.hidden = true;
    els.btnBannerPrimary.hidden = false;
    els.btnBannerPrimary.dataset.bannerAction = 'start-backfill';
    els.btnBannerPrimary.textContent = '立即补齐';
    els.btnBannerSecondary.hidden = false;
    els.btnBannerSecondary.dataset.bannerAction = 'dismiss-missing-hint';
    els.btnBannerSecondary.textContent = '忽略';
    return;
  }

  els.batchBanner.hidden = true;
  els.batchBanner.dataset.state = 'hidden';
}

function rebuildExcludedKeySet() {
  const excludedFolderSet = new Set(state.prefs.excludedFolderIds || []);
  const keys = new Set();
  for (const bm of state.allBookmarks) {
    const inExcludedFolder = Array.isArray(bm.ancestorFolderIds)
      ? bm.ancestorFolderIds.some((id) => excludedFolderSet.has(id))
      : excludedFolderSet.has(bm.topFolderId) || excludedFolderSet.has(bm.parentId);
    if (inExcludedFolder || !isCapturableUrl(bm.url) || isPrivateOrInternalUrl(bm.url)) {
      keys.add(bm.key);
    }
  }
  state.excludedKeys = keys;
}

function isBookmarkExcludedFromCover(bm) {
  if (!bm || !isCapturableUrl(bm.url) || isPrivateOrInternalUrl(bm.url)) return true;
  if (state.excludedKeys.has(bm.key)) return true;
  const excludedSet = new Set(state.prefs.excludedFolderIds || []);
  if (Array.isArray(bm.ancestorFolderIds)) {
    return bm.ancestorFolderIds.some((id) => excludedSet.has(id));
  }
  return excludedSet.has(bm.topFolderId) || excludedSet.has(bm.parentId);
}

function getMissingCapturableBookmarks() {
  return state.allBookmarks.filter(
    (b) => !isBookmarkExcludedFromCover(b) && Boolean(toSafePublicOrigin(b.url)) && !state.thumbMeta.has(b.key)
  );
}

// --- Spotlight Search ---
function syncScrollLock() {
  const locked = Boolean(
    state.spotlight.open ||
      (els.editBookmarkOverlay && !els.editBookmarkOverlay.hidden)
  );
  document.documentElement.classList.toggle('is-scroll-locked', locked);
}

function triggerSpotlightMetallicEdge() {
  const dialog = els.spotlightOverlay?.querySelector('.spotlight-dialog');
  if (!dialog) return;
  dialog.classList.remove('is-shimmering');
  // Force reflow so rapid re-triggers cleanly restart the 900ms metallic sweep
  void dialog.offsetWidth;
  dialog.classList.add('is-shimmering');
}

function openSpotlight(initialChar = '') {
  state.spotlight.open = true;
  els.spotlightOverlay.hidden = false;
  els.spotlightOverlay.setAttribute('aria-hidden', 'false');
  els.app.classList.add('is-spotlight-open');
  syncScrollLock();
  els.spotlightInput.value = initialChar;
  els.spotlightInput.focus();
  updateSpotlightResults(initialChar);
  triggerSpotlightMetallicEdge();
  // Synchronous 0ms launch — full-viewport wave distortion + prismatic shockwave
  triggerSearchShockwave({ hostOverlay: els.spotlightOverlay });
}

function closeSpotlight() {
  if (!state.spotlight.open) return;
  stopSearchShockwave();
  const dialog = els.spotlightOverlay?.querySelector('.spotlight-dialog');
  if (dialog) dialog.classList.remove('is-shimmering');
  state.spotlight.open = false;
  els.spotlightOverlay.hidden = true;
  els.spotlightOverlay.setAttribute('aria-hidden', 'true');
  els.app.classList.remove('is-spotlight-open');
  syncScrollLock();
}

function updateSpotlightResults(query) {
  const q = (query || '').trim().toLowerCase();
  state.spotlight.query = q;

  let matches;
  if (!q) {
    matches = [...state.allBookmarks]
      .sort((a, b) => (b.dateAdded || 0) - (a.dateAdded || 0))
      .slice(0, 10);
  } else {
    const tokens = q.split(/\s+/).filter(Boolean);
    matches = state.allBookmarks
      .filter((bm) => {
        const hay = `${bm.title} ${bm.url} ${bm.folderPath}`.toLowerCase();
        return tokens.every((t) => hay.includes(t));
      })
      .slice(0, 16);
  }

  state.spotlight.results = matches;
  state.spotlight.activeIndex = 0;
  renderSpotlightList();
}

async function renderSpotlightList() {
  const list = els.spotlightResults;
  if (state.spotlight.results.length === 0) {
    list.innerHTML = `<div class="spotlight-empty">没有找到匹配的书签</div>`;
    return;
  }

  list.innerHTML = state.spotlight.results
    .map((bm, idx) => {
      const favicon = getFaviconUrl(bm.url, 32);
      const selected = idx === state.spotlight.activeIndex ? ' is-selected' : '';
      return `
        <a href="${escapeHtml(bm.url)}" class="spotlight-item${selected}" target="_blank" rel="noopener noreferrer" data-spotlight-idx="${idx}" role="option" aria-selected="${idx === state.spotlight.activeIndex}">
          <div class="spotlight-mini-thumb${isBlurredKey(bm.key) ? ' is-cover-blurred' : ''}" data-spot-key="${escapeHtml(bm.key)}">
            ${favicon ? `<img src="${escapeHtml(favicon)}" alt="" style="width:16px;height:16px;object-fit:contain;" />` : `<span>${escapeHtml(bm.host[0]?.toUpperCase() || '·')}</span>`}
          </div>
          <div class="spotlight-item-text">
            <span class="spotlight-item-title">${escapeHtml(bm.title)}</span>
            <span class="spotlight-item-sub">${escapeHtml(bm.folderPath)} · ${escapeHtml(bm.host)}</span>
          </div>
        </a>
      `;
    })
    .join('');

  // Hydrate mini thumbnails from cache if available (respecting excluded folders)
  for (const bm of state.spotlight.results) {
    if (isBookmarkExcludedFromCover(bm) || !state.thumbMeta.has(bm.key)) continue;
    const objUrl = await resolveObjectUrl(bm.key);
    if (!objUrl) continue;
    const box = list.querySelector(`.spotlight-mini-thumb[data-spot-key="${CSS.escape(bm.key)}"]`);
    if (box) {
      box.innerHTML = `<img src="${objUrl}" alt="" />`;
    }
  }
}

// --- Right Split-Pane Settings Panel ---
async function openTidyDrawer(defaultTab = 'settings') {
  suppressOverlayScrollbars(340);
  state.tidy.open = true;
  state.tidy.tab = defaultTab;
  const [stats, shortcutLabel] = await Promise.all([getStorageStats(), getOpenShortcutLabel()]);
  state.tidy.stats = stats;
  state.openShortcutLabel = shortcutLabel;
  els.settingsPane.classList.add('is-open');
  els.settingsPane.setAttribute('aria-hidden', 'false');
  els.btnOpenTidy.classList.add('is-active');
  els.btnOpenTidy.setAttribute('aria-expanded', 'true');
  renderTidyContent();
  requestAnimationFrame(() => {
    updateSegmentedControl(els.tidyTabs, `[data-tab="${defaultTab}"]`);
  });
}

function closeTidyDrawer() {
  suppressOverlayScrollbars(340);
  state.tidy.open = false;
  els.settingsPane.classList.remove('is-open');
  els.settingsPane.setAttribute('aria-hidden', 'true');
  els.btnOpenTidy.classList.remove('is-active');
  els.btnOpenTidy.setAttribute('aria-expanded', 'false');
}

function buildDrawerMiniThumbHtml(bm) {
  const favicon = getFaviconUrl(bm.url, 32);
  const initial = escapeHtml((bm.host || bm.title || '?')[0].toUpperCase());
  const hue = getDomainHue(bm.url);
  const hideCover = isBookmarkExcludedFromCover(bm);
  const fallback = favicon
    ? `<img class="drawer-mini-fav" src="${escapeHtml(favicon)}" alt="" loading="lazy" />`
    : `<span class="drawer-mini-letter" aria-hidden="true">${initial}</span>`;
  return `<div class="drawer-mini-thumb" style="--card-hue:${hue}"${hideCover ? '' : ` data-drawer-thumb-key="${escapeHtml(bm.key)}"`}>${fallback}</div>`;
}

async function hydrateDrawerMiniThumbs(container) {
  const boxes = container.querySelectorAll('.drawer-mini-thumb[data-drawer-thumb-key]');
  for (const box of boxes) {
    const key = box.dataset.drawerThumbKey;
    if (!key || !state.thumbMeta.has(key)) continue;
    const objUrl = await resolveObjectUrl(key);
    if (!objUrl || !box.isConnected) continue;
    box.innerHTML = `<img class="drawer-mini-shot" src="${objUrl}" alt="" decoding="async" />`;
  }
}

function renderTidyContent() {
  const container = els.tidyContent;

  if (state.tidy.tab === 'health') {
    const publicBookmarks = state.allBookmarks.filter((b) => !isBookmarkExcludedFromCover(b));
    const missingPublic = publicBookmarks.filter((b) => !state.thumbMeta.has(b.key));
    const coveredCount = publicBookmarks.length - missingPublic.length;

    const dupRowsHtml =
      state.duplicates.length > 0
        ? state.duplicates
            .map((dup) => {
              const keep = dup.items[0];
              const extras = dup.items.slice(1);
              return `
                <div class="settings-item-row">
                  ${buildDrawerMiniThumbHtml(keep)}
                  <div class="settings-item-main">
                    <span class="settings-item-title">${escapeHtml(dup.title)}</span>
                    <span class="settings-item-desc">保留「${escapeHtml(keep.folderPath)}」 · 重复于 ${extras.map((e) => `「${escapeHtml(e.folderPath)}」`).join('、')}</span>
                  </div>
                  <button type="button" class="text-action is-danger tidy-row-action" data-tidy-dedupe="${escapeHtml(extras.map((e) => e.id).join(','))}">删除</button>
                </div>
              `;
            })
            .join('')
        : `<div class="settings-item-row"><div class="settings-item-main"><span class="settings-item-desc">无重复书签</span></div></div>`;

    container.innerHTML = `
      <section class="settings-card">
        <div class="settings-card-head">
          <h3 class="settings-card-title">封面覆盖</h3>
        </div>
        <div class="settings-stat-grid">
          <div class="settings-stat-box">
            <span class="settings-stat-label">已有封面</span>
            <span class="settings-stat-value is-accent">${coveredCount}</span>
          </div>
          <div class="settings-stat-box">
            <span class="settings-stat-label">暂缺封面</span>
            <span class="settings-stat-value">${missingPublic.length}</span>
          </div>
        </div>
      </section>

      <section class="settings-card">
        <div class="settings-card-head">
          <h3 class="settings-card-title">重复收藏 (${state.duplicates.length})</h3>
        </div>
        <div class="settings-subcard-list">${dupRowsHtml}</div>
      </section>
    `;
    hydrateDrawerMiniThumbs(container);
    return;
  }

  // Tab 1: General & Cache Settings (Visual-first, aligned 1:1 with welcome.html)
  const prevScrollTop = container.scrollTop;
  const excludedSet = new Set(state.prefs.excludedFolderIds || []);
  const missingPublicCount = getMissingCapturableBookmarks().length;
  const isRemote = Boolean(state.prefs.remoteCoverEnabled);
  const isMac = /mac/i.test(navigator.platform || navigator.userAgent || '');
  const newTabKey = isMac ? '⌘T' : 'Ctrl+T';

  const cadenceOptions = [
    { value: 7, label: '每周', sub: '7 天' },
    { value: 30, label: '每月', sub: '30 天' },
    { value: 90, label: '每季度', sub: '90 天' },
    { value: 0, label: '仅手动', sub: '' }
  ];

  const radioHtml = cadenceOptions
    .map((opt) => {
      const checked = state.prefs.ttlDays === opt.value;
      return `
        <label class="radio-option${checked ? ' is-checked' : ''}">
          <input type="radio" class="radio-input" name="folio-ttl-days" value="${opt.value}" ${checked ? 'checked' : ''} />
          <span class="radio-dot" aria-hidden="true"></span>
          <span class="radio-label">${opt.label}</span>
          ${opt.sub ? `<span class="radio-sub">${opt.sub}</span>` : ''}
        </label>
      `;
    })
    .join('');

  const folderChipsHtml =
    state.topFolders.length > 0
      ? state.topFolders
          .map((f) => {
            const excluded = excludedSet.has(f.id);
            return `
              <button type="button" class="welcome-folder-chip${excluded ? ' is-excluded' : ''}" data-toggle-excluded="${escapeHtml(f.id)}" aria-pressed="${excluded ? 'true' : 'false'}" title="${excluded ? `已跳过「${escapeHtml(f.title)}」` : `点击跳过「${escapeHtml(f.title)}」`}">
                <span class="welcome-folder-chip-icon" aria-hidden="true">${getSidebarFolderIcon(f.title, false)}</span>
                <span>${escapeHtml(f.title)}</span>
                ${excluded ? `<span class="welcome-folder-chip-eye" aria-hidden="true">${ICONS.eyeOff}</span>` : ''}
              </button>
            `;
          })
          .join('')
      : `<span class="excluded-empty">暂无书签文件夹</span>`;

  const launchModes = [
    { key: 'launchOnNewTab', title: '新标签页', kbd: newTabKey },
    { key: 'launchOnAction', title: '工具栏图标' },
    { key: 'launchOnStartup', title: '浏览器首页' },
    { key: 'launchOnShortcut', title: '全局快捷键', kbd: state.openShortcutLabel, editable: true }
  ];

  const enabledLaunchCount = launchModes.filter((m) => Boolean(state.prefs[m.key])).length;

  const launchRowsHtml = launchModes
    .map((m) => {
      const checked = Boolean(state.prefs[m.key]);
      const locked = checked && enabledLaunchCount <= 1;
      const kbdHtml = m.kbd ? renderShortcutKeycapsHtml(m.kbd) : '';
      const editHtml = m.editable
        ? `<button type="button" class="setting-inline-link" id="btn-edit-shortcut">改键</button>`
        : '';
      return `
        <div class="settings-switch-row">
          <span class="setting-title-inline">
            <span class="settings-item-title">${m.title}</span>
            ${kbdHtml}
            ${editHtml}
          </span>
          <button type="button" class="setting-switch${locked ? ' is-locked' : ''}" role="switch" aria-checked="${checked ? 'true' : 'false'}" aria-disabled="${locked ? 'true' : 'false'}" data-launch-pref="${m.key}" aria-label="${m.title}"></button>
        </div>
      `;
    })
    .join('');

  const remoteSubText =
    missingPublicCount > 0 ? `待补齐 ${missingPublicCount} 个站点` : '仅按根域名补齐';

  container.innerHTML = `
    <section class="settings-card">
      <div class="settings-card-head">
        <h3 class="settings-card-title">打开方式</h3>
        <button type="button" class="text-action is-accent" id="btn-open-welcome">初始引导</button>
      </div>

      <div class="settings-subcard-list">
        ${launchRowsHtml}
      </div>

      <div class="welcome-browser-mock" aria-hidden="true">
        <div class="wbm-tabbar">
          <span class="wbm-dots"><i></i><i></i><i></i></span>
          <span class="wbm-tab is-home${state.prefs.launchOnStartup ? ' is-on' : ''}">
            <span class="wbm-tab-dot"></span>
            <span>首页</span>
          </span>
          <span class="wbm-tab is-newtab${state.prefs.launchOnNewTab ? ' is-on' : ''}">
            <span class="wbm-tab-dot"></span>
            <span>新标签页</span>
          </span>
        </div>
        <div class="wbm-toolbar">
          <span class="wbm-address">
            <span class="wbm-shortcut-pill${state.prefs.launchOnShortcut ? ' is-on' : ''}">
              ${renderShortcutKeycapsHtml(state.openShortcutLabel, 'is-mini')}
            </span>
          </span>
          <span class="wbm-action-icon${state.prefs.launchOnAction ? ' is-on' : ''}">
            <span class="wbm-action-grid"><i></i><i></i><i></i><i></i></span>
          </span>
        </div>
      </div>
    </section>

    <section class="settings-card">
      <div class="settings-card-head">
        <h3 class="settings-card-title">封面获取</h3>
        <span class="settings-card-meta">${isRemote ? '仅发根域名 · 无路径参数' : '纯本地 · 零外发'}</span>
      </div>

      <div class="welcome-mode-cards" role="radiogroup" aria-label="封面获取方式">
        <button type="button" class="welcome-mode-card${!isRemote ? ' is-selected' : ''}" role="radio" aria-checked="${!isRemote ? 'true' : 'false'}" data-settings-cover-mode="local">
          <div class="wmc-preview is-local" aria-hidden="true">
            <div class="wmc-wire-top"><i></i><i></i><i></i></div>
            <div class="wmc-wire-icon"></div>
            <div class="wmc-wire-line"></div>
          </div>
          <div class="wmc-foot">
            <div class="wmc-title-row">
              <span class="welcome-mode-radio" aria-hidden="true"></span>
              <span class="welcome-mode-title">纯本地截取</span>
            </div>
            <span class="wmc-sub">浏览网页时本地截屏</span>
          </div>
        </button>

        <button type="button" class="welcome-mode-card${isRemote ? ' is-selected' : ''}" role="radio" aria-checked="${isRemote ? 'true' : 'false'}" data-settings-cover-mode="remote">
          <div class="wmc-preview is-remote" aria-hidden="true">
            <div class="wmc-shot-bar"></div>
            <div class="wmc-shot-hero"></div>
            <div class="wmc-shot-grid"><i></i><i></i><i></i></div>
          </div>
          <div class="wmc-foot">
            <div class="wmc-title-row">
              <span class="welcome-mode-radio" aria-hidden="true"></span>
              <span class="welcome-mode-title">补齐公网封面</span>
            </div>
            <span class="wmc-sub">${remoteSubText}</span>
          </div>
        </button>
      </div>

      <div class="settings-subcard-list">
        <div class="settings-switch-row">
          <span class="settings-item-title">浏览时自动截屏</span>
          <button type="button" class="setting-switch" role="switch" aria-checked="${state.prefs.autoCapture ? 'true' : 'false'}" id="switch-auto-capture" aria-label="浏览时自动截屏"></button>
        </div>
        <div class="settings-cadence-block">
          <span class="settings-cadence-label">刷新周期</span>
          <div class="radio-group" role="radiogroup" aria-label="刷新周期">
            ${radioHtml}
          </div>
        </div>
      </div>
    </section>

    <section class="settings-card">
      <div class="settings-card-head">
        <h3 class="settings-card-title">跳过封面</h3>
        <span class="settings-card-meta">内网默认跳过</span>
      </div>

      <div class="welcome-folder-chips">
        ${folderChipsHtml}
      </div>
    </section>

    <section class="settings-card">
      <div class="settings-card-head">
        <h3 class="settings-card-title">本地缓存</h3>
        <span class="settings-card-meta">仅存图片 · 不影响书签</span>
      </div>

      <div class="settings-stat-grid">
        <div class="settings-stat-box">
          <span class="settings-stat-label">已缓存</span>
          <span class="settings-stat-value">${state.tidy.stats.count} 张</span>
        </div>
        <div class="settings-stat-box">
          <span class="settings-stat-label">占用空间</span>
          <span class="settings-stat-value">${formatBytes(state.tidy.stats.totalBytes)}</span>
        </div>
      </div>

      <div class="settings-subcard-list">
        ${isRemote && missingPublicCount > 0 ? `
        <div class="settings-switch-row">
          <span class="setting-title-inline">
            <span class="settings-item-title">补齐公网封面</span>
            <span class="settings-count-pill">${missingPublicCount}</span>
          </span>
          <button type="button" class="text-action is-accent tidy-row-action" id="btn-silent-backfill">立即补齐</button>
        </div>
        ` : ''}
        <div class="settings-switch-row">
          <span class="settings-item-title">清理失效缓存</span>
          <button type="button" class="text-action is-accent tidy-row-action" id="btn-prune-cache">清理</button>
        </div>
        <div class="settings-switch-row">
          <span class="settings-item-title">清空全部缓存</span>
          <button type="button" class="text-action is-danger tidy-row-action" id="btn-clear-cache">清空</button>
        </div>
      </div>
    </section>
  `;
  container.scrollTop = prevScrollTop;
}

// --- Move-to-Folder Popover ---
function openMovePopover(bookmarkId, anchorEl) {
  const bm = state.allBookmarks.find((b) => b.id === bookmarkId);
  if (!bm) return;

  const flatFolders = [];
  const walk = (folders) => {
    for (const f of folders) {
      flatFolders.push(f);
      if (f.subfolders.length) walk(f.subfolders);
    }
  };
  walk(state.topFolders);

  els.movePopover.innerHTML = `
    <div class="move-popover-heading">移动到文件夹</div>
    ${flatFolders
      .map(
        (f) => `
      <button type="button" class="move-popover-item${f.id === bm.parentId ? ' is-current' : ''}" data-popover-move-bm="${escapeHtml(bm.id)}" data-popover-target="${escapeHtml(f.id)}" style="padding-left:${10 + f.depth * 14}px">
        <span>${escapeHtml(f.title)}</span>
      </button>
    `
      )
      .join('')}
  `;

  const rect = anchorEl.getBoundingClientRect();
  els.movePopover.hidden = false;
  const popW = 220;
  const popH = Math.min(300, els.movePopover.scrollHeight);
  const left = Math.min(window.innerWidth - popW - 12, Math.max(12, rect.right - popW));
  const top = rect.bottom + popH + 8 > window.innerHeight ? Math.max(12, rect.top - popH - 6) : rect.bottom + 6;
  els.movePopover.style.left = `${left}px`;
  els.movePopover.style.top = `${top}px`;
}

function closeMovePopover() {
  els.movePopover.hidden = true;
}

// --- Card Right-Click Context Menu & Edit Bookmark Modal ---
function openCardContextMenu(bookmarkId, clientX, clientY) {
  state.contextBookmarkId = bookmarkId;
  closeMovePopover();
  els.cardContextMenu.hidden = false;
  const menuW = els.cardContextMenu.offsetWidth || 200;
  const menuH = els.cardContextMenu.offsetHeight || 240;
  const left = Math.min(window.innerWidth - menuW - 10, Math.max(10, clientX));
  const top = Math.min(window.innerHeight - menuH - 10, Math.max(10, clientY));
  els.cardContextMenu.style.left = `${left}px`;
  els.cardContextMenu.style.top = `${top}px`;
}

function closeCardContextMenu() {
  state.contextBookmarkId = null;
  if (els.cardContextMenu) els.cardContextMenu.hidden = true;
}

function openEditBookmarkModal(bm) {
  if (!bm || !els.editBookmarkOverlay) return;
  state.editBookmarkId = bm.id;
  els.editBmTitle.value = bm.title || '';
  els.editBmUrl.value = bm.url || '';
  els.editBmError.hidden = true;
  els.editBmError.textContent = '';
  els.editBookmarkOverlay.hidden = false;
  els.editBookmarkOverlay.setAttribute('aria-hidden', 'false');
  els.app.classList.add('is-spotlight-open');
  syncScrollLock();
  requestAnimationFrame(() => {
    els.editBmTitle.focus();
    els.editBmTitle.select();
  });
}

function closeEditBookmarkModal() {
  if (!els.editBookmarkOverlay || els.editBookmarkOverlay.hidden) return;
  state.editBookmarkId = null;
  els.editBookmarkOverlay.hidden = true;
  els.editBookmarkOverlay.setAttribute('aria-hidden', 'true');
  els.editBmError.hidden = true;
  els.app.classList.remove('is-spotlight-open');
  syncScrollLock();
}

function normalizeEditedUrl(rawInput) {
  const trimmed = (rawInput || '').trim();
  if (!trimmed) return null;
  const candidate = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const parsed = new URL(candidate);
    if (!parsed.protocol || !parsed.href) return null;
    return parsed.href;
  } catch {
    return null;
  }
}

async function openBookmarkInNewTab(bm) {
  if (!bm) return;
  if (!isBookmarkExcludedFromCover(bm)) {
    sendBackgroundMessage({ type: 'REGISTER_OPEN_INTENT', key: bm.key, url: bm.url });
  }
  if (IS_EXTENSION && chrome.tabs?.create) {
    await chrome.tabs.create({ url: bm.url, active: true });
  } else {
    window.open(bm.url, '_blank', 'noopener,noreferrer');
  }
}

async function openBookmarkInNewWindow(bm) {
  if (!bm) return;
  if (!isBookmarkExcludedFromCover(bm)) {
    sendBackgroundMessage({ type: 'REGISTER_OPEN_INTENT', key: bm.key, url: bm.url });
  }
  if (IS_EXTENSION && chrome.windows?.create) {
    await chrome.windows.create({ url: bm.url });
  } else {
    window.open(bm.url, '_blank', 'noopener,noreferrer,width=1200,height=800');
  }
}

async function openBookmarkInSplitView(bm) {
  if (!bm) return;
  if (!isBookmarkExcludedFromCover(bm)) {
    sendBackgroundMessage({ type: 'REGISTER_OPEN_INTENT', key: bm.key, url: bm.url });
  }

  if (IS_EXTENSION && chrome.tabs?.getCurrent) {
    try {
      const currentTab = await chrome.tabs.getCurrent();
      if (currentTab && typeof currentTab.id === 'number') {
        const notSplit = currentTab.splitViewId === undefined || currentTab.splitViewId === -1;
        // 1) Try Chrome 155+ native Tabs Split View API (splitWithTabId)
        if (notSplit) {
          try {
            await chrome.tabs.create({
              url: bm.url,
              index: currentTab.index + 1,
              splitWithTabId: currentTab.id
            });
            return;
          } catch {
            // Fall through to createSplit / side-by-side window fallback
          }
          // 2) Try chrome.tabs.createSplit if exposed
          if (typeof chrome.tabs.createSplit === 'function') {
            try {
              const created = await chrome.tabs.create({
                url: bm.url,
                index: currentTab.index + 1,
                active: true
              });
              if (created?.id) {
                await chrome.tabs.createSplit([currentTab.id, created.id]);
                return;
              }
            } catch {
              // Fall through
            }
          }
        }
      }
    } catch {
      // Fall through to side-by-side companion window
    }

    // 3) Graceful fallback for Chrome < 155 or already-split tabs: right-half companion window
    if (chrome.windows?.getCurrent && chrome.windows?.create) {
      try {
        const win = await chrome.windows.getCurrent();
        const halfW = Math.max(480, Math.round((win.width || 1280) / 2));
        const left = Math.round((win.left || 0) + (win.width || 1280) - halfW);
        await chrome.windows.create({
          url: bm.url,
          left,
          top: win.top || 0,
          width: halfW,
          height: win.height || 860
        });
        return;
      } catch {
        // Final fallback: new tab
      }
    }
    await chrome.tabs.create({ url: bm.url, active: true });
    return;
  }

  // HTTP preview fallback: side-by-side popup
  const halfW = Math.max(480, Math.round(window.outerWidth / 2));
  const left = Math.round(window.screenX + window.outerWidth - halfW);
  window.open(bm.url, '_blank', `noopener,noreferrer,left=${left},top=${window.screenY},width=${halfW},height=${window.outerHeight}`);
}

async function openBookmarkInIncognito(bm) {
  if (!bm) return;
  // Never register capture intent for incognito browsing
  if (IS_EXTENSION && chrome.windows?.create) {
    try {
      await chrome.windows.create({ url: bm.url, incognito: true });
    } catch {
      showToast('无法打开隐身窗口，请在扩展详情中允许无痕模式');
    }
  } else {
    showToast('隐身窗口仅在 Chrome 扩展模式下可用');
  }
}

// --- Data Refresh Cycle ---
let reloadTimer = null;
let suppressEnterAnimUntil = 0;
let deferRefreshUntil = 0;
let skipGalleryRerenderUntil = 0;

async function refreshAllData(options = {}) {
  const prevScrollY = window.scrollY;
  const silent = Boolean(options.silent) || performance.now() < suppressEnterAnimUntil;
  const skipGallery = Boolean(options.skipGallery) || performance.now() < skipGalleryRerenderUntil;
  const [tree, thumbMeta] = await Promise.all([getBookmarkTree(), getThumbnailMetaMap()]);
  state.thumbMeta = thumbMeta;
  parseBookmarkTree(tree);
  if (!skipGallery) {
    renderSidebar();
    if (silent) {
      els.galleryRoot.classList.add('is-no-enter-anim');
    }
    renderGallery();
    if (prevScrollY > 0) {
      requestAnimationFrame(() => window.scrollTo(0, prevScrollY));
    }
    if (silent) {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          els.galleryRoot.classList.remove('is-no-enter-anim');
        });
      });
    }
  }
  if (state.tidy.open) {
    state.tidy.stats = await getStorageStats();
    renderTidyContent();
  }
  renderBatchBanner();
}

function scheduleRefreshAllData() {
  clearTimeout(reloadTimer);
  const waitMs = Math.max(150, Math.ceil(deferRefreshUntil - performance.now()));
  reloadTimer = setTimeout(() => {
    refreshAllData();
  }, waitMs);
}

// --- Event Listeners ---
function bindEvents() {
  // Static icons hydration
  document.querySelector('.brand-mark').innerHTML = ICONS.brand;
  els.btnCollapseSidebar.innerHTML = `
    <span class="sidebar-toggle-icon is-collapse" aria-hidden="true">${ICONS.sidebarCollapse}</span>
    <span class="sidebar-toggle-icon is-brand" aria-hidden="true">${ICONS.brand}</span>
    <span class="sidebar-toggle-icon is-expand" aria-hidden="true">${ICONS.sidebarExpand}</span>
  `;
  els.btnMobileMenu.innerHTML = ICONS.menu;
  els.btnCloseTidy.innerHTML = ICONS.sidebarRightCollapse;
  els.btnCloseTidy.title = '收起设置面板';
  document.getElementById('icon-topbar-settings').innerHTML = ICONS.settings;
  document.getElementById('icon-topbar-search').innerHTML = ICONS.search;
  document.getElementById('icon-spotlight-search').innerHTML = ICONS.search;
  const searchKeyEl = document.querySelector('.search-trigger-key');
  if (searchKeyEl) {
    const isMac = /mac/i.test(navigator.platform || navigator.userAgent || '');
    searchKeyEl.innerHTML = renderShortcutKeycapsHtml(isMac ? '⌘K' : 'Ctrl+K');
  }
  const setIcon = (id, svg) => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = svg;
  };
  setIcon('icon-ctx-tab', ICONS.externalLink);
  setIcon('icon-ctx-window', ICONS.appWindow);
  setIcon('icon-ctx-split', ICONS.splitView);
  setIcon('icon-ctx-incognito', ICONS.incognito);
  setIcon('icon-ctx-edit', ICONS.edit);
  setIcon('icon-ctx-trash', ICONS.trash);
  setIcon('icon-footer-top', ICONS.arrowUp);

  if (els.btnBackToTop) {
    els.btnBackToTop.addEventListener('click', () => {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  }

  // Scroll separation for sticky borderless topbar & sidebar top fade mask
  window.addEventListener(
    'scroll',
    () => {
      els.topbar.classList.toggle('is-scrolled', window.scrollY > 6);
      closeCardContextMenu();
    },
    { passive: true }
  );

  if (els.sidebarScroll) {
    const syncSidebarScrollMask = () => {
      els.sidebarScroll.classList.toggle('is-scrolled', els.sidebarScroll.scrollTop > 2);
    };
    els.sidebarScroll.addEventListener('scroll', syncSidebarScrollMask, { passive: true });
    syncSidebarScrollMask();
  }

  // Brand home
  els.brandHome.addEventListener('click', (e) => {
    e.preventDefault();
    state.selectedFolderId = 'all';
    state.activeSubfolderId = 'all';
    syncSidebarActiveState();
    renderGallery({ animate: true });
  });

  // Sidebar collapse toggle
  let sidebarAnimatingUntil = 0;
  els.btnCollapseSidebar.addEventListener('click', () => {
    sidebarAnimatingUntil = performance.now() + 300;
    suppressOverlayScrollbars(310);
    state.prefs.sidebarCollapsed = !state.prefs.sidebarCollapsed;
    savePreferences({ sidebarCollapsed: state.prefs.sidebarCollapsed });
    applyLayoutPreferences();
  });

  // Mobile sidebar drawer
  const closeMobileSidebar = () => {
    els.sidebar.classList.remove('is-mobile-open');
    els.sidebarBackdrop.classList.remove('is-open');
  };
  els.btnMobileMenu.addEventListener('click', () => {
    els.sidebar.classList.add('is-mobile-open');
    els.sidebarBackdrop.classList.add('is-open');
  });
  els.sidebarBackdrop.addEventListener('click', closeMobileSidebar);

  // Sidebar navigation clicks (covers both pinned top items & scrollable folder cards)
  els.sidebar.addEventListener('click', (e) => {
    const toggleEl = e.target.closest('[data-toggle-expand]');
    if (toggleEl) {
      e.stopPropagation();
      const fid = toggleEl.dataset.toggleExpand;
      if (state.expandedSidebarFolders.has(fid)) {
        state.expandedSidebarFolders.delete(fid);
      } else {
        state.expandedSidebarFolders.add(fid);
      }
      renderSidebar();
      return;
    }

    const item = e.target.closest('.nav-item[data-folder-id]');
    if (!item) return;
    if (state.selectedFolderId === item.dataset.folderId) {
      window.scrollTo({ top: 0, behavior: 'smooth' });
      closeMobileSidebar();
      return;
    }
    state.selectedFolderId = item.dataset.folderId;
    state.activeSubfolderId = 'all';
    syncSidebarActiveState();
    renderGallery({ animate: true });
    window.scrollTo({ top: 0, behavior: 'smooth' });
    closeMobileSidebar();
  });

  // Floating tooltip when sidebar is collapsed
  const showTooltip = (target) => {
    if (!state.prefs.sidebarCollapsed || window.innerWidth <= 720) return;
    const text = target?.dataset?.tooltip;
    if (!text) return;
    const rect = target.getBoundingClientRect();
    els.railTooltip.textContent = text;
    els.railTooltip.style.left = `${rect.right + 10}px`;
    els.railTooltip.style.top = `${rect.top + rect.height / 2}px`;
    els.railTooltip.hidden = false;
  };
  const hideTooltip = () => {
    els.railTooltip.hidden = true;
  };
  els.sidebar.addEventListener('mouseover', (e) => {
    const t = e.target.closest('[data-tooltip]');
    if (t) showTooltip(t);
    else hideTooltip();
  });
  els.sidebar.addEventListener('mouseleave', hideTooltip);
  els.sidebar.addEventListener('click', hideTooltip);

  // Pointer-Event Drag & Drop (005-drag-ripple style):
  // 1) In-content card reordering (same folder, cross-section folders, and Favorites rail):
  //    - Zero mid-drag DOM reflow (transforms only!)
  //    - Whisper-quiet thin vertical insertion line in the target gap (grows from middle, glides between gaps; hidden over own slot)
  //    - Outward directional ripple on the target row: A * 0.7^n (A = 8px) with 24ms * n stagger and ~250ms micro-overshoot spring
  //    - Crisp FLIP spring settle on drop; Esc or outside drop springs everything cleanly back
  //    - Keyboard reordering via Alt + ArrowLeft / ArrowRight on focused bookmark cards
  // 2) Direct drag onto Sidebar Folders to move bookmarks into any folder
  const reducedMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
  const RIPPLE_AMPLITUDE_PX = 8;
  const RIPPLE_DECAY = 0.7;
  const RIPPLE_STAGGER_MS = 24;
  const RIPPLE_SPRING = 'transform 250ms cubic-bezier(0.22, 1.22, 0.36, 1)';
  const SETTLE_SPRING = 'transform 280ms cubic-bezier(0.22, 1.12, 0.36, 1)';

  let dragGhostEl = null;
  let dropLineEl = null;
  let dropLineVisible = false;
  let dragCandidate = null;
  let activeDropTarget = null;
  let activeInsertion = null; // { grid, insertIdx, beforeEl, nextBmId, prevBmId, rowItems, rowGap, lineX, lineTop, lineHeight }
  let rippledEls = new Set();
  let dragAutoScrollRaf = 0;
  let suppressCardClickUntil = 0;
  let cleanupTimer = 0;

  const ensureDropLineEl = () => {
    if (dropLineEl && dropLineEl.isConnected) return dropLineEl;
    const el = document.createElement('div');
    el.id = 'folio-drop-line';
    el.className = 'folio-drop-line';
    el.setAttribute('aria-hidden', 'true');
    el.innerHTML = `<span class="folio-drop-line-bar"></span>`;
    document.body.appendChild(el);
    dropLineEl = el;
    return el;
  };

  const showDropLine = (lineX, lineTop, lineHeight) => {
    const el = ensureDropLineEl();
    const x = Math.round(lineX - 1);
    const y = Math.round(lineTop);
    const h = Math.round(lineHeight);
    if (!dropLineVisible) {
      el.classList.add('is-snapping');
      el.style.transform = `translate3d(${x}px, ${y}px, 0)`;
      el.style.height = `${h}px`;
      void el.offsetWidth;
      el.classList.remove('is-snapping');
      el.classList.add('is-visible');
      dropLineVisible = true;
    } else {
      el.style.transform = `translate3d(${x}px, ${y}px, 0)`;
      el.style.height = `${h}px`;
    }
  };

  const hideDropLine = () => {
    if (dropLineEl && dropLineVisible) {
      dropLineEl.classList.remove('is-visible');
    }
    dropLineVisible = false;
  };

  const positionDragGhost = (x, y) => {
    if (!dragGhostEl) return;
    const ghostW = 144;
    const ghostH = 90;
    const tx = Math.min(window.innerWidth - ghostW - 10, Math.max(8, x + 22));
    const ty = Math.min(window.innerHeight - ghostH - 10, Math.max(8, y - 28));
    dragGhostEl.style.transform = `translate3d(${tx}px, ${ty}px, 0)`;
  };

  const clearDropTarget = () => {
    if (activeDropTarget) {
      activeDropTarget.classList.remove('is-drop-target');
      activeDropTarget = null;
    }
  };

  // Layout-space resting rect (immune to CSS ripple transforms -> 100% stable hit-testing)
  const getRestingRect = (el, container, containerRect) => {
    if (el.offsetParent === container) {
      const left = containerRect.left + el.offsetLeft - container.scrollLeft;
      const top = containerRect.top + el.offsetTop - container.scrollTop;
      const width = el.offsetWidth;
      const height = el.offsetHeight;
      return {
        left,
        top,
        right: left + width,
        bottom: top + height,
        width,
        height,
        cx: left + width * 0.5,
        cy: top + height * 0.5
      };
    }
    const r = el.getBoundingClientRect();
    return {
      left: r.left,
      top: r.top,
      right: r.right,
      bottom: r.bottom,
      width: r.width,
      height: r.height,
      cx: r.left + r.width * 0.5,
      cy: r.top + r.height * 0.5
    };
  };

  // Apply outward ripple displacement (A * 0.7^n, 24ms * n stagger) to the active row only
  const applyRippleForInsertion = (insertion) => {
    if (reducedMotionQuery.matches) {
      clearRipples(false);
      return;
    }

    const nextActive = new Map();
    if (insertion && insertion.rowItems && insertion.rowItems.length > 0) {
      const { rowItems, rowGap } = insertion;
      for (let i = 0; i < rowItems.length; i++) {
        const el = rowItems[i].el;
        let n = 0;
        let dir = 0;
        if (i < rowGap) {
          n = rowGap - 1 - i;
          dir = -1;
        } else {
          n = i - rowGap;
          dir = 1;
        }
        const dx = dir * Number((RIPPLE_AMPLITUDE_PX * Math.pow(RIPPLE_DECAY, n)).toFixed(2));
        const delayMs = n * RIPPLE_STAGGER_MS;
        nextActive.set(el, { dx, delayMs });
      }
    }

    // Spring back any elements that are no longer on the parted row
    for (const el of rippledEls) {
      if (!nextActive.has(el) && el.isConnected) {
        el.style.transition = RIPPLE_SPRING;
        el.style.transitionDelay = '0ms';
        el.style.transform = '';
      }
    }

    // Apply outward lean + staggered delay to items flanking the insertion line
    for (const [el, { dx, delayMs }] of nextActive.entries()) {
      el.style.transition = RIPPLE_SPRING;
      el.style.transitionDelay = `${delayMs}ms`;
      el.style.transform = el.classList.contains('is-dragging')
        ? `translate3d(${dx}px, 0, 0) scale(0.985)`
        : `translate3d(${dx}px, 0, 0)`;
    }

    rippledEls = new Set(nextActive.keys());
  };

  const clearRipples = (animate = true) => {
    for (const el of rippledEls) {
      if (!el.isConnected) continue;
      if (animate && !reducedMotionQuery.matches) {
        el.style.transition = RIPPLE_SPRING;
        el.style.transitionDelay = '0ms';
        el.style.transform = '';
      } else {
        el.style.transition = 'none';
        el.style.transitionDelay = '';
        el.style.transform = '';
      }
    }
    rippledEls.clear();
  };

  const cleanupInlineTransforms = () => {
    const items = els.galleryRoot.querySelectorAll('.bookmark-card, .view-all-card');
    for (const el of items) {
      if (el.style.transition || el.style.transform || el.style.transitionDelay) {
        el.style.transition = '';
        el.style.transitionDelay = '';
        el.style.transform = '';
      }
    }
  };

  // Spring FLIP settle when committing a drop or keyboard reorder
  const animateFlipSettle = (containers, mutateDom) => {
    const uniqueContainers = Array.from(new Set(containers.filter(Boolean)));
    if (reducedMotionQuery.matches || uniqueContainers.length === 0) {
      clearRipples(false);
      mutateDom();
      return;
    }

    const tracked = [];
    const firstRects = new Map();
    for (const container of uniqueContainers) {
      const items = container.querySelectorAll(':scope > .bookmark-card, :scope > .view-all-card');
      for (const item of items) {
        firstRects.set(item, item.getBoundingClientRect());
        tracked.push(item);
      }
    }

    rippledEls.clear();
    for (const item of tracked) {
      item.style.transition = 'none';
      item.style.transitionDelay = '';
      item.style.transform = '';
    }

    mutateDom();

    const moved = [];
    for (const item of tracked) {
      if (!item.isConnected) continue;
      const first = firstRects.get(item);
      const last = item.getBoundingClientRect();
      const dx = first.left - last.left;
      const dy = first.top - last.top;
      if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
        item.style.transform = `translate3d(${dx}px, ${dy}px, 0)`;
        moved.push(item);
      } else {
        item.style.transition = '';
      }
    }

    if (moved.length === 0) return;
    void uniqueContainers[0].offsetWidth;

    for (const item of moved) {
      item.style.transition = SETTLE_SPRING;
      item.style.transitionDelay = '0ms';
      item.style.transform = '';
    }
  };

  const resolveSortableGridAt = (clientX, clientY, dc) => {
    if (!dc || !dc.originGrid) return null;
    if (dc.originKind === 'favorites') {
      const r = dc.originGrid.getBoundingClientRect();
      if (clientX >= r.left - 28 && clientX <= r.right + 28 && clientY >= r.top - 40 && clientY <= r.bottom + 40) {
        return dc.originGrid;
      }
      return null;
    }

    const grids = Array.from(els.galleryRoot.querySelectorAll('.card-grid[data-sort-kind="bookmarks"]'));
    for (const grid of grids) {
      const r = grid.getBoundingClientRect();
      if (clientX >= r.left - 18 && clientX <= r.right + 18 && clientY >= r.top - 16 && clientY <= r.bottom + 16) {
        return grid;
      }
    }
    return null;
  };

  // Compute exact thin vertical insertion line & flanking row items for pointer position
  const computeGapInsertion = (grid, dragCard, clientX, clientY) => {
    const gridRect = grid.getBoundingClientRect();
    const isHorizontalRail = grid.dataset.sortKind === 'favorites';
    const cards = Array.from(grid.querySelectorAll(':scope > .bookmark-card'));
    const viewAll = grid.querySelector(':scope > .view-all-card');
    if (cards.length === 0) return null;

    const dragIdx = cards.indexOf(dragCard);

    // Group bookmark cards into visual rows using layout-space resting rects
    const rows = [];
    for (let i = 0; i < cards.length; i++) {
      const el = cards[i];
      const rect = getRestingRect(el, grid, gridRect);
      const stageEl = el.querySelector('.card-stage');
      const stageH = stageEl ? stageEl.offsetHeight : rect.height * 0.72;
      const entry = { el, rect, idx: i, stageH };
      if (isHorizontalRail) {
        if (rows.length === 0) {
          rows.push({ top: rect.top, bottom: rect.bottom, stageH, bookmarks: [entry], viewAll: null });
        } else {
          rows[0].bookmarks.push(entry);
          rows[0].bottom = Math.max(rows[0].bottom, rect.bottom);
        }
      } else {
        const lastRow = rows[rows.length - 1];
        if (!lastRow || Math.abs(rect.top - lastRow.top) > rect.height * 0.45) {
          rows.push({ top: rect.top, bottom: rect.bottom, stageH, bookmarks: [entry], viewAll: null });
        } else {
          lastRow.bookmarks.push(entry);
          lastRow.bottom = Math.max(lastRow.bottom, rect.bottom);
        }
      }
    }

    if (viewAll && rows.length > 0) {
      const vaRect = getRestingRect(viewAll, grid, gridRect);
      const lastRow = rows[rows.length - 1];
      if (!isHorizontalRail && Math.abs(vaRect.top - lastRow.top) <= vaRect.height * 0.45) {
        lastRow.viewAll = { el: viewAll, rect: vaRect };
      }
    }

    // Pick the row matching clientY (or nearest row inside padded grid bounds)
    let targetRow = null;
    let bestDist = Infinity;
    for (const row of rows) {
      if (clientY >= row.top - 12 && clientY <= row.bottom + 12) {
        targetRow = row;
        break;
      }
      const dist = clientY < row.top ? row.top - clientY : clientY - row.bottom;
      if (dist < bestDist) {
        bestDist = dist;
        targetRow = row;
      }
    }
    if (!targetRow) return null;

    // Determine gap index within targetRow by comparing clientX with each card's horizontal center
    const rowBms = targetRow.bookmarks;
    let rowGap = rowBms.length;
    for (let j = 0; j < rowBms.length; j++) {
      if (clientX < rowBms[j].rect.cx) {
        rowGap = j;
        break;
      }
    }

    const insertIdx = rowGap < rowBms.length ? rowBms[rowGap].idx : rowBms[rowBms.length - 1].idx + 1;

    // Rule #3: Never show line or ripple over the dragged item's own slot (no-op drop)
    if (dragIdx >= 0 && (insertIdx === dragIdx || insertIdx === dragIdx + 1)) {
      return null;
    }

    // Compute exact pixel center of the vertical gap aligned to card-stage height
    let lineX;
    if (rowGap > 0 && rowGap < rowBms.length) {
      lineX = (rowBms[rowGap - 1].rect.right + rowBms[rowGap].rect.left) * 0.5;
    } else if (rowGap === 0) {
      lineX = rowBms[0].rect.left - 8;
    } else if (targetRow.viewAll) {
      lineX = (rowBms[rowBms.length - 1].rect.right + targetRow.viewAll.rect.left) * 0.5;
    } else {
      lineX = rowBms[rowBms.length - 1].rect.right + 8;
    }

    const lineTop = targetRow.top + 6;
    const lineHeight = Math.max(40, targetRow.stageH - 12);
    const beforeEl = insertIdx < cards.length ? cards[insertIdx] : viewAll || null;

    // Snapshot neighbor IDs excluding the dragged card itself
    let nextBmId = null;
    for (let k = insertIdx; k < cards.length; k++) {
      if (cards[k] !== dragCard) {
        nextBmId = cards[k].dataset.bookmarkId || null;
        break;
      }
    }
    let prevBmId = null;
    for (let k = insertIdx - 1; k >= 0; k--) {
      if (cards[k] !== dragCard) {
        prevBmId = cards[k].dataset.bookmarkId || null;
        break;
      }
    }

    const rowItems = targetRow.viewAll ? [...rowBms, targetRow.viewAll] : [...rowBms];

    return {
      grid,
      insertIdx,
      beforeEl,
      nextBmId,
      prevBmId,
      rowItems,
      rowGap,
      lineX,
      lineTop,
      lineHeight
    };
  };

  const updateRippleAndDropLine = (clientX, clientY) => {
    const dc = dragCandidate;
    if (!dc || !dc.active) return;

    // Over sidebar drop folder -> clear in-content insertion line & spring cards back cleanly
    if (activeDropTarget) {
      activeInsertion = null;
      hideDropLine();
      clearRipples(true);
      return;
    }

    const targetGrid = resolveSortableGridAt(clientX, clientY, dc);
    const insertion = targetGrid ? computeGapInsertion(targetGrid, dc.card, clientX, clientY) : null;
    activeInsertion = insertion;

    if (!insertion) {
      hideDropLine();
      clearRipples(true);
      return;
    }

    showDropLine(insertion.lineX, insertion.lineTop, insertion.lineHeight);
    applyRippleForInsertion(insertion);
  };

  const stopDragAutoScroll = () => {
    if (dragAutoScrollRaf) {
      cancelAnimationFrame(dragAutoScrollRaf);
      dragAutoScrollRaf = 0;
    }
  };

  const startDragAutoScroll = () => {
    stopDragAutoScroll();
    const step = () => {
      if (!dragCandidate?.active) {
        dragAutoScrollRaf = 0;
        return;
      }
      const { lastX, lastY, originKind, originGrid } = dragCandidate;
      let scrolled = false;

      const topZone = 92;
      const bottomZone = window.innerHeight - 64;
      if (lastY < topZone) {
        const speed = Math.ceil(((topZone - lastY) / topZone) * 14);
        if (window.scrollY > 0) {
          window.scrollBy(0, -speed);
          scrolled = true;
        }
      } else if (lastY > bottomZone) {
        const speed = Math.ceil(((lastY - bottomZone) / 64) * 14);
        const maxScroll = document.documentElement.scrollHeight - window.innerHeight;
        if (window.scrollY < maxScroll) {
          window.scrollBy(0, speed);
          scrolled = true;
        }
      }

      if (originKind === 'favorites' && originGrid) {
        const r = originGrid.getBoundingClientRect();
        if (lastY >= r.top - 40 && lastY <= r.bottom + 40) {
          const edge = 56;
          if (lastX < r.left + edge && originGrid.scrollLeft > 0) {
            originGrid.scrollLeft -= Math.ceil(((r.left + edge - lastX) / edge) * 12);
            scrolled = true;
          } else if (lastX > r.right - edge && originGrid.scrollLeft < originGrid.scrollWidth - originGrid.clientWidth) {
            originGrid.scrollLeft += Math.ceil(((lastX - (r.right - edge)) / edge) * 12);
            scrolled = true;
          }
        }
      }

      if (scrolled) {
        updateRippleAndDropLine(lastX, lastY);
      }
      dragAutoScrollRaf = requestAnimationFrame(step);
    };
    dragAutoScrollRaf = requestAnimationFrame(step);
  };

  const finishPointerDrag = (animateRippleBack = true) => {
    stopDragAutoScroll();
    hideDropLine();
    if (dragGhostEl) {
      dragGhostEl.remove();
      dragGhostEl = null;
    }
    if (dragCandidate?.card) {
      dragCandidate.card.classList.remove('is-dragging');
    }
    clearDropTarget();
    if (animateRippleBack) {
      clearRipples(true);
    }
    document.documentElement.classList.remove('is-dragging-card');
    clearTimeout(cleanupTimer);
    cleanupTimer = setTimeout(() => {
      if (!dragCandidate?.active) {
        els.galleryRoot.classList.remove('is-reordering');
        cleanupInlineTransforms();
      }
    }, 310);
    state.dragBookmarkId = null;
    activeInsertion = null;
    dragCandidate = null;
  };

  const createDragGhostForCard = (card, bm) => {
    if (dragGhostEl) dragGhostEl.remove();
    const ghost = document.createElement('div');
    ghost.id = 'folio-drag-ghost';
    ghost.className = `folio-drag-ghost${card.classList.contains('is-cover-blurred') ? ' is-cover-blurred' : ''}`;
    ghost.setAttribute('aria-hidden', 'true');
    ghost.style.setProperty('--card-hue', String(getDomainHue(bm?.url || '')));

    const inner = document.createElement('div');
    inner.className = 'folio-drag-ghost-card';

    const loadedThumb = card.querySelector('img.card-thumb.is-loaded');
    if (loadedThumb && loadedThumb.src) {
      const img = document.createElement('img');
      img.className = 'folio-drag-ghost-img';
      img.src = loadedThumb.src;
      img.alt = '';
      inner.appendChild(img);
    } else {
      const favUrl = bm ? getFaviconUrl(bm.url, 32) : '';
      const initial = escapeHtml(((bm?.host || bm?.title || '?')[0] || '?').toUpperCase());
      inner.innerHTML = `
        <div class="folio-drag-ghost-placeholder">
          <div class="folio-drag-ghost-icon">${favUrl ? `<img src="${escapeHtml(favUrl)}" alt="" />` : initial}</div>
          <span class="folio-drag-ghost-host">${escapeHtml(bm?.host || '')}</span>
        </div>
      `;
    }

    if (card.classList.contains('is-cover-blurred')) {
      const veil = document.createElement('div');
      veil.className = 'card-blur-veil';
      veil.style.opacity = '1';
      veil.innerHTML = ICONS.eyeOff;
      inner.appendChild(veil);
    }

    ghost.appendChild(inner);
    document.body.appendChild(ghost);
    dragGhostEl = ghost;
  };

  const commitBookmarkOrderMove = async (bm, targetGrid, nextBmId, prevBmId) => {
    const targetFolderId = targetGrid.dataset.gridFolderId || bm.parentId;
    const nextBm = nextBmId ? state.allBookmarks.find((b) => b.id === nextBmId) : null;
    const prevBm = prevBmId ? state.allBookmarks.find((b) => b.id === prevBmId) : null;

    let destParentId = targetFolderId;
    let destIndex = 0;

    if (nextBm && nextBm.parentId === targetFolderId) {
      destParentId = targetFolderId;
      destIndex = nextBm.chromeIndex;
    } else if (prevBm && prevBm.parentId === targetFolderId) {
      destParentId = targetFolderId;
      destIndex = prevBm.chromeIndex + 1;
    } else if (nextBm) {
      destParentId = nextBm.parentId;
      destIndex = nextBm.chromeIndex;
    } else if (prevBm) {
      destParentId = prevBm.parentId;
      destIndex = prevBm.chromeIndex + 1;
    }

    const sameParent = destParentId === bm.parentId;
    if (sameParent) {
      // DOM already reflects the exact settled order — sync tree indices in memory with zero gallery flash!
      skipGalleryRerenderUntil = performance.now() + 900;
    }

    await moveBookmark(bm.id, { parentId: destParentId, index: destIndex });
    if (!sameParent) {
      const destTitle =
        state.folderMap.get(destParentId)?.title ||
        targetGrid.dataset.gridLabel ||
        (destParentId === state.rootBarId ? '未归类书签' : '目标文件夹');
      showToast(`已移动至「${destTitle}」并同步至 Chrome`);
    } else {
      showToast('已调整排序并同步至 Chrome');
    }
    if (!IS_EXTENSION) scheduleRefreshAllData();
  };

  // Prevent any native HTML5 image/link drag ghost inside the gallery
  els.galleryRoot.addEventListener('dragstart', (e) => {
    if (e.target.closest('.bookmark-card')) {
      e.preventDefault();
    }
  });

  els.galleryRoot.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    if (e.pointerType === 'touch') return;
    if (e.target.closest('button, [data-action]')) return;
    const card = e.target.closest('.bookmark-card[data-bookmark-id]');
    if (!card) return;
    const bm = state.allBookmarks.find((b) => b.id === card.dataset.bookmarkId);
    if (!bm) return;
    const originGrid = card.closest('.card-grid, .favorites-rail');
    dragCandidate = {
      card,
      bm,
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      lastX: e.clientX,
      lastY: e.clientY,
      originGrid,
      originKind: originGrid?.dataset.sortKind || 'bookmarks',
      active: false
    };
  });

  window.addEventListener(
    'pointermove',
    (e) => {
      if (!dragCandidate || e.pointerId !== dragCandidate.pointerId) return;
      dragCandidate.lastX = e.clientX;
      dragCandidate.lastY = e.clientY;

      if (!dragCandidate.active) {
        if (Math.hypot(e.clientX - dragCandidate.startX, e.clientY - dragCandidate.startY) < 6) {
          return;
        }
        clearTimeout(cleanupTimer);
        dragCandidate.active = true;
        state.dragBookmarkId = dragCandidate.bm.id;
        els.galleryRoot.classList.add('is-reordering');
        dragCandidate.card.classList.add('is-dragging');
        document.documentElement.classList.add('is-dragging-card');
        document.getElementById('folio-cursor-pill')?.classList.remove('is-visible', 'is-pressed');
        closeCardContextMenu();
        closeMovePopover();
        createDragGhostForCard(dragCandidate.card, dragCandidate.bm);
        startDragAutoScroll();
      }

      positionDragGhost(e.clientX, e.clientY);

      // Sidebar folder drop detection takes priority when pointer enters sidebar region
      const sidebarRight = els.sidebar ? els.sidebar.offsetWidth + 8 : 260;
      const dropEl =
        e.clientX <= sidebarRight
          ? document.elementFromPoint(e.clientX, e.clientY)?.closest?.('.nav-item[data-drop-folder-id]') || null
          : null;
      if (dropEl !== activeDropTarget) {
        clearDropTarget();
        if (dropEl) {
          dropEl.classList.add('is-drop-target');
          activeDropTarget = dropEl;
        }
      }

      updateRippleAndDropLine(e.clientX, e.clientY);
    },
    { passive: true }
  );

  // Keep thin insertion line locked to gap if user scrolls via trackpad/wheel while dragging
  window.addEventListener(
    'scroll',
    () => {
      if (dragCandidate?.active) {
        updateRippleAndDropLine(dragCandidate.lastX, dragCandidate.lastY);
      }
    },
    { passive: true }
  );

  window.addEventListener('pointerup', async (e) => {
    if (!dragCandidate || e.pointerId !== dragCandidate.pointerId) return;
    const dc = dragCandidate;
    const wasActive = dc.active;
    const bm = dc.bm;
    const dropEl = activeDropTarget;
    const insertion = activeInsertion;

    // Path 1: Dropped onto a Sidebar Folder
    if (wasActive && dropEl) {
      finishPointerDrag(true);
      suppressCardClickUntil = performance.now() + 220;
      const destFolderId = dropEl.dataset.dropFolderId;
      await moveBookmark(bm.id, { parentId: destFolderId });
      const folderTitle = state.folderMap.get(destFolderId)?.title || '目标文件夹';
      showToast(`已移动至「${folderTitle}」并同步至 Chrome`);
      if (!IS_EXTENSION) await refreshAllData();
      return;
    }

    // Path 2: Dropped at a valid in-content gap -> FLIP spring every item into its new place
    if (wasActive && insertion && insertion.grid) {
      const targetGrid = insertion.grid;
      const originGrid = dc.originGrid;
      const landedCard = dc.card;
      const beforeEl =
        insertion.beforeEl && insertion.beforeEl.parentElement === targetGrid ? insertion.beforeEl : null;

      finishPointerDrag(false);
      suppressCardClickUntil = performance.now() + 220;
      deferRefreshUntil = performance.now() + 320;
      suppressEnterAnimUntil = performance.now() + 900;

      if (beforeEl !== landedCard) {
        animateFlipSettle([originGrid, targetGrid], () => {
          targetGrid.insertBefore(landedCard, beforeEl);
        });
      } else {
        clearRipples(true);
      }

      if (dc.originKind === 'favorites') {
        const nextFavKeys = Array.from(targetGrid.querySelectorAll(':scope > .bookmark-card[data-key]'))
          .map((el) => el.dataset.key)
          .filter(Boolean);
        state.prefs.favoriteKeys = nextFavKeys;
        await savePreferences({ favoriteKeys: nextFavKeys });
        showToast('已调整收藏顺序');
        return;
      }

      await commitBookmarkOrderMove(bm, targetGrid, insertion.nextBmId, insertion.prevBmId);
      return;
    }

    // Path 3: Dropped over own slot or outside list -> cancel & spring everything back
    finishPointerDrag(true);
    if (wasActive) {
      suppressCardClickUntil = performance.now() + 220;
    }
  });

  window.addEventListener('pointercancel', () => finishPointerDrag(true));
  window.addEventListener('blur', () => finishPointerDrag(true));
  document.addEventListener('keydown', async (e) => {
    if (e.key === 'Escape' && dragCandidate?.active) {
      finishPointerDrag(true);
      return;
    }

    // Accessible keyboard reordering: Alt + ArrowLeft / ArrowRight on a focused bookmark card
    if (
      e.altKey &&
      !e.metaKey &&
      !e.ctrlKey &&
      !e.shiftKey &&
      (e.key === 'ArrowLeft' || e.key === 'ArrowRight') &&
      !state.spotlight.open &&
      (!els.editBookmarkOverlay || els.editBookmarkOverlay.hidden)
    ) {
      const focusedCard = document.activeElement?.closest?.('.bookmark-card[data-bookmark-id]');
      if (!focusedCard) return;
      const grid = focusedCard.closest('.card-grid, .favorites-rail');
      if (!grid) return;
      const cards = Array.from(grid.querySelectorAll(':scope > .bookmark-card'));
      const curIdx = cards.indexOf(focusedCard);
      const delta = e.key === 'ArrowLeft' ? -1 : 1;
      const nextIdx = curIdx + delta;
      if (curIdx < 0 || nextIdx < 0 || nextIdx >= cards.length) return;

      e.preventDefault();
      const bm = state.allBookmarks.find((b) => b.id === focusedCard.dataset.bookmarkId);
      if (!bm) return;
      const focusSelector = document.activeElement.classList.contains('card-meta') ? 'a.card-meta' : 'a.card-link';
      const beforeEl = delta < 0 ? cards[nextIdx] : cards[nextIdx].nextElementSibling;
      const nextBmId = delta < 0 ? cards[nextIdx].dataset.bookmarkId : cards[nextIdx + 1]?.dataset?.bookmarkId || null;
      const prevBmId = delta < 0 ? cards[nextIdx - 1]?.dataset?.bookmarkId || null : cards[nextIdx].dataset.bookmarkId;

      els.galleryRoot.classList.add('is-reordering');
      deferRefreshUntil = performance.now() + 320;
      suppressEnterAnimUntil = performance.now() + 900;
      animateFlipSettle([grid], () => {
        grid.insertBefore(focusedCard, beforeEl);
      });
      focusedCard.querySelector(focusSelector)?.focus({ preventScroll: true });
      clearTimeout(cleanupTimer);
      cleanupTimer = setTimeout(() => {
        els.galleryRoot.classList.remove('is-reordering');
        cleanupInlineTransforms();
      }, 310);

      if (grid.dataset.sortKind === 'favorites') {
        const nextFavKeys = Array.from(grid.querySelectorAll(':scope > .bookmark-card[data-key]'))
          .map((el) => el.dataset.key)
          .filter(Boolean);
        state.prefs.favoriteKeys = nextFavKeys;
        await savePreferences({ favoriteKeys: nextFavKeys });
        showToast('已调整收藏顺序');
      } else {
        await commitBookmarkOrderMove(bm, grid, nextBmId, prevBmId);
      }
    }
  });

  // Swallow the trailing click on card links right after completing a drag gesture
  els.galleryRoot.addEventListener(
    'click',
    (e) => {
      if (performance.now() < suppressCardClickUntil) {
        e.preventDefault();
        e.stopPropagation();
      }
    },
    true
  );

  // Subfolder tabs
  els.subfolderBar.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-subfolder-id]');
    if (!btn) return;
    state.activeSubfolderId = btn.dataset.subfolderId;
    renderGallery();
  });

  // Gallery actions (section expand / jump / capture group / card actions)
  els.galleryRoot.addEventListener('click', async (e) => {
    const jumpBtn = e.target.closest('[data-jump-folder]');
    if (jumpBtn) {
      state.selectedFolderId = jumpBtn.dataset.jumpFolder;
      state.activeSubfolderId = 'all';
      renderSidebar();
      renderGallery({ animate: true });
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }

    const expandBtn = e.target.closest('[data-expand-group]');
    if (expandBtn) {
      const gid = expandBtn.dataset.expandGroup;
      state.expandedGroupsInAll.add(gid);
      const items = gid === 'loose' ? state.looseBookmarks : state.folderMap.get(gid)?.allBookmarks || [];
      const section = expandBtn.closest('.gallery-section');
      const grid = section?.querySelector('.card-grid');
      if (grid) {
        const viewAllEl = grid.querySelector('.view-all-card');
        if (viewAllEl) viewAllEl.remove();
        const renderedCount = grid.querySelectorAll('.bookmark-card').length;
        const rest = items.slice(renderedCount);
        const frag = document.createDocumentFragment();
        rest.forEach((bm, idx) => {
          frag.appendChild(createCardElement(bm, idx));
        });
        grid.appendChild(frag);
        delete expandBtn.dataset.expandGroup;
        expandBtn.dataset.collapseGroup = gid;
        expandBtn.classList.remove('is-accent');
        expandBtn.textContent = '收起';
      } else {
        renderGallery();
      }
      return;
    }

    const collapseBtn = e.target.closest('[data-collapse-group]');
    if (collapseBtn) {
      const gid = collapseBtn.dataset.collapseGroup;
      state.expandedGroupsInAll.delete(gid);
      const folder = gid === 'loose' ? null : state.folderMap.get(gid);
      const items = gid === 'loose' ? state.looseBookmarks : folder?.allBookmarks || [];
      const title = gid === 'loose' ? '未归类书签' : folder?.title || '';
      const section = collapseBtn.closest('.gallery-section');
      const grid = section?.querySelector('.card-grid');
      const maxBookmarksCollapsed = Math.max(1, getGroupPreviewLimit() - 1);
      if (grid) {
        const cards = Array.from(grid.querySelectorAll('.bookmark-card'));
        for (let i = maxBookmarksCollapsed; i < cards.length; i++) {
          cards[i].remove();
        }
        if (!grid.querySelector('.view-all-card')) {
          grid.appendChild(createViewAllCard({ id: gid, title, items }, 0));
        }
        const hiddenCount = Math.max(0, items.length - maxBookmarksCollapsed);
        delete collapseBtn.dataset.collapseGroup;
        if (hiddenCount > 0) {
          collapseBtn.dataset.expandGroup = gid;
          collapseBtn.classList.add('is-accent');
          collapseBtn.textContent = '展开';
        } else {
          collapseBtn.remove();
        }
      } else {
        renderGallery();
      }
      return;
    }

    // Register redirect-aware open intent when clicking any bookmark card link
    const navLink = e.target.closest('a.card-link, a.card-meta');
    if (navLink && !e.target.closest('[data-action]')) {
      const cardEl = navLink.closest('.bookmark-card[data-bookmark-id]');
      const bm = cardEl ? state.allBookmarks.find((b) => b.id === cardEl.dataset.bookmarkId) : null;
      if (bm && !isBookmarkExcludedFromCover(bm)) {
        sendBackgroundMessage({ type: 'REGISTER_OPEN_INTENT', key: bm.key, url: bm.url });
      }
      return;
    }

    const actionBtn = e.target.closest('[data-action]');
    if (!actionBtn) return;
    e.preventDefault();
    e.stopPropagation();

    const action = actionBtn.dataset.action;
    const bm = state.allBookmarks.find((b) => b.id === actionBtn.dataset.id);
    if (!bm) return;
    // Release mouse-click focus so card hover bars dismiss cleanly when pointer leaves
    if (e.detail > 0) actionBtn.blur();

    if (action === 'favorite') {
      await toggleFavoriteKey(bm.key, bm.title);
    } else if (action === 'toggle-blur') {
      await toggleBlurKey(bm.key);
    } else if (action === 'copy') {
      try {
        await navigator.clipboard.writeText(bm.url);
        showToast('已复制书签链接');
      } catch {
        showToast('复制失败，请手动复制');
      }
    } else if (action === 'recapture') {
      if (!state.prefs.remoteCoverEnabled) {
        showToast('当前为纯本地模式，打开该网页即可本地更新首屏');
        return;
      }
      if (isBookmarkExcludedFromCover(bm) || !toSafePublicOrigin(bm.url)) {
        showToast('已排除目录或内网地址不进行远程抓取');
        return;
      }
      sendBackgroundMessage({ type: 'START_BATCH_CAPTURE', items: [bm], force: true });
      showToast(`已按根域名静默刷新「${bm.title}」封面`);
    } else if (action === 'move') {
      openMovePopover(bm.id, actionBtn);
    }
  });

  // Unified Smart Status Strip Actions (progress stop / completion dismiss / onboarding guide actions)
  const handleBannerAction = async (action) => {
    if (action === 'stop-batch') {
      sendBackgroundMessage({ type: 'STOP_BATCH_CAPTURE' });
      state.batch.running = false;
      clearBannerDone();
      renderBatchBanner();
      showToast('已停止封面补齐，后续浏览网页时将自动本地截屏');
    } else if (action === 'dismiss-done') {
      clearBannerDone();
      renderBatchBanner();
    } else if (action === 'enable-and-backfill') {
      state.prefs.remoteCoverEnabled = true;
      state.prefs.bannerHintDismissed = true;
      await savePreferences({ remoteCoverEnabled: true, bannerHintDismissed: true });
      const missing = getMissingCapturableBookmarks();
      if (missing.length > 0) {
        sendBackgroundMessage({ type: 'START_BATCH_CAPTURE', items: missing, force: false });
      }
      if (state.tidy.open) renderTidyContent();
      renderBatchBanner();
      showToast(`已开启公网根域名补齐（共 ${missing.length} 个站点）`);
    } else if (action === 'start-backfill') {
      const missing = getMissingCapturableBookmarks();
      if (missing.length > 0) {
        sendBackgroundMessage({ type: 'START_BATCH_CAPTURE', items: missing, force: false });
        showToast(`已开始按根域名补齐（${missing.length} 个站点）`);
      }
      renderBatchBanner();
    } else if (action === 'dismiss-local-hint') {
      state.prefs.bannerHintDismissed = true;
      await savePreferences({ bannerHintDismissed: true });
      renderBatchBanner();
    } else if (action === 'dismiss-missing-hint') {
      const snoozeUntil = Date.now() + MISSING_BANNER_SNOOZE_MS;
      state.prefs.missingBannerSnoozeUntil = snoozeUntil;
      await savePreferences({ missingBannerSnoozeUntil: snoozeUntil });
      renderBatchBanner();
    }
  };

  els.btnBannerPrimary?.addEventListener('click', () => {
    handleBannerAction(els.btnBannerPrimary.dataset.bannerAction);
  });

  els.btnBannerSecondary?.addEventListener('click', () => {
    handleBannerAction(els.btnBannerSecondary.dataset.bannerAction);
  });

  // Move Popover selection & outside click close
  els.movePopover.addEventListener('click', async (e) => {
    const item = e.target.closest('[data-popover-move-bm]');
    if (!item) return;
    const bmId = item.dataset.popoverMoveBm;
    const targetId = item.dataset.popoverTarget;
    closeMovePopover();
    await moveBookmark(bmId, { parentId: targetId });
    const folderTitle = state.folderMap.get(targetId)?.title || '目标文件夹';
    showToast(`已移动至「${folderTitle}」`);
    if (!IS_EXTENSION) await refreshAllData();
  });

  // Right-click context menu on any bookmark card (or favorite card)
  els.galleryRoot.addEventListener('contextmenu', (e) => {
    const card = e.target.closest('.bookmark-card[data-bookmark-id], .fav-card[data-bookmark-id]');
    if (!card) {
      closeCardContextMenu();
      return;
    }
    e.preventDefault();
    openCardContextMenu(card.dataset.bookmarkId, e.clientX, e.clientY);
  });

  els.cardContextMenu.addEventListener('click', async (e) => {
    const item = e.target.closest('[data-ctx-action]');
    if (!item) return;
    const action = item.dataset.ctxAction;
    const bmId = state.contextBookmarkId;
    closeCardContextMenu();
    if (!bmId) return;
    const bm = state.allBookmarks.find((b) => b.id === bmId);
    if (!bm) return;

    if (action === 'open-tab') {
      await openBookmarkInNewTab(bm);
    } else if (action === 'open-window') {
      await openBookmarkInNewWindow(bm);
    } else if (action === 'open-split') {
      await openBookmarkInSplitView(bm);
    } else if (action === 'open-incognito') {
      await openBookmarkInIncognito(bm);
    } else if (action === 'edit') {
      openEditBookmarkModal(bm);
    } else if (action === 'remove') {
      await removeBookmark(bm.id);
      const remainingSameKey = state.allBookmarks.filter((b) => b.id !== bm.id && b.key === bm.key);
      if (remainingSameKey.length === 0) {
        const patch = {};
        if (isFavoriteKey(bm.key)) {
          state.prefs.favoriteKeys = (state.prefs.favoriteKeys || []).filter((k) => k !== bm.key);
          patch.favoriteKeys = state.prefs.favoriteKeys;
        }
        if (isBlurredKey(bm.key)) {
          state.prefs.blurredKeys = (state.prefs.blurredKeys || []).filter((k) => k !== bm.key);
          patch.blurredKeys = state.prefs.blurredKeys;
        }
        if (Object.keys(patch).length > 0) await savePreferences(patch);
      }
      showToast(`已移除书签「${bm.title}」`);
      if (!IS_EXTENSION) await refreshAllData();
    }
  });

  // Minimal Edit Bookmark Modal Events (Name & URL only, with CJK IME guard)
  let editComposing = false;
  els.editBookmarkForm.addEventListener('compositionstart', () => {
    editComposing = true;
  });
  els.editBookmarkForm.addEventListener('compositionend', () => {
    editComposing = false;
  });
  els.editBookmarkForm.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.isComposing || editComposing || e.keyCode === 229)) {
      e.preventDefault();
    }
  });
  els.btnEditBmCancel.addEventListener('click', closeEditBookmarkModal);
  els.editBookmarkOverlay.addEventListener('click', (e) => {
    if (e.target === els.editBookmarkOverlay) closeEditBookmarkModal();
  });
  els.editBookmarkForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const bmId = state.editBookmarkId;
    if (!bmId) return;
    const bm = state.allBookmarks.find((b) => b.id === bmId);
    if (!bm) {
      closeEditBookmarkModal();
      return;
    }

    const nextTitle = els.editBmTitle.value.trim();
    const nextUrl = normalizeEditedUrl(els.editBmUrl.value);
    if (!nextUrl) {
      els.editBmError.textContent = '请输入有效的网址';
      els.editBmError.hidden = false;
      els.editBmUrl.focus();
      return;
    }

    const finalTitle = nextTitle || getDisplayHost(nextUrl) || nextUrl;
    const oldKey = bm.key;
    const newKey = normalizeUrl(nextUrl);

    try {
      await updateBookmark(bm.id, { title: finalTitle, url: nextUrl });
      if (oldKey !== newKey) {
        const patch = {};
        if (isFavoriteKey(oldKey)) {
          const nextFavs = (state.prefs.favoriteKeys || []).map((k) => (k === oldKey ? newKey : k));
          state.prefs.favoriteKeys = Array.from(new Set(nextFavs));
          patch.favoriteKeys = state.prefs.favoriteKeys;
        }
        if (isBlurredKey(oldKey)) {
          const nextBlur = (state.prefs.blurredKeys || []).map((k) => (k === oldKey ? newKey : k));
          state.prefs.blurredKeys = Array.from(new Set(nextBlur));
          patch.blurredKeys = state.prefs.blurredKeys;
        }
        if (Object.keys(patch).length > 0) await savePreferences(patch);
      }
      closeEditBookmarkModal();
      showToast('已保存书签修改');
      if (!IS_EXTENSION) await refreshAllData();
    } catch {
      els.editBmError.textContent = '保存失败，请检查网址格式';
      els.editBmError.hidden = false;
    }
  });

  document.addEventListener('click', (e) => {
    if (!els.movePopover.hidden && !els.movePopover.contains(e.target) && !e.target.closest('[data-action="move"]')) {
      closeMovePopover();
    }
    if (!els.cardContextMenu.hidden && !els.cardContextMenu.contains(e.target)) {
      closeCardContextMenu();
    }
  });

  // Topbar Utility Actions
  els.btnTopbarSearch.addEventListener('click', () => openSpotlight(''));

  els.btnOpenTidy.addEventListener('click', () => {
    closeMobileSidebar();
    if (state.tidy.open) closeTidyDrawer();
    else openTidyDrawer('settings');
  });

  systemDarkQuery.addEventListener('change', applyTheme);

  // Spotlight Search Events (with full CJK IME composition guard)
  let spotlightComposing = false;
  let spotlightCompEndTs = 0;

  els.spotlightOverlay.addEventListener('click', (e) => {
    if (e.target === els.spotlightOverlay) closeSpotlight();
  });
  els.spotlightResults.addEventListener('click', (e) => {
    const itemEl = e.target.closest('.spotlight-item');
    if (itemEl) {
      const idx = Number(itemEl.dataset.spotlightIdx);
      const chosen = state.spotlight.results[idx];
      if (chosen && !isBookmarkExcludedFromCover(chosen)) {
        sendBackgroundMessage({ type: 'REGISTER_OPEN_INTENT', key: chosen.key, url: chosen.url });
      }
      closeSpotlight();
    }
  });
  els.spotlightInput.addEventListener('compositionstart', () => {
    spotlightComposing = true;
  });
  els.spotlightInput.addEventListener('compositionend', () => {
    spotlightComposing = false;
    spotlightCompEndTs = performance.now();
    updateSpotlightResults(els.spotlightInput.value);
  });
  els.spotlightInput.addEventListener('input', (e) => {
    updateSpotlightResults(e.target.value);
  });
  els.spotlightInput.addEventListener('keydown', (e) => {
    // Never intercept keys while Chinese/CJK IME is actively composing
    if (e.isComposing || spotlightComposing || e.keyCode === 229) {
      return;
    }
    if (e.key === 'Enter' && performance.now() - spotlightCompEndTs < 80) {
      return;
    }

    const count = state.spotlight.results.length;
    if (e.key === 'Escape') {
      e.preventDefault();
      closeSpotlight();
      return;
    }
    if (e.key === 'ArrowDown' && count > 0) {
      e.preventDefault();
      state.spotlight.activeIndex = (state.spotlight.activeIndex + 1) % count;
      renderSpotlightList();
    } else if (e.key === 'ArrowUp' && count > 0) {
      e.preventDefault();
      state.spotlight.activeIndex = (state.spotlight.activeIndex - 1 + count) % count;
      renderSpotlightList();
    } else if (e.key === 'Enter' && count > 0) {
      e.preventDefault();
      const chosen = state.spotlight.results[state.spotlight.activeIndex];
      if (chosen) {
        if (!isBookmarkExcludedFromCover(chosen)) {
          sendBackgroundMessage({ type: 'REGISTER_OPEN_INTENT', key: chosen.key, url: chosen.url });
        }
        window.open(chosen.url, '_blank', 'noopener,noreferrer');
        closeSpotlight();
      }
    }
  });

  // Settings Split-Pane Events
  els.btnCloseTidy.addEventListener('click', closeTidyDrawer);
  els.tidyTabs.addEventListener('click', async (e) => {
    const tab = e.target.closest('[data-tab]');
    if (!tab) return;
    state.tidy.tab = tab.dataset.tab;
    updateSegmentedControl(els.tidyTabs, `[data-tab="${state.tidy.tab}"]`);
    if (state.tidy.tab === 'settings') {
      state.tidy.stats = await getStorageStats();
    }
    renderTidyContent();
  });

  els.tidyContent.addEventListener('click', async (e) => {
    // 1. Remove duplicate bookmarks
    const dedupeBtn = e.target.closest('[data-tidy-dedupe]');
    if (dedupeBtn) {
      const ids = dedupeBtn.dataset.tidyDedupe.split(',').filter(Boolean);
      for (const id of ids) {
        await removeBookmark(id);
      }
      showToast(`已移除 ${ids.length} 条重复书签`);
      await refreshAllData();
      return;
    }

    // 1a. Open dedicated onboarding page
    if (e.target.closest('#btn-open-welcome')) {
      window.location.href = 'welcome.html';
      return;
    }

    // 1b. Open Chrome extension shortcut configuration page
    if (e.target.closest('#btn-edit-shortcut')) {
      const opened = await openExtensionShortcutsPage();
      if (!opened) {
        showToast('请在 Chrome 中打开 chrome://extensions/shortcuts 修改');
      }
      return;
    }

    // 1c. Toggle launch modes (multi-select, enforce at least 1 active)
    const launchSwitch = e.target.closest('[data-launch-pref]');
    if (launchSwitch) {
      const key = launchSwitch.dataset.launchPref;
      const launchKeys = ['launchOnNewTab', 'launchOnAction', 'launchOnStartup', 'launchOnShortcut'];
      if (!launchKeys.includes(key)) return;
      const currentVal = Boolean(state.prefs[key]);
      const activeCount = launchKeys.filter((k) => Boolean(state.prefs[k])).length;

      if (currentVal && activeCount <= 1) {
        showToast('至少保留一种打开方式');
        return;
      }

      const nextVal = !currentVal;
      state.prefs[key] = nextVal;
      await savePreferences({ [key]: nextVal });
      renderTidyContent();

      const feedback = {
        launchOnNewTab: nextVal ? '已开启新标签页打开' : '已关闭新标签页打开',
        launchOnAction: nextVal ? '已开启工具栏图标' : '已关闭工具栏图标',
        launchOnStartup: nextVal ? '已开启浏览器首页' : '已关闭浏览器首页',
        launchOnShortcut: nextVal ? `已开启快捷键 (${state.openShortcutLabel})` : '已关闭全局快捷键'
      };
      showToast(feedback[key] || '已更新打开方式');
      return;
    }

    // 2. Toggle local passive capture
    if (e.target.closest('#switch-auto-capture')) {
      state.prefs.autoCapture = !state.prefs.autoCapture;
      await savePreferences({ autoCapture: state.prefs.autoCapture });
      renderTidyContent();
      return;
    }

    // 2b. Switch visual cover mode card (local vs opt-in remote origin-only)
    const modeCard = e.target.closest('[data-settings-cover-mode]');
    if (modeCard) {
      const nextRemote = modeCard.dataset.settingsCoverMode === 'remote';
      if (Boolean(state.prefs.remoteCoverEnabled) === nextRemote) return;
      state.prefs.remoteCoverEnabled = nextRemote;
      if (!nextRemote) {
        await savePreferences({ remoteCoverEnabled: false });
        sendBackgroundMessage({ type: 'STOP_BATCH_CAPTURE' });
        clearBannerDone();
        showToast('已切为纯本地截取');
      } else {
        state.prefs.missingBannerSnoozeUntil = 0;
        await savePreferences({ remoteCoverEnabled: true, missingBannerSnoozeUntil: 0 });
        showToast('已开启公网封面补齐（仅发根域名）');
      }
      const prevY = window.scrollY;
      renderTidyContent();
      renderGallery();
      renderBatchBanner();
      if (prevY > 0) requestAnimationFrame(() => window.scrollTo(0, prevY));
      return;
    }

    // 3. Direct 1-click toggle folder in "跳过封面" (matches welcome.html chips)
    const toggleExclBtn = e.target.closest('[data-toggle-excluded]');
    if (toggleExclBtn) {
      const fid = toggleExclBtn.dataset.toggleExcluded;
      const set = new Set(state.prefs.excludedFolderIds || []);
      const willExclude = !set.has(fid);
      if (willExclude) set.add(fid);
      else set.delete(fid);
      state.prefs.excludedFolderIds = Array.from(set);
      rebuildExcludedKeySet();
      await savePreferences({ excludedFolderIds: state.prefs.excludedFolderIds });
      const prevY = window.scrollY;
      renderSidebar();
      renderTidyContent();
      renderGallery();
      renderBatchBanner();
      if (prevY > 0) requestAnimationFrame(() => window.scrollTo(0, prevY));
      const folderTitle = state.folderMap.get(fid)?.title || '';
      showToast(willExclude ? `已跳过「${folderTitle}」封面` : `已恢复「${folderTitle}」封面`);
      return;
    }

    // 6. Trigger quiet background backfill from Settings (requires opt-in remoteCoverEnabled)
    if (e.target.closest('#btn-silent-backfill')) {
      if (!state.prefs.remoteCoverEnabled) {
        showToast('请先选择「补齐公网封面」');
        return;
      }
      const missing = getMissingCapturableBookmarks();
      if (missing.length > 0) {
        closeTidyDrawer();
        sendBackgroundMessage({ type: 'START_BATCH_CAPTURE', items: missing, force: false });
        showToast(`已开始按根域名补齐 (${missing.length} 个站点)`);
      }
      return;
    }

    // 9. Prune orphan cache
    if (e.target.closest('#btn-prune-cache')) {
      const res = await sendBackgroundMessage({ type: 'PRUNE_CACHE' });
      state.tidy.stats = await getStorageStats();
      renderTidyContent();
      showToast(`已清理 ${res?.removed || 0} 条无效缓存`);
      return;
    }

    // 10. Clear all cache
    if (e.target.closest('#btn-clear-cache')) {
      await clearAllThumbnails();
      for (const objUrl of state.objectUrlCache.values()) {
        URL.revokeObjectURL(objUrl);
      }
      state.objectUrlCache.clear();
      state.thumbMeta = new Map();
      state.tidy.stats = { count: 0, totalBytes: 0 };
      state.prefs.bannerHintDismissed = false;
      state.prefs.missingBannerSnoozeUntil = 0;
      await savePreferences({ bannerHintDismissed: false, missingBannerSnoozeUntil: 0 });
      renderSidebar();
      renderTidyContent();
      renderGallery();
      renderBatchBanner();
      showToast('已清空本地首屏缓存');
    }
  });

  els.tidyContent.addEventListener('change', async (e) => {
    if (e.target.name === 'folio-ttl-days') {
      const days = Number(e.target.value);
      state.prefs.ttlDays = days;
      await savePreferences({ ttlDays: days });
      renderTidyContent();
      const labels = { 7: '每周', 30: '每月', 90: '每季度', 0: '仅手动' };
      showToast(`刷新周期已设为「${labels[days] || `${days} 天`}」`);
    }
  });

  // Global Keyboard Shortcuts
  document.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    const tag = document.activeElement?.tagName;
    const isTyping = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';

    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      if (state.spotlight.open) closeSpotlight();
      else openSpotlight('');
      return;
    }

    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'o') {
      e.preventDefault();
      if (state.tidy.open) closeTidyDrawer();
      else openTidyDrawer('settings');
      return;
    }

    if (e.key === 'Escape') {
      if (!els.editBookmarkOverlay.hidden) closeEditBookmarkModal();
      else if (state.spotlight.open) closeSpotlight();
      else if (state.tidy.open) closeTidyDrawer();
      else {
        closeMovePopover();
        closeCardContextMenu();
      }
      return;
    }

    if (isTyping || !els.editBookmarkOverlay.hidden || state.spotlight.open || state.tidy.open) return;

    if (e.key === '[' || ((e.metaKey || e.ctrlKey) && e.key === '\\')) {
      e.preventDefault();
      els.btnCollapseSidebar.click();
      return;
    }

    if (e.key === '/') {
      e.preventDefault();
      openSpotlight('');
      return;
    }

    // Start typing directly anywhere on the gallery to open Spotlight seamlessly
    if (!e.metaKey && !e.ctrlKey && !e.altKey && e.key.length === 1 && /\S/.test(e.key)) {
      e.preventDefault();
      openSpotlight(e.key);
    }
  });

  // Resize keeps segmented control thumbs aligned & adapts 2-row group preview count
  window.addEventListener('resize', () => {
    if (state.tidy.open) {
      updateSegmentedControl(els.tidyTabs, `[data-tab="${state.tidy.tab}"]`);
    }
  });

  if (typeof ResizeObserver !== 'undefined') {
    let gridResizeTimer = null;
    const ro = new ResizeObserver(() => {
      if (state.selectedFolderId !== 'all') return;
      clearTimeout(gridResizeTimer);
      const waitMs = Math.max(120, Math.ceil(sidebarAnimatingUntil - performance.now()) + 20);
      gridResizeTimer = setTimeout(() => {
        const nextCols = getGridColumnCount();
        if (nextCols !== state.lastGridCols) {
          els.galleryRoot.classList.add('is-no-enter-anim');
          renderGallery();
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              els.galleryRoot.classList.remove('is-no-enter-anim');
            });
          });
        }
      }, waitMs);
    });
    ro.observe(els.galleryRoot);
  }

  // Sweep expired 72h New tags when returning to an open tab
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    const nowTs = Date.now();
    document.querySelectorAll('.card-new-tag[data-added]').forEach((el) => {
      const added = Number(el.dataset.added);
      if (!added || nowTs - added > NEW_TAG_TTL_MS) {
        el.remove();
      }
    });
  });
}

// --- Zero-Space Overlay Scrollbar Indicators (appear only on genuine user scroll) ---
let scrollbarSuppressUntil = 0;
let hideAllScrollbarsFn = () => {};

function suppressOverlayScrollbars(durationMs = 340) {
  scrollbarSuppressUntil = performance.now() + durationMs;
  hideAllScrollbarsFn();
}

function initOverlayScrollbars() {
  const vBar = document.createElement('div');
  vBar.className = 'folio-scrollbar';
  vBar.setAttribute('aria-hidden', 'true');
  document.body.appendChild(vBar);

  const hBar = document.createElement('div');
  hBar.className = 'folio-scrollbar';
  hBar.setAttribute('aria-hidden', 'true');
  document.body.appendChild(hBar);

  let vHideTimer = null;
  let hHideTimer = null;
  let lastWinY = window.scrollY;
  const scrollPosMap = new WeakMap();

  hideAllScrollbarsFn = () => {
    clearTimeout(vHideTimer);
    clearTimeout(hHideTimer);
    vBar.classList.remove('is-visible');
    hBar.classList.remove('is-visible');
  };

  function showVerticalThumb(scrollTop, scrollHeight, clientHeight, rect) {
    if (performance.now() < scrollbarSuppressUntil) return;
    if (scrollHeight <= clientHeight + 2) return;
    const pad = 6;
    const trackLen = Math.max(32, clientHeight - pad * 2);
    const thumbLen = Math.max(30, (clientHeight / scrollHeight) * trackLen);
    const ratio = Math.min(1, Math.max(0, scrollTop / (scrollHeight - clientHeight)));
    const top = rect.top + pad + ratio * (trackLen - thumbLen);
    const left = rect.right - 7;

    vBar.style.width = '4px';
    vBar.style.height = `${thumbLen}px`;
    vBar.style.transform = `translate3d(${left}px, ${top}px, 0)`;
    vBar.style.top = '0';
    vBar.style.left = '0';
    vBar.classList.add('is-visible');

    clearTimeout(vHideTimer);
    vHideTimer = setTimeout(() => vBar.classList.remove('is-visible'), 750);
  }

  function showHorizontalThumb(scrollLeft, scrollWidth, clientWidth, rect) {
    if (performance.now() < scrollbarSuppressUntil) return;
    if (scrollWidth <= clientWidth + 2) return;
    const pad = 6;
    const trackLen = Math.max(32, clientWidth - pad * 2);
    const thumbLen = Math.max(36, (clientWidth / scrollWidth) * trackLen);
    const ratio = scrollLeft / (scrollWidth - clientWidth);
    const left = rect.left + pad + ratio * (trackLen - thumbLen);
    const top = rect.bottom - 6;

    hBar.style.height = '4px';
    hBar.style.width = `${thumbLen}px`;
    hBar.style.transform = `translate3d(${left}px, ${top}px, 0)`;
    hBar.style.top = '0';
    hBar.style.left = '0';
    hBar.classList.add('is-visible');

    clearTimeout(hHideTimer);
    hHideTimer = setTimeout(() => hBar.classList.remove('is-visible'), 750);
  }

  // Suppress synthetic scrollbars during window resize as well
  window.addEventListener('resize', () => suppressOverlayScrollbars(260), { passive: true });

  // Main window vertical scroll: anchor thumb to workspace's right edge (between content & split Settings pane)
  window.addEventListener(
    'scroll',
    () => {
      const y = window.scrollY;
      const moved = Math.abs(y - lastWinY) >= 1;
      lastWinY = y;
      if (!moved || performance.now() < scrollbarSuppressUntil) return;
      const doc = document.documentElement;
      const wsRect = document.getElementById('workspace')?.getBoundingClientRect();
      const topOffset = els.topbar ? els.topbar.offsetHeight : 0;
      const rightEdge = wsRect ? wsRect.right : window.innerWidth;
      showVerticalThumb(y, doc.scrollHeight - topOffset, window.innerHeight - topOffset, {
        top: topOffset,
        right: rightEdge
      });
    },
    { passive: true }
  );

  // Internal scrollable containers (only show axis that genuinely scrolled)
  document.addEventListener(
    'scroll',
    (e) => {
      const target = e.target;
      if (!target || target === document || target === document.documentElement || !(target instanceof HTMLElement)) {
        return;
      }
      const prev = scrollPosMap.get(target) || { top: target.scrollTop, left: target.scrollLeft };
      const dy = Math.abs(target.scrollTop - prev.top);
      const dx = Math.abs(target.scrollLeft - prev.left);
      scrollPosMap.set(target, { top: target.scrollTop, left: target.scrollLeft });

      if (performance.now() < scrollbarSuppressUntil) return;
      const rect = target.getBoundingClientRect();
      if (dy >= 1 && target.scrollHeight > target.clientHeight + 2) {
        showVerticalThumb(target.scrollTop, target.scrollHeight, target.clientHeight, rect);
      }
      if (dx >= 1 && target.scrollWidth > target.clientWidth + 2) {
        showHorizontalThumb(target.scrollLeft, target.scrollWidth, target.clientWidth, rect);
      }
    },
    { passive: true, capture: true }
  );
}

// --- Interactive Isometric Background Boxes (Sidebar Footer, OKLCH Harmonized) ---
function initSidebarBackgroundBoxes() {
  const grid = document.getElementById('sidebar-boxes-grid');
  if (!grid || grid.childElementCount > 0) return;

  // Perceptually uniform OKLCH hues matching oklch.fyi & Folio's sidebar icon wheel
  const hues = [268, 242, 206, 182, 156, 108, 68, 34, 8, 304];
  const rows = 14;
  const cols = 16;
  const plusSvg = `<svg class="bg-box-plus" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M6 2v8M2 6h8"/></svg>`;

  const frag = document.createDocumentFragment();
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cell = document.createElement('div');
      cell.className = 'bg-box-cell';
      if (r % 2 === 0 && c % 2 === 0) {
        cell.innerHTML = plusSvg;
      }
      frag.appendChild(cell);
    }
  }
  grid.appendChild(frag);

  const pickColor = () => {
    const h = hues[Math.floor(Math.random() * hues.length)];
    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    // Harmonious OKLCH fill: crisp pastel glow in light mode, vivid luminous glow in dark mode
    return isDark ? `oklch(0.72 0.165 ${h} / 0.78)` : `oklch(0.78 0.15 ${h} / 0.72)`;
  };

  grid.addEventListener('pointerover', (e) => {
    const cell = e.target.closest('.bg-box-cell');
    if (!cell) return;
    cell.classList.add('is-lit');
    cell.style.backgroundColor = pickColor();
  });

  grid.addEventListener('pointerout', (e) => {
    const cell = e.target.closest('.bg-box-cell');
    if (!cell) return;
    cell.classList.remove('is-lit');
    cell.style.backgroundColor = 'transparent';
  });
}

// --- Nyx UI–Inspired Zero-Lag Custom Cursor (OS Hardware SVG Pointer + Raw-Event Pill) ---
let customCursorInitialized = false;
let customCursorSupportsImageSet = false;

function buildPointerSvgDataUrl(fill, stroke, size) {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none">` +
    `<path d="M3.5 3.1L9.3 20.5L12.1 14.3L19.4 11.7L3.5 3.1Z" fill="rgba(0,0,0,0.22)"/>` +
    `<path d="M3 2L8.8 19.6L11.8 13.4L19.2 10.8L3 2Z" fill="${fill}" stroke="${stroke}" stroke-width="1.5" stroke-linejoin="round"/>` +
    `</svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

function buildGrabbingSvgDataUrl(fill, stroke, size) {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none">` +
    `<path d="M9 11.4V9a1.4 1.4 0 0 1 2.8 0v1.4m0-1.9a1.4 1.4 0 0 1 2.8 0v1.9m0-1.4a1.4 1.4 0 0 1 2.8 0v2.4m0-1.5a1.4 1.4 0 0 1 2.6.6v4.6a5.5 5.5 0 0 1-5.5 5.5h-1.4a5.2 5.2 0 0 1-4.3-2.3l-2.3-3.5a1.45 1.45 0 0 1 2.2-1.9L10 14.2V11.4Z" fill="rgba(0,0,0,0.22)" transform="translate(0.5 0.9)"/>` +
    `<path d="M8.5 11V8.6a1.4 1.4 0 0 1 2.8 0V10m0-1.9a1.4 1.4 0 0 1 2.8 0V10m0-1.4a1.4 1.4 0 0 1 2.8 0V11m0-1.5a1.4 1.4 0 0 1 2.6.6v4.6a5.5 5.5 0 0 1-5.5 5.5h-1.4a5.2 5.2 0 0 1-4.3-2.3l-2.3-3.5a1.45 1.45 0 0 1 2.2-1.9l1.3 1.3V11Z" fill="${fill}" stroke="${stroke}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>` +
    `</svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

function buildGrabbingHardwareCursorValue(fill, stroke) {
  const u1 = buildGrabbingSvgDataUrl(fill, stroke, 24);
  if (customCursorSupportsImageSet) {
    const u2 = buildGrabbingSvgDataUrl(fill, stroke, 48);
    return `image-set(${u1} 1x, ${u2} 2x) 12 12, grabbing`;
  }
  return `${u1} 12 12, grabbing`;
}

function buildHardwareCursorValue(fill, stroke, fallback) {
  const u1 = buildPointerSvgDataUrl(fill, stroke, 24);
  if (customCursorSupportsImageSet) {
    const u2 = buildPointerSvgDataUrl(fill, stroke, 48);
    return `image-set(${u1} 1x, ${u2} 2x) 3 2, ${fallback}`;
  }
  return `${u1} 3 2, ${fallback}`;
}

function updateCustomCursorTheme() {
  if (!customCursorInitialized) return;
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  const root = document.documentElement;
  root.style.setProperty(
    '--folio-cursor-default',
    buildHardwareCursorValue(isDark ? '#f6f6f7' : '#171717', isDark ? '#141416' : '#ffffff', 'default')
  );
}

function initCustomCursor() {
  if (customCursorInitialized) return;
  if (!window.matchMedia('(hover: hover) and (pointer: fine)').matches) return;

  customCursorInitialized = true;
  const probeUrl = buildPointerSvgDataUrl('#171717', '#ffffff', 24);
  customCursorSupportsImageSet =
    typeof CSS !== 'undefined' &&
    typeof CSS.supports === 'function' &&
    CSS.supports('cursor', `image-set(${probeUrl} 1x) 3 2, auto`);

  const root = document.documentElement;
  root.style.setProperty('--folio-cursor-indigo', buildHardwareCursorValue('#5856f2', '#ffffff', 'pointer'));
  root.style.setProperty('--folio-cursor-blue', buildHardwareCursorValue('#2d7ff9', '#ffffff', 'pointer'));
  root.style.setProperty('--folio-cursor-teal', buildHardwareCursorValue('#14a38b', '#ffffff', 'pointer'));
  root.style.setProperty('--folio-cursor-violet', buildHardwareCursorValue('#8b5cf6', '#ffffff', 'pointer'));
  root.style.setProperty('--folio-cursor-amber', buildHardwareCursorValue('#d98a1c', '#ffffff', 'pointer'));
  root.style.setProperty('--folio-cursor-rose', buildHardwareCursorValue('#e54865', '#ffffff', 'pointer'));
  root.style.setProperty('--folio-cursor-grabbing', buildGrabbingHardwareCursorValue('#7c5cf6', '#ffffff'));
  updateCustomCursorTheme();
  root.classList.add('has-custom-cursor');

  // Create Nyx-style contextual floating pill
  const pill = document.createElement('div');
  pill.id = 'folio-cursor-pill';
  pill.className = 'folio-cursor-pill';
  pill.setAttribute('aria-hidden', 'true');
  const pillInner = document.createElement('span');
  pillInner.className = 'folio-cursor-pill-inner';
  pill.appendChild(pillInner);
  document.body.appendChild(pill);

  let isVisible = false;
  let currentLabel = '';
  let currentTone = '';
  let pillW = 48;
  let pillH = 22;
  let lastX = -999;
  let lastY = -999;

  const positionPill = (x, y) => {
    let tx = x + 16;
    let ty = y + 18;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    if (tx + pillW > vw - 10) tx = x - pillW - 8;
    if (ty + pillH > vh - 10) ty = y - pillH - 8;
    if (tx < 8) tx = 8;
    if (ty < 8) ty = 8;
    pill.style.transform = `translate3d(${tx}px, ${ty}px, 0)`;
  };

  const hidePill = () => {
    if (!isVisible) return;
    isVisible = false;
    currentLabel = '';
    pill.classList.remove('is-visible', 'is-pressed');
  };

  const setPill = (label, tone) => {
    if (!label) {
      hidePill();
      return;
    }
    const labelChanged = label !== currentLabel;
    if (labelChanged) {
      currentLabel = label;
      pillInner.textContent = label;
    }
    if (tone !== currentTone) {
      currentTone = tone;
      pill.dataset.tone = tone;
    }
    if (!isVisible) {
      isVisible = true;
      pill.classList.add('is-visible');
    }
    if (labelChanged) {
      // Measure once on text change only — never during pointermove
      pillW = pillInner.offsetWidth || 48;
      pillH = pillInner.offsetHeight || 22;
    }
    if (lastX > -900) {
      positionPill(lastX, lastY);
    }
  };

  const resolveCursorPill = (target) => {
    if (!target || !(target instanceof Element)) return null;
    if (document.documentElement.classList.contains('is-dragging-card')) return null;
    if (els.cardContextMenu && !els.cardContextMenu.hidden) return null;
    if (target.closest('input, textarea, select')) return null;

    const favBtn = target.closest('.card-fav-btn');
    if (favBtn) {
      return {
        label: favBtn.classList.contains('is-favorited') ? '取消收藏' : '收藏',
        tone: 'amber'
      };
    }

    const actionBtn = target.closest('.card-action-btn');
    if (actionBtn) {
      const act = actionBtn.dataset.action;
      if (act === 'toggle-blur') {
        return {
          label: actionBtn.classList.contains('is-active') ? '显示封面' : '隐藏封面',
          tone: 'violet'
        };
      }
      if (act === 'recapture') return { label: '刷新封面', tone: 'blue' };
      if (act === 'copy') return { label: '复制链接', tone: 'teal' };
      if (act === 'move') return { label: '移动', tone: 'violet' };
    }

    if (target.closest('.bookmark-card, .fav-card')) {
      return { label: '打开', tone: 'indigo' };
    }

    if (target.closest('.view-all-card')) {
      return { label: '查看全部', tone: 'indigo' };
    }

    if (target.closest('#btn-topbar-search')) {
      return { label: '搜索 ⌘K', tone: 'blue' };
    }

    if (target.closest('#btn-open-tidy')) {
      return { label: state.tidy.open ? '收起设置' : '设置', tone: 'teal' };
    }

    if (target.closest('#btn-close-tidy')) {
      return { label: '收起', tone: 'teal' };
    }

    if (target.closest('#btn-collapse-sidebar')) {
      return { label: state.prefs.sidebarCollapsed ? '展开' : '收起', tone: 'violet' };
    }

    if (target.closest('#btn-back-to-top')) {
      return { label: '回到顶部', tone: 'teal' };
    }

    if (target.closest('.brand-link')) {
      return { label: '全部书签', tone: 'violet' };
    }

    const navItem = target.closest('.nav-item');
    if (navItem && els.sidebar?.classList.contains('is-collapsed')) {
      const text = navItem.querySelector('.nav-label')?.textContent?.trim();
      if (text) return { label: text, tone: 'violet' };
    }

    const dangerEl = target.closest('.btn-danger, .context-menu-item.is-danger');
    if (dangerEl) {
      const txt = dangerEl.textContent?.trim();
      return { label: txt && txt.length <= 6 ? txt : '移除', tone: 'rose' };
    }

    return null;
  };

  // Synchronous raw-pointer tracking: zero rAF queueing, zero lerp, zero transition lag
  const onMove = (e) => {
    if (e.pointerType && e.pointerType !== 'mouse' && e.pointerType !== 'pen') {
      hidePill();
      return;
    }
    const x = e.clientX;
    const y = e.clientY;
    if (x === lastX && y === lastY) return;
    lastX = x;
    lastY = y;
    if (isVisible) {
      positionPill(x, y);
    }
  };

  if ('onpointerrawupdate' in window) {
    window.addEventListener('pointerrawupdate', onMove, { passive: true });
  }
  window.addEventListener('pointermove', onMove, { passive: true });

  // Boundary-only target detection (never runs per-pixel)
  document.addEventListener(
    'pointerover',
    (e) => {
      if (e.pointerType && e.pointerType !== 'mouse' && e.pointerType !== 'pen') return;
      lastX = e.clientX;
      lastY = e.clientY;
      const spec = resolveCursorPill(e.target);
      if (spec) setPill(spec.label, spec.tone);
      else hidePill();
    },
    { passive: true }
  );

  document.addEventListener(
    'pointerdown',
    (e) => {
      if (isVisible && (!e.pointerType || e.pointerType === 'mouse')) {
        pill.classList.add('is-pressed');
      }
    },
    { passive: true }
  );

  window.addEventListener(
    'pointerup',
    () => {
      pill.classList.remove('is-pressed');
      // Refresh dynamic labels right after click (e.g. 收藏 <-> 取消收藏, 设置 <-> 收起设置)
      if (isVisible && lastX > -900) {
        requestAnimationFrame(() => {
          const under = document.elementFromPoint(lastX, lastY);
          const spec = resolveCursorPill(under);
          if (spec) setPill(spec.label, spec.tone);
          else hidePill();
        });
      }
    },
    { passive: true }
  );

  document.addEventListener('dragstart', hidePill, { passive: true });
  document.addEventListener('contextmenu', hidePill, { passive: true });
  document.addEventListener('mouseleave', hidePill, { passive: true });
  window.addEventListener('blur', hidePill, { passive: true });
  window.addEventListener('scroll', hidePill, { passive: true });
}

// --- Bootstrap ---
async function init() {
  const urlParams = new URLSearchParams(window.location.search);
  if (urlParams.get('onboarding') === '1') {
    window.location.replace('welcome.html');
    return;
  }

  state.prefs = await loadPreferences();
  bindEvents();
  initOverlayScrollbars();
  initSidebarBackgroundBoxes();
  initCustomCursor();
  applyTheme();
  applyLayoutPreferences();
  // Commit initial sidebar width cleanly with transitions disabled, then unlock interactive spring transitions
  void els.sidebar.offsetWidth;
  document.documentElement.classList.remove('is-sidebar-collapsed-boot');
  requestAnimationFrame(() => {
    document.documentElement.classList.remove('is-booting');
  });

  // In HTTP preview mode outside Chrome Extension, seed realistic canvas thumbnails once
  if (!IS_EXTENSION && urlParams.get('empty-covers') !== '1') {
    await seedMockThumbnailsIfNeeded();
  }

  await refreshAllData();

  // Real-time Chrome bookmark synchronization
  subscribeBookmarkChanges(() => {
    scheduleRefreshAllData();
  });

  // Listen for live first-screen capture updates & batch progress
  subscribeRuntimeMessages(async (msg) => {
    if (!msg || !msg.type) return;
    if (msg.type === 'SCREENSHOT_UPDATED' && msg.key) {
      state.thumbMeta.set(msg.key, { capturedAt: msg.capturedAt, size: msg.size, status: 'ok' });
      await refreshLiveCardsForKey(msg.key);
      renderSidebar();
      renderBatchBanner();
    } else if (msg.type === 'BATCH_PROGRESS') {
      const wasRunning = state.batch.running;
      state.batch = msg;
      if (msg.running) {
        clearBannerDone();
      } else if (wasRunning && msg.captured > 0) {
        clearBannerDone();
        state.bannerDone = { captured: msg.captured, failed: msg.failed || 0 };
        bannerDoneTimer = setTimeout(() => {
          state.bannerDone = null;
          renderBatchBanner();
        }, 6000);
      }
      renderBatchBanner();
    }
  });

  // Sync any in-flight batch capture state if user opens a second New Tab
  const batchState = await sendBackgroundMessage({ type: 'GET_BATCH_STATE' });
  if (batchState && batchState.running) {
    state.batch = batchState;
  }

  // Trigger simulated backfill seamlessly when arriving from welcome.html in HTTP preview mode
  if (!IS_EXTENSION && urlParams.get('autobackfill') === '1') {
    if (window.history?.replaceState) {
      window.history.replaceState(null, '', window.location.pathname);
    }
    const items = getCapturablePublicBookmarks().slice(0, 6);
    if (items.length > 0) {
      sendBackgroundMessage({ type: 'START_BATCH_CAPTURE', items, force: false });
    }
  }

  renderBatchBanner();
  // Pre-warm WebGL2 shader & optical lens map on idle so first Spotlight trigger has 0ms delay
  if (typeof requestIdleCallback === 'function') {
    requestIdleCallback(() => warmShockwaveEngine(), { timeout: 600 });
  } else {
    setTimeout(() => warmShockwaveEngine(), 120);
  }
}

init();
