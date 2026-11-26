// Folio — Minimalist Visual Bookmark Gallery App Controller

import { ICONS } from './icons.js';
import {
  getDisplayHost,
  getDomainHue,
  getFaviconUrl,
  isCapturableUrl,
  isLikelyInternalFolder,
  isPrivateOrInternalUrl,
  normalizeUrl
} from './shared/url.js';
import {
  clearAllThumbnails,
  getStorageStats,
  getThumbnail,
  getThumbnailMetaMap
} from './shared/db.js';
import { analyzeBookmarks } from './shared/organizer.js';
import {
  IS_EXTENSION,
  createBookmarkFolder,
  getBookmarkTree,
  loadPreferences,
  moveBookmark,
  removeBookmark,
  savePreferences,
  seedMockThumbnailsIfNeeded,
  sendBackgroundMessage,
  subscribeBookmarkChanges,
  subscribeRuntimeMessages
} from './shared/chrome-bridge.js';

// New tag expires 72 hours after bookmark creation
const NEW_TAG_TTL_MS = 72 * 60 * 60 * 1000;

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
    initialCapturePrompted: false,
    favoriteKeys: [],
    excludedFolderIds: null
  },
  rootBarId: '1',
  topFolders: [],          // Top-level bookmark folders
  folderMap: new Map(),    // folderId -> folder node (with recursive items & children)
  allBookmarks: [],        // Flat list of all bookmarks with folder metadata
  looseBookmarks: [],      // Bookmarks sitting directly on bookmark bar / other root
  selectedFolderId: 'all', // 'all' | 'loose' | <folderId>
  activeSubfolderId: 'all',
  expandedSidebarFolders: new Set(),
  expandedGroupsInAll: new Set(),
  lastGridCols: 0,
  thumbMeta: new Map(),    // normalizedUrl -> { capturedAt, size, status }
  objectUrlCache: new Map(), // normalizedUrl -> blob objectURL
  analysis: null,
  batch: { running: false, current: 0, total: 0, captured: 0, failed: 0, currentTitle: '' },
  spotlight: { open: false, query: '', results: [], activeIndex: 0 },
  tidy: { open: false, tab: 'suggestions', stats: { count: 0, totalBytes: 0 } },
  dragBookmarkId: null,
  contextBookmarkId: null
};

// --- DOM References ---
const els = {
  app: document.getElementById('app'),
  sidebar: document.getElementById('sidebar'),
  sidebarBackdrop: document.getElementById('sidebar-backdrop'),
  sidebarNav: document.getElementById('sidebar-nav'),
  brandHome: document.getElementById('brand-home'),
  btnCollapseSidebar: document.getElementById('btn-collapse-sidebar'),
  btnMobileMenu: document.getElementById('btn-mobile-menu'),
  btnOpenTidy: document.getElementById('btn-open-tidy'),
  btnTopbarSearch: document.getElementById('btn-topbar-search'),
  btnStopBatch: document.getElementById('btn-stop-batch'),
  onboardingOverlay: document.getElementById('onboarding-overlay'),
  onboardingMark: document.getElementById('onboarding-mark'),
  onboardingDesc: document.getElementById('onboarding-desc'),
  btnOnboardingStart: document.getElementById('btn-onboarding-start'),
  btnOnboardingSkip: document.getElementById('btn-onboarding-skip'),
  topbar: document.getElementById('topbar'),
  viewTitle: document.getElementById('view-title'),
  viewCount: document.getElementById('view-count'),
  batchBanner: document.getElementById('batch-banner'),
  batchBannerText: document.getElementById('batch-banner-text'),
  batchBarFill: document.getElementById('batch-bar-fill'),
  subfolderBar: document.getElementById('subfolder-bar'),
  galleryRoot: document.getElementById('gallery-root'),
  tidyCountHint: document.getElementById('tidy-count-hint'),
  spotlightOverlay: document.getElementById('spotlight-overlay'),
  spotlightInput: document.getElementById('spotlight-input'),
  spotlightResults: document.getElementById('spotlight-results'),
  tidyOverlay: document.getElementById('tidy-overlay'),
  btnCloseTidy: document.getElementById('btn-close-tidy'),
  tidyTabs: document.getElementById('tidy-tabs'),
  tidyContent: document.getElementById('tidy-content'),
  movePopover: document.getElementById('move-popover'),
  cardContextMenu: document.getElementById('card-context-menu'),
  ctxRemoveBookmark: document.getElementById('ctx-remove-bookmark'),
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

function getSidebarFolderIcon(title, isActive) {
  const t = (title || '').toLowerCase();
  if (t.includes('公司') || t.includes('工作') || t.includes('work') || t.includes('company')) return ICONS.glassWork;
  if (t.includes('论坛') || t.includes('博客') || t.includes('阅读') || t.includes('blog') || t.includes('forum')) return ICONS.glassForum;
  if (t.includes('视觉') || t.includes('灵感') || t.includes('设计') || t.includes('design') || t.includes('ui')) return ICONS.glassVisual;
  if (t.includes('个站') || t.includes('作品') || t.includes('site') || t.includes('web')) return ICONS.glassGlobe;
  if (t.includes('工具') || t.includes('效率') || t.includes('tool')) return ICONS.glassTools;
  if (t.includes('code') || t.includes('开发') || t.includes('前端') || t.includes('dev')) return ICONS.glassCode;
  if (t.includes('规范') || t.includes('文档') || t.includes('spec') || t.includes('doc')) return ICONS.glassSpec;
  if (t.includes('ai') || t.includes('大模型') || t.includes('智能')) return ICONS.glassAi;
  return isActive ? ICONS.glassFolderActive : ICONS.glassFolder;
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

  function processFolder(node, topFolderId, topFolderTitle, pathParts, depth) {
    const currentPath = [...pathParts, node.title];
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

    for (const child of node.children || []) {
      if (child.url) {
        const bm = {
          id: child.id,
          parentId: node.id,
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
        const sub = processFolder(child, topFolderId, topFolderTitle, currentPath, depth + 1);
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
    for (const child of container.children || []) {
      if (child.url) {
        const bm = {
          id: child.id,
          parentId: container.id,
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
        const folderObj = processFolder(child, child.id, child.title || '未命名文件夹', [], 0);
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

  // Validate currently selected folder still exists
  if (
    state.selectedFolderId !== 'all' &&
    state.selectedFolderId !== 'loose' &&
    !folderMap.has(state.selectedFolderId)
  ) {
    state.selectedFolderId = 'all';
    state.activeSubfolderId = 'all';
  }

  // Recompute local organizer insights
  state.analysis = analyzeBookmarks(topFolders, allBookmarks);
}

// --- Theme & Preferences (Follows Browser Color Scheme) ---
const systemDarkQuery = window.matchMedia('(prefers-color-scheme: dark)');

function applyTheme() {
  document.documentElement.setAttribute('data-theme', systemDarkQuery.matches ? 'dark' : 'light');
}

function applyLayoutPreferences() {
  const collapsed = Boolean(state.prefs.sidebarCollapsed);
  els.sidebar.classList.toggle('is-collapsed', collapsed);
  els.btnCollapseSidebar.innerHTML = collapsed ? ICONS.sidebarExpand : ICONS.sidebarCollapse;
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

// --- Sidebar Rendering ---
function renderSidebar() {
  const frag = document.createDocumentFragment();

  // "All Bookmarks" item
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
  frag.appendChild(allBtn);

  // Loose root bookmarks if present
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
    frag.appendChild(looseBtn);
  }

  const divider = document.createElement('div');
  divider.className = 'nav-divider';
  frag.appendChild(divider);

  // Recursive folder tree renderer
  function createFolderRow(folder) {
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
        childrenBox.appendChild(createFolderRow(sub));
      }
      wrap.appendChild(childrenBox);
    }

    return wrap;
  }

  for (const folder of state.topFolders) {
    frag.appendChild(createFolderRow(folder));
  }

  els.sidebarNav.innerHTML = '';
  els.sidebarNav.appendChild(frag);

  // Update Tidy hint count
  const suggestionTotal =
    (state.analysis?.structureInsights.length || 0) +
    (state.analysis?.moveSuggestions.length || 0) +
    (state.analysis?.duplicates.length || 0);
  els.tidyCountHint.textContent = suggestionTotal > 0 ? String(suggestionTotal) : '';
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
    btn.title = added ? '取消收藏' : '加入顶部收藏';
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
  card.className = 'bookmark-card';
  card.style.setProperty('--stagger-i', String(Math.min(index, 12)));
  card.style.setProperty('--card-hue', String(getDomainHue(bm.url)));
  card.draggable = true;
  card.dataset.bookmarkId = bm.id;

  const faviconUrl = getFaviconUrl(bm.url, 32);
  const initialLetter = escapeHtml((bm.host || bm.title || '?')[0].toUpperCase());
  const hasThumbMeta = state.thumbMeta.has(bm.key);
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
    <div class="card-stage">
      <a href="${escapeHtml(bm.url)}" class="card-link" target="_blank" rel="noopener noreferrer" aria-label="${escapeHtml(bm.title)}">
        <div class="card-placeholder">
          <div class="placeholder-chrome" aria-hidden="true">
            <span class="placeholder-dot"></span>
            <span class="placeholder-dot"></span>
            <span class="placeholder-dot"></span>
          </div>
          <div class="placeholder-icon-wrap">${placeholderFaviconHtml}</div>
          <span class="placeholder-host">${escapeHtml(bm.host)}</span>
        </div>
        <img class="card-thumb" data-thumb-key="${escapeHtml(bm.key)}" alt="" decoding="async" />
      </a>
      <div class="card-actions">
        <button type="button" class="card-action-btn" data-action="recapture" data-id="${escapeHtml(bm.id)}" title="重新抓取首屏" aria-label="重新抓取首屏">${ICONS.refresh}</button>
        <button type="button" class="card-action-btn" data-action="copy" data-id="${escapeHtml(bm.id)}" title="复制链接" aria-label="复制链接">${ICONS.copy}</button>
        <button type="button" class="card-action-btn" data-action="move" data-id="${escapeHtml(bm.id)}" title="移动到其他文件夹" aria-label="移动到其他文件夹">${ICONS.move}</button>
      </div>
      <button type="button" class="card-fav-btn${isFav ? ' is-favorited' : ''}" data-action="favorite" data-id="${escapeHtml(bm.id)}" data-key="${escapeHtml(bm.key)}" title="${isFav ? '取消收藏' : '加入顶部收藏'}" aria-label="${isFav ? '取消收藏' : '加入顶部收藏'}" aria-pressed="${isFav ? 'true' : 'false'}">${isFav ? ICONS.starFilled : ICONS.star}</button>
    </div>
    <a href="${escapeHtml(bm.url)}" class="card-meta" target="_blank" rel="noopener noreferrer">
      ${faviconSmallHtml}
      <div class="card-text">
        <div class="card-title-row">
          <span class="card-title">${escapeHtml(bm.title)}</span>
          ${isNew ? `<span class="card-new-tag" data-added="${bm.dateAdded}" title="72 小时内新收藏">New</span>` : ''}
        </div>
        <span class="card-sub">${escapeHtml(subtitle)}</span>
      </div>
    </a>
  `;

  // Observe thumbnail image for lazy IndexedDB decoding
  const thumbImg = card.querySelector('img.card-thumb');
  if (thumbImg && hasThumbMeta) {
    thumbObserver.observe(thumbImg);
  }

  return card;
}

// --- Main Gallery View Rendering ---
function getCurrentScopeBookmarks() {
  if (state.selectedFolderId === 'all') {
    return state.allBookmarks;
  }
  if (state.selectedFolderId === 'loose') {
    return state.looseBookmarks;
  }
  const folder = state.folderMap.get(state.selectedFolderId);
  if (!folder) return [];
  if (state.activeSubfolderId !== 'all') {
    const sub = state.folderMap.get(state.activeSubfolderId);
    return sub ? sub.allBookmarks : folder.allBookmarks;
  }
  return folder.allBookmarks;
}

function updateTopbarHeader() {
  const scopeBookmarks = getCurrentScopeBookmarks();
  const isAll = state.selectedFolderId === 'all';

  if (isAll) {
    els.viewTitle.textContent = '全部书签';
    els.viewCount.textContent = `${state.allBookmarks.length}`;
  } else if (state.selectedFolderId === 'loose') {
    els.viewTitle.textContent = '未归类书签';
    els.viewCount.textContent = `${state.looseBookmarks.length}`;
  } else {
    const folder = state.folderMap.get(state.selectedFolderId);
    els.viewTitle.textContent = folder ? folder.title : '书签';
    els.viewCount.textContent = `${scopeBookmarks.length}`;
  }
}

function renderSubfolderBar() {
  if (state.selectedFolderId === 'all' || state.selectedFolderId === 'loose') {
    els.subfolderBar.hidden = true;
    els.subfolderBar.innerHTML = '';
    return;
  }
  const folder = state.folderMap.get(state.selectedFolderId);
  if (!folder || folder.subfolders.length === 0) {
    els.subfolderBar.hidden = true;
    els.subfolderBar.innerHTML = '';
    return;
  }

  els.subfolderBar.hidden = false;
  const tabs = [
    { id: 'all', label: `全部 (${folder.totalCount})` },
    ...folder.subfolders.map((sub) => ({ id: sub.id, label: `${sub.title} (${sub.totalCount})` }))
  ];

  els.subfolderBar.innerHTML = tabs
    .map(
      (t) => `<button type="button" class="subfolder-tab${state.activeSubfolderId === t.id ? ' is-active' : ''}" data-subfolder-id="${escapeHtml(t.id)}">${escapeHtml(t.label)}</button>`
    )
    .join('');
}

function getGridColumnCount() {
  if (window.innerWidth <= 720) return 1;
  const style = getComputedStyle(els.galleryRoot);
  const padX = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
  const innerWidth = Math.max(220, els.galleryRoot.clientWidth - padX);
  const minCard = 220;
  const colGap = 14;
  return Math.max(1, Math.floor((innerWidth + colGap) / (minCard + colGap)));
}

function getGroupPreviewLimit() {
  const cols = getGridColumnCount();
  state.lastGridCols = cols;
  return cols === 1 ? 6 : cols * 2; // Exactly 2 full rows on desktop/tablet
}

function renderGallery() {
  initThumbObserver();
  updateTopbarHeader();
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
      for (const bm of visibleItems) {
        grid.appendChild(createCardElement(bm, cardOffset++));
      }
      if (!isExpanded) {
        grid.appendChild(createViewAllCard(group, cardOffset++));
      }
      frag.appendChild(section);
    }

    root.appendChild(frag);
    return;
  }

  // View 2: Single Folder View
  const items = [...getCurrentScopeBookmarks()];

  if (items.length === 0) {
    root.innerHTML = `
      <div class="empty-state">
        <h2 class="empty-title">该文件夹暂时为空</h2>
        <p class="empty-desc">你可以直接从其他分组拖动书签卡片到左侧这个文件夹，或在 Chrome 书签栏中收藏新网页。</p>
      </div>
    `;
    return;
  }

  const grid = document.createElement('div');
  grid.className = 'card-grid';
  items.forEach((bm, idx) => {
    grid.appendChild(createCardElement(bm, idx));
  });
  root.appendChild(grid);
}

// --- Batch Capture Banner ---
function renderBatchBanner() {
  const b = state.batch;
  if (!b.running) {
    els.batchBanner.hidden = true;
    return;
  }
  els.batchBanner.hidden = false;
  const pct = b.total > 0 ? Math.round((b.current / b.total) * 100) : 0;
  els.batchBannerText.textContent = `正在捕捉首屏 (${b.current}/${b.total}) · ${b.currentTitle || ''}`;
  els.batchBarFill.style.width = `${pct}%`;
}

function isBookmarkExcludedFromCover(bm) {
  if (!bm || !isCapturableUrl(bm.url) || isPrivateOrInternalUrl(bm.url)) return true;
  const excludedSet = new Set(state.prefs.excludedFolderIds || []);
  return excludedSet.has(bm.topFolderId) || excludedSet.has(bm.parentId);
}

// --- First-Time Onboarding Prompt ---
function getMissingCapturableBookmarks() {
  return state.allBookmarks.filter((b) => !isBookmarkExcludedFromCover(b) && !state.thumbMeta.has(b.key));
}

function maybeShowOnboardingPrompt() {
  const forcePreview = new URLSearchParams(window.location.search).get('onboarding') === '1';
  if (!forcePreview && (state.prefs.initialCapturePrompted || state.batch.running)) return;
  if (state.allBookmarks.length === 0) return;

  const missing = getMissingCapturableBookmarks();
  if (missing.length === 0) {
    state.prefs.initialCapturePrompted = true;
    savePreferences({ initialCapturePrompted: true });
    return;
  }

  const folderCount = state.topFolders.length;
  const excludedNames = state.topFolders
    .filter((f) => (state.prefs.excludedFolderIds || []).includes(f.id))
    .map((f) => `「${f.title}」`)
    .join('、');
  const skipNote = excludedNames ? `（已自动跳过 ${excludedNames} 等内网分组）` : '';

  els.onboardingDesc.textContent = `已同步 ${folderCount} 个文件夹、共 ${state.allBookmarks.length} 个书签${skipNote}。现在可在后台静默捕捉 ${missing.length} 个公网首屏，全程不弹窗口；之后按月自动更新并在浏览时无感升级为真实首屏。`;
  els.btnOnboardingStart.textContent = `后台静默捕捉首屏 (${missing.length})`;
  els.onboardingOverlay.hidden = false;
  els.onboardingOverlay.setAttribute('aria-hidden', 'false');
  els.app.classList.add('is-spotlight-open');
}

function closeOnboardingPrompt() {
  if (els.onboardingOverlay.hidden) return;
  els.onboardingOverlay.hidden = true;
  els.onboardingOverlay.setAttribute('aria-hidden', 'true');
  els.app.classList.remove('is-spotlight-open');
  if (!state.prefs.initialCapturePrompted) {
    state.prefs.initialCapturePrompted = true;
    savePreferences({ initialCapturePrompted: true });
  }
}

// --- Spotlight Search ---
function openSpotlight(initialChar = '') {
  state.spotlight.open = true;
  els.spotlightOverlay.hidden = false;
  els.spotlightOverlay.setAttribute('aria-hidden', 'false');
  els.app.classList.add('is-spotlight-open');
  els.spotlightInput.value = initialChar;
  els.spotlightInput.focus();
  updateSpotlightResults(initialChar);
}

function closeSpotlight() {
  if (!state.spotlight.open) return;
  state.spotlight.open = false;
  els.spotlightOverlay.hidden = true;
  els.spotlightOverlay.setAttribute('aria-hidden', 'true');
  els.app.classList.remove('is-spotlight-open');
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
          <div class="spotlight-mini-thumb" data-spot-key="${escapeHtml(bm.key)}">
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

  // Hydrate mini thumbnails from cache if available
  for (const bm of state.spotlight.results) {
    if (!state.thumbMeta.has(bm.key)) continue;
    const objUrl = await resolveObjectUrl(bm.key);
    if (!objUrl) continue;
    const box = list.querySelector(`.spotlight-mini-thumb[data-spot-key="${CSS.escape(bm.key)}"]`);
    if (box) {
      box.innerHTML = `<img src="${objUrl}" alt="" />`;
    }
  }
}

// --- Tidy Studio Drawer (Grouping Suggestions, Health, Cache & Privacy) ---
async function openTidyDrawer(defaultTab = 'suggestions') {
  state.tidy.open = true;
  state.tidy.tab = defaultTab;
  state.tidy.stats = await getStorageStats();
  els.tidyOverlay.hidden = false;
  els.tidyOverlay.setAttribute('aria-hidden', 'false');
  updateSegmentedControl(els.tidyTabs, `[data-tab="${defaultTab}"]`);
  renderTidyContent();
}

function closeTidyDrawer() {
  state.tidy.open = false;
  els.tidyOverlay.hidden = true;
  els.tidyOverlay.setAttribute('aria-hidden', 'true');
}

function renderTidyContent() {
  const container = els.tidyContent;
  const analysis = state.analysis || { structureInsights: [], moveSuggestions: [], domainClusters: [], duplicates: [] };

  if (state.tidy.tab === 'suggestions') {
    const sections = [];

    // 1. Folder Architecture Insights
    if (analysis.structureInsights.length > 0) {
      sections.push(`
        <section class="tidy-group">
          <h3 class="tidy-group-title">文件夹结构优化建议</h3>
          <div class="tidy-list">
            ${analysis.structureInsights
              .map((ins) => {
                let actionHtml = '';
                if (ins.actionType === 'nest' && ins.parentFolder && ins.childFolder) {
                  actionHtml = `<button type="button" class="text-action is-accent tidy-row-action" data-tidy-nest="${escapeHtml(ins.childFolder.id)}" data-target-parent="${escapeHtml(ins.parentFolder.id)}">一键收拢</button>`;
                } else if (ins.actionType === 'create_inbox') {
                  actionHtml = `<button type="button" class="text-action is-accent tidy-row-action" data-tidy-create-inbox="1">建收集箱并移入</button>`;
                }
                return `
                  <div class="tidy-row">
                    <div class="tidy-row-main">
                      <span class="tidy-row-title">${escapeHtml(ins.title)}</span>
                      <span class="tidy-row-desc">${escapeHtml(ins.detail)}</span>
                    </div>
                    ${actionHtml}
                  </div>
                `;
              })
              .join('')}
          </div>
        </section>
      `);
    }

    // 2. Smart Move Suggestions
    if (analysis.moveSuggestions.length > 0) {
      sections.push(`
        <section class="tidy-group">
          <h3 class="tidy-group-title">单条归类建议 (${analysis.moveSuggestions.length})</h3>
          <div class="tidy-list">
            ${analysis.moveSuggestions
              .map(
                (item) => `
              <div class="tidy-row">
                <div class="tidy-row-main">
                  <span class="tidy-row-title">${escapeHtml(item.bookmark.title)}</span>
                  <span class="tidy-row-desc">当前位于「${escapeHtml(item.fromLabel)}」 · ${escapeHtml(item.reason)}</span>
                </div>
                <button type="button" class="text-action is-accent tidy-row-action" data-tidy-move="${escapeHtml(item.bookmark.id)}" data-target-parent="${escapeHtml(item.targetFolder.id)}">移至 ${escapeHtml(item.targetFolder.title)}</button>
              </div>
            `
              )
              .join('')}
          </div>
        </section>
      `);
    }

    // 3. Same-Domain Scattered Clusters
    if (analysis.domainClusters.length > 0) {
      sections.push(`
        <section class="tidy-group">
          <h3 class="tidy-group-title">同源站点分散提醒</h3>
          <div class="tidy-list">
            ${analysis.domainClusters
              .map((cluster) => {
                const folderNames = cluster.folders.map((f) => `${f.title}(${f.items.length})`).join('、');
                const canUnify = cluster.primaryFolder && cluster.primaryFolder.id !== 'root' && cluster.primaryFolder.id !== 'loose';
                return `
                  <div class="tidy-row">
                    <div class="tidy-row-main">
                      <span class="tidy-row-title">${escapeHtml(cluster.domain)} · 共 ${cluster.total} 项</span>
                      <span class="tidy-row-desc">分布在：${escapeHtml(folderNames)}</span>
                    </div>
                    ${canUnify ? `<button type="button" class="text-action is-accent tidy-row-action" data-tidy-unify-domain="${escapeHtml(cluster.domain)}" data-target-parent="${escapeHtml(cluster.primaryFolder.id)}">聚合至 ${escapeHtml(cluster.primaryFolder.title)}</button>` : ''}
                  </div>
                `;
              })
              .join('')}
          </div>
        </section>
      `);
    }

    if (sections.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <h3 class="empty-title">当前分组结构很清晰</h3>
          <p class="empty-desc">暂未发现明显重叠的分类或散落的书签。你也可以直接在画廊里拖动任意卡片到左侧文件夹完成归类。</p>
        </div>
      `;
    } else {
      container.innerHTML = sections.join('');
    }
    return;
  }

  if (state.tidy.tab === 'health') {
    const publicBookmarks = state.allBookmarks.filter((b) => !isBookmarkExcludedFromCover(b));
    const missingPublic = publicBookmarks.filter((b) => !state.thumbMeta.has(b.key));
    const dupHtml =
      analysis.duplicates.length > 0
        ? analysis.duplicates
            .map((dup) => {
              const keep = dup.items[0];
              const extras = dup.items.slice(1);
              return `
                <div class="tidy-row">
                  <div class="tidy-row-main">
                    <span class="tidy-row-title">${escapeHtml(dup.title)}</span>
                    <span class="tidy-row-desc">保留「${escapeHtml(keep.folderPath)}」，另在 ${extras.map((e) => `「${escapeHtml(e.folderPath)}」`).join('、')} 重复出现</span>
                  </div>
                  <button type="button" class="text-action is-danger tidy-row-action" data-tidy-dedupe="${escapeHtml(extras.map((e) => e.id).join(','))}">移除重复</button>
                </div>
              `;
            })
            .join('')
        : `<div class="tidy-row"><div class="tidy-row-main"><span class="tidy-row-desc">未检测到重复收藏的网址。</span></div></div>`;

    container.innerHTML = `
      <section class="tidy-group">
        <h3 class="tidy-group-title">重复收藏检测 (${analysis.duplicates.length})</h3>
        <div class="tidy-list">${dupHtml}</div>
      </section>
      <section class="tidy-group">
        <h3 class="tidy-group-title">公网首屏覆盖进度</h3>
        <div class="tidy-list">
          <div class="tidy-row">
            <div class="tidy-row-main">
              <span class="tidy-row-title">已缓存 ${publicBookmarks.length - missingPublic.length} / ${publicBookmarks.length} 个公网书签首屏</span>
              <span class="tidy-row-desc">内网与已排除分组不抓封面。日常访问会自动升级为真实首屏，并按设定周期在后台静默保鲜。</span>
            </div>
          </div>
        </div>
      </section>
    `;
    return;
  }

  // Tab 3: Cache & Settings
  const excludedSet = new Set(state.prefs.excludedFolderIds || []);
  const missingPublicCount = getMissingCapturableBookmarks().length;
  const folderRows = state.topFolders
    .map(
      (f) => `
      <div class="setting-folder-row">
        <span>${escapeHtml(f.title)}</span>
        <button type="button" class="setting-switch" role="switch" aria-checked="${excludedSet.has(f.id) ? 'true' : 'false'}" data-toggle-excluded="${escapeHtml(f.id)}" aria-label="跳过 ${escapeHtml(f.title)} 的首屏封面抓取"></button>
      </div>
    `
    )
    .join('');

  container.innerHTML = `
    <section class="tidy-group">
      <h3 class="tidy-group-title">自动首屏更新</h3>
      <div class="tidy-list">
        <div class="tidy-row">
          <div class="tidy-row-main">
            <span class="tidy-row-title">后台静默补齐与访问升级</span>
            <span class="tidy-row-desc">公网站点在后台零弹窗静默抓取（mShots 首屏优先，OG 封面兜底），你访问时自动升级为真实首屏。</span>
          </div>
          <button type="button" class="setting-switch" role="switch" aria-checked="${state.prefs.autoCapture ? 'true' : 'false'}" id="switch-auto-capture" aria-label="开启或关闭自动首屏更新"></button>
        </div>
        <div class="tidy-row">
          <div class="tidy-row-main">
            <span class="tidy-row-title">定时后台刷新周期</span>
            <span class="tidy-row-desc">通过浏览器长周期任务定期巡检并静默刷新过期首屏，零高频打扰。</span>
          </div>
          <select id="select-ttl-days" class="setting-select" aria-label="定时后台刷新周期">
            <option value="7" ${state.prefs.ttlDays === 7 ? 'selected' : ''}>每周 (7 天)</option>
            <option value="30" ${state.prefs.ttlDays === 30 ? 'selected' : ''}>每月 (30 天)</option>
            <option value="90" ${state.prefs.ttlDays === 90 ? 'selected' : ''}>每季度 (90 天)</option>
            <option value="0" ${state.prefs.ttlDays === 0 ? 'selected' : ''}>仅手动刷新</option>
          </select>
        </div>
      </div>
    </section>

    <section class="tidy-group">
      <h3 class="tidy-group-title">跳过封面的内网 / 内部文件夹</h3>
      <p class="tidy-row-desc" style="margin:0;">开启后，该文件夹内与所有私有内网 IP / .local 地址均不抓取首屏封面，保持极简图标占位。</p>
      <div class="setting-folder-list">${folderRows}</div>
    </section>

    <section class="tidy-group">
      <h3 class="tidy-group-title">本地缩略图缓存</h3>
      <div class="tidy-list">
        ${missingPublicCount > 0 ? `
        <div class="tidy-row">
          <div class="tidy-row-main">
            <span class="tidy-row-title">还有 ${missingPublicCount} 个公网书签待补齐首屏</span>
            <span class="tidy-row-desc">全程在后台静默执行，不弹任何窗口，支持断点续传。</span>
          </div>
          <button type="button" class="text-action is-accent tidy-row-action" id="btn-silent-backfill">静默补齐</button>
        </div>
        ` : ''}
        <div class="tidy-row">
          <div class="tidy-row-main">
            <span class="tidy-row-title">${state.tidy.stats.count} 张首屏图 · 占用 ${formatBytes(state.tidy.stats.totalBytes)}</span>
            <span class="tidy-row-desc">已删除书签对应的缓存会自动清理，也可手动立即回收。</span>
          </div>
          <button type="button" class="text-action is-accent tidy-row-action" id="btn-prune-cache">清理无效缓存</button>
        </div>
        <div class="tidy-row">
          <div class="tidy-row-main">
            <span class="tidy-row-title">重置全部本地截图</span>
            <span class="tidy-row-desc">不会影响任何 Chrome 原生书签，仅清空本地图片缓存。</span>
          </div>
          <button type="button" class="text-action is-danger tidy-row-action" id="btn-clear-cache">清空缓存</button>
        </div>
      </div>
    </section>
  `;
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

// --- Card Right-Click Context Menu ---
function openCardContextMenu(bookmarkId, clientX, clientY) {
  state.contextBookmarkId = bookmarkId;
  closeMovePopover();
  els.cardContextMenu.hidden = false;
  const menuW = els.cardContextMenu.offsetWidth || 156;
  const menuH = els.cardContextMenu.offsetHeight || 48;
  const left = Math.min(window.innerWidth - menuW - 10, Math.max(10, clientX));
  const top = Math.min(window.innerHeight - menuH - 10, Math.max(10, clientY));
  els.cardContextMenu.style.left = `${left}px`;
  els.cardContextMenu.style.top = `${top}px`;
}

function closeCardContextMenu() {
  state.contextBookmarkId = null;
  if (els.cardContextMenu) els.cardContextMenu.hidden = true;
}

// --- Data Refresh Cycle ---
let reloadTimer = null;

async function refreshAllData() {
  const prevScrollY = window.scrollY;
  const [tree, thumbMeta] = await Promise.all([getBookmarkTree(), getThumbnailMetaMap()]);
  state.thumbMeta = thumbMeta;
  parseBookmarkTree(tree);
  renderSidebar();
  renderGallery();
  if (prevScrollY > 0) {
    requestAnimationFrame(() => window.scrollTo(0, prevScrollY));
  }
  if (state.tidy.open) {
    state.tidy.stats = await getStorageStats();
    renderTidyContent();
  }
}

function scheduleRefreshAllData() {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => {
    refreshAllData();
  }, 150);
}

// --- Event Listeners ---
function bindEvents() {
  // Static icons hydration
  document.querySelector('.brand-mark').innerHTML = ICONS.brand;
  if (els.onboardingMark) els.onboardingMark.innerHTML = ICONS.brand;
  els.btnCollapseSidebar.innerHTML = state.prefs.sidebarCollapsed ? ICONS.sidebarExpand : ICONS.sidebarCollapse;
  els.btnMobileMenu.innerHTML = ICONS.menu;
  els.btnCloseTidy.innerHTML = ICONS.close;
  document.getElementById('icon-rail-tidy').innerHTML = ICONS.glassTidy;
  document.getElementById('icon-topbar-search').innerHTML = ICONS.search;
  document.getElementById('icon-spotlight-search').innerHTML = ICONS.search;
  const ctxTrash = document.getElementById('icon-ctx-trash');
  if (ctxTrash) ctxTrash.innerHTML = ICONS.trash;

  // Scroll separation for sticky borderless topbar
  window.addEventListener(
    'scroll',
    () => {
      els.topbar.classList.toggle('is-scrolled', window.scrollY > 6);
      closeCardContextMenu();
    },
    { passive: true }
  );

  // Brand home
  els.brandHome.addEventListener('click', (e) => {
    e.preventDefault();
    state.selectedFolderId = 'all';
    state.activeSubfolderId = 'all';
    renderSidebar();
    renderGallery();
  });

  // Sidebar collapse toggle
  els.btnCollapseSidebar.addEventListener('click', () => {
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

  // Sidebar navigation clicks
  els.sidebarNav.addEventListener('click', (e) => {
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
    state.selectedFolderId = item.dataset.folderId;
    state.activeSubfolderId = 'all';
    renderSidebar();
    renderGallery();
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

  // Drag & Drop Bookmark Cards directly onto Sidebar Folders
  els.galleryRoot.addEventListener('dragstart', (e) => {
    const card = e.target.closest('.bookmark-card[data-bookmark-id]');
    if (!card) return;
    state.dragBookmarkId = card.dataset.bookmarkId;
    card.classList.add('is-dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', state.dragBookmarkId);
  });

  els.galleryRoot.addEventListener('dragend', () => {
    document.querySelectorAll('.bookmark-card.is-dragging').forEach((el) => el.classList.remove('is-dragging'));
    document.querySelectorAll('.nav-item.is-drop-target').forEach((el) => el.classList.remove('is-drop-target'));
    state.dragBookmarkId = null;
  });

  els.sidebarNav.addEventListener('dragover', (e) => {
    const target = e.target.closest('.nav-item[data-drop-folder-id]');
    if (!target || !state.dragBookmarkId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    document.querySelectorAll('.nav-item.is-drop-target').forEach((el) => {
      if (el !== target) el.classList.remove('is-drop-target');
    });
    target.classList.add('is-drop-target');
  });

  els.sidebarNav.addEventListener('dragleave', (e) => {
    const target = e.target.closest('.nav-item[data-drop-folder-id]');
    if (target) target.classList.remove('is-drop-target');
  });

  els.sidebarNav.addEventListener('drop', async (e) => {
    const target = e.target.closest('.nav-item[data-drop-folder-id]');
    if (!target || !state.dragBookmarkId) return;
    e.preventDefault();
    target.classList.remove('is-drop-target');
    const destFolderId = target.dataset.dropFolderId;
    const bmId = state.dragBookmarkId;
    state.dragBookmarkId = null;
    await moveBookmark(bmId, { parentId: destFolderId });
    const folderTitle = state.folderMap.get(destFolderId)?.title || '目标文件夹';
    showToast(`已移动至「${folderTitle}」并同步至 Chrome`);
    if (!IS_EXTENSION) await refreshAllData();
  });

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
      renderGallery();
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

    if (action === 'favorite') {
      await toggleFavoriteKey(bm.key, bm.title);
    } else if (action === 'copy') {
      try {
        await navigator.clipboard.writeText(bm.url);
        showToast('已复制书签链接');
      } catch {
        showToast('复制失败，请手动复制');
      }
    } else if (action === 'recapture') {
      if (!isCapturableUrl(bm.url) || isPrivateOrInternalUrl(bm.url)) {
        showToast('内网或系统地址不需要远程抓取封面');
        return;
      }
      sendBackgroundMessage({ type: 'START_BATCH_CAPTURE', items: [bm], force: true });
      showToast(`已在后台静默刷新「${bm.title}」首屏`);
    } else if (action === 'move') {
      openMovePopover(bm.id, actionBtn);
    }
  });

  // First-time onboarding prompt actions
  els.btnOnboardingStart.addEventListener('click', () => {
    const missing = getMissingCapturableBookmarks();
    closeOnboardingPrompt();
    if (missing.length > 0) {
      sendBackgroundMessage({ type: 'START_BATCH_CAPTURE', items: missing, force: false });
      showToast(`开始捕捉 ${missing.length} 项首屏，完成后将转入无感自动更新`);
    }
  });

  els.btnOnboardingSkip.addEventListener('click', () => {
    closeOnboardingPrompt();
    showToast('已开启日常浏览无感自动捕捉');
  });

  els.onboardingOverlay.addEventListener('click', (e) => {
    if (e.target === els.onboardingOverlay) closeOnboardingPrompt();
  });

  els.btnStopBatch.addEventListener('click', () => {
    sendBackgroundMessage({ type: 'STOP_BATCH_CAPTURE' });
    showToast('已停止首屏捕捉，后续浏览时将自动无感补齐');
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

  // Right-click context menu on any bookmark card
  els.galleryRoot.addEventListener('contextmenu', (e) => {
    const card = e.target.closest('.bookmark-card[data-bookmark-id]');
    if (!card) {
      closeCardContextMenu();
      return;
    }
    e.preventDefault();
    openCardContextMenu(card.dataset.bookmarkId, e.clientX, e.clientY);
  });

  els.ctxRemoveBookmark.addEventListener('click', async () => {
    const bmId = state.contextBookmarkId;
    closeCardContextMenu();
    if (!bmId) return;
    const bm = state.allBookmarks.find((b) => b.id === bmId);
    if (!bm) return;
    await removeBookmark(bm.id);
    // Clean up favorite key if no duplicate bookmark shares this key
    const remainingSameKey = state.allBookmarks.filter((b) => b.id !== bm.id && b.key === bm.key);
    if (remainingSameKey.length === 0 && isFavoriteKey(bm.key)) {
      const nextFavs = (state.prefs.favoriteKeys || []).filter((k) => k !== bm.key);
      state.prefs.favoriteKeys = nextFavs;
      await savePreferences({ favoriteKeys: nextFavs });
    }
    showToast(`已移除书签「${bm.title}」`);
    if (!IS_EXTENSION) await refreshAllData();
  });

  document.addEventListener('click', (e) => {
    if (!els.movePopover.hidden && !els.movePopover.contains(e.target) && !e.target.closest('[data-action="move"]')) {
      closeMovePopover();
    }
    if (!els.cardContextMenu.hidden && !els.cardContextMenu.contains(e.target)) {
      closeCardContextMenu();
    }
  });

  // Sidebar & Topbar Utility Actions
  els.btnTopbarSearch.addEventListener('click', () => openSpotlight(''));

  els.btnOpenTidy.addEventListener('click', () => {
    closeMobileSidebar();
    openTidyDrawer('suggestions');
  });

  systemDarkQuery.addEventListener('change', applyTheme);

  // Spotlight Search Events
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
  els.spotlightInput.addEventListener('input', (e) => {
    updateSpotlightResults(e.target.value);
  });
  els.spotlightInput.addEventListener('keydown', (e) => {
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

  // Tidy Drawer Events
  els.btnCloseTidy.addEventListener('click', closeTidyDrawer);
  els.tidyOverlay.addEventListener('click', (e) => {
    if (e.target === els.tidyOverlay) closeTidyDrawer();
  });
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
    // 1. Nest overlapping folder
    const nestBtn = e.target.closest('[data-tidy-nest]');
    if (nestBtn) {
      const childId = nestBtn.dataset.tidyNest;
      const targetParentId = nestBtn.dataset.targetParent;
      await moveBookmark(childId, { parentId: targetParentId });
      showToast('已完成文件夹收拢并同步至 Chrome');
      await refreshAllData();
      return;
    }

    // 2. Create Inbox and move loose bookmarks
    if (e.target.closest('[data-tidy-create-inbox]')) {
      const inbox = await createBookmarkFolder(state.rootBarId, '收集箱');
      if (inbox) {
        for (const bm of [...state.looseBookmarks]) {
          await moveBookmark(bm.id, { parentId: inbox.id });
        }
        showToast('已创建「收集箱」并收纳未归类书签');
        await refreshAllData();
      }
      return;
    }

    // 3. Move single suggested bookmark
    const moveBtn = e.target.closest('[data-tidy-move]');
    if (moveBtn) {
      await moveBookmark(moveBtn.dataset.tidyMove, { parentId: moveBtn.dataset.targetParent });
      showToast('已按建议归类并同步至 Chrome');
      await refreshAllData();
      return;
    }

    // 4. Unify same-domain cluster
    const unifyBtn = e.target.closest('[data-tidy-unify-domain]');
    if (unifyBtn) {
      const domain = unifyBtn.dataset.tidyUnifyDomain;
      const targetParentId = unifyBtn.dataset.targetParent;
      const cluster = state.analysis?.domainClusters.find((c) => c.domain === domain);
      if (cluster) {
        for (const bm of cluster.items) {
          if (bm.topFolderId !== targetParentId && bm.parentId !== targetParentId) {
            await moveBookmark(bm.id, { parentId: targetParentId });
          }
        }
        showToast(`已聚合 ${domain} 书签`);
        await refreshAllData();
      }
      return;
    }

    // 5. Remove duplicate bookmarks
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

    // 6. Toggle auto capture
    if (e.target.closest('#switch-auto-capture')) {
      state.prefs.autoCapture = !state.prefs.autoCapture;
      await savePreferences({ autoCapture: state.prefs.autoCapture });
      renderTidyContent();
      return;
    }

    // 7. Toggle excluded internal folder
    const exclSwitch = e.target.closest('[data-toggle-excluded]');
    if (exclSwitch) {
      const fid = exclSwitch.dataset.toggleExcluded;
      const set = new Set(state.prefs.excludedFolderIds || []);
      if (set.has(fid)) set.delete(fid);
      else set.add(fid);
      state.prefs.excludedFolderIds = Array.from(set);
      await savePreferences({ excludedFolderIds: state.prefs.excludedFolderIds });
      renderTidyContent();
      showToast('已更新跳过封面的分组配置');
      return;
    }

    // 8. Trigger quiet background backfill from Settings
    if (e.target.closest('#btn-silent-backfill')) {
      const missing = getMissingCapturableBookmarks();
      if (missing.length > 0) {
        closeTidyDrawer();
        sendBackgroundMessage({ type: 'START_BATCH_CAPTURE', items: missing, force: false });
        showToast(`已启动后台静默补齐 (${missing.length} 项)，全程不弹窗`);
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
      state.prefs.initialCapturePrompted = false;
      await savePreferences({ initialCapturePrompted: false });
      renderTidyContent();
      renderGallery();
      showToast('已清空本地首屏缓存');
    }
  });

  els.tidyContent.addEventListener('change', async (e) => {
    if (e.target.id === 'select-ttl-days') {
      state.prefs.ttlDays = Number(e.target.value);
      await savePreferences({ ttlDays: state.prefs.ttlDays });
      showToast('已更新自动保鲜周期');
    }
  });

  // Global Keyboard Shortcuts
  document.addEventListener('keydown', (e) => {
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
      else openTidyDrawer('suggestions');
      return;
    }

    if (e.key === 'Escape') {
      if (!els.onboardingOverlay.hidden) closeOnboardingPrompt();
      else if (state.spotlight.open) closeSpotlight();
      else if (state.tidy.open) closeTidyDrawer();
      else {
        closeMovePopover();
        closeCardContextMenu();
      }
      return;
    }

    if (isTyping || !els.onboardingOverlay.hidden || state.spotlight.open || state.tidy.open) return;

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
      gridResizeTimer = setTimeout(() => {
        const nextCols = getGridColumnCount();
        if (nextCols !== state.lastGridCols) {
          renderGallery();
        }
      }, 120);
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

// --- Bootstrap ---
async function init() {
  state.prefs = await loadPreferences();
  bindEvents();
  applyTheme();
  applyLayoutPreferences();

  // In HTTP preview mode outside Chrome Extension, seed realistic canvas thumbnails once
  if (!IS_EXTENSION) {
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
    } else if (msg.type === 'BATCH_PROGRESS') {
      state.batch = msg;
      renderBatchBanner();
    }
  });

  // Sync any in-flight batch capture state if user opens a second New Tab
  const batchState = await sendBackgroundMessage({ type: 'GET_BATCH_STATE' });
  if (batchState && batchState.running) {
    state.batch = batchState;
    renderBatchBanner();
  } else {
    maybeShowOnboardingPrompt();
  }
}

init();
