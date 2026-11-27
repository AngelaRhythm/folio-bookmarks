// Folio — Visual-First Single-Screen Onboarding Controller
// Communicates behavior through live UI previews rather than paragraphs of text.

import { ICONS, renderShortcutKeycapsHtml } from './icons.js';
import {
  isCapturableUrl,
  isLikelyInternalFolder,
  isPrivateOrInternalUrl,
  normalizeUrl,
  toSafePublicOrigin
} from './shared/url.js';
import {
  IS_EXTENSION,
  getBookmarkTree,
  getOpenShortcutLabel,
  loadPreferences,
  openExtensionShortcutsPage,
  savePreferences,
  sendBackgroundMessage
} from './shared/chrome-bridge.js';

const systemDarkQuery = window.matchMedia('(prefers-color-scheme: dark)');

function applyTheme() {
  document.documentElement.setAttribute('data-theme', systemDarkQuery.matches ? 'dark' : 'light');
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function getFolderIcon(title) {
  const t = (title || '').toLowerCase();
  if (t.includes('公司') || t.includes('工作') || t.includes('work') || t.includes('company')) return ICONS.glassWork;
  if (t.includes('论坛') || t.includes('博客') || t.includes('阅读') || t.includes('blog') || t.includes('forum')) return ICONS.glassForum;
  if (t.includes('视觉') || t.includes('灵感') || t.includes('设计') || t.includes('design') || t.includes('ui')) return ICONS.glassVisual;
  if (t.includes('个站') || t.includes('作品') || t.includes('site') || t.includes('web')) return ICONS.glassGlobe;
  if (t.includes('工具') || t.includes('效率') || t.includes('tool')) return ICONS.glassTools;
  if (t.includes('code') || t.includes('开发') || t.includes('前端') || t.includes('dev')) return ICONS.glassCode;
  if (t.includes('规范') || t.includes('文档') || t.includes('spec') || t.includes('doc')) return ICONS.glassSpec;
  if (t.includes('ai') || t.includes('大模型') || t.includes('智能')) return ICONS.glassAi;
  return ICONS.glassFolder;
}

const state = {
  shortcutLabel: '⌥⇧F',
  topFolders: [],
  allBookmarks: [],
  prefs: {
    launchOnNewTab: true,
    launchOnAction: true,
    launchOnStartup: false,
    launchOnShortcut: false,
    remoteCoverEnabled: false,
    excludedFolderIds: []
  }
};

const els = {
  brandMark: document.getElementById('welcome-brand-mark'),
  syncText: document.getElementById('welcome-sync-text'),
  btnSkip: document.getElementById('btn-welcome-skip'),
  mockStartup: document.getElementById('mock-startup'),
  mockNewtab: document.getElementById('mock-newtab'),
  mockShortcut: document.getElementById('mock-shortcut'),
  mockAction: document.getElementById('mock-action'),
  launchList: document.getElementById('welcome-launch-list'),
  coverHint: document.getElementById('welcome-cover-hint'),
  modeLocal: document.getElementById('mode-card-local'),
  modeRemote: document.getElementById('mode-card-remote'),
  modeRemoteSub: document.getElementById('mode-remote-sub'),
  folderChips: document.getElementById('welcome-folder-chips'),
  btnFinish: document.getElementById('btn-welcome-finish'),
  ctaLabel: document.getElementById('welcome-cta-label'),
  ctaArrow: document.getElementById('welcome-cta-arrow'),
  toast: document.getElementById('toast')
};

let toastTimer = null;
function showToast(text) {
  els.toast.textContent = text;
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    els.toast.hidden = true;
  }, 2400);
}

function parseTree(tree) {
  const topFolders = [];
  const allBookmarks = [];
  const root = tree?.[0];
  const containers = root?.children || [];

  function walkFolder(node, topFolderId, ancestorIds) {
    const nextAncestors = [...ancestorIds, node.id];
    let count = 0;
    for (const child of node.children || []) {
      if (child.url) {
        count += 1;
        allBookmarks.push({
          id: child.id,
          url: child.url,
          title: child.title || child.url,
          key: normalizeUrl(child.url),
          topFolderId,
          ancestorFolderIds: nextAncestors
        });
      } else if (child.children) {
        count += walkFolder(child, topFolderId, nextAncestors);
      }
    }
    return count;
  }

  for (const container of containers) {
    for (const child of container.children || []) {
      if (child.url) {
        allBookmarks.push({
          id: child.id,
          url: child.url,
          title: child.title || child.url,
          key: normalizeUrl(child.url),
          topFolderId: 'loose',
          ancestorFolderIds: [container.id]
        });
      } else if (child.children) {
        const count = walkFolder(child, child.id, []);
        topFolders.push({
          id: child.id,
          title: child.title || '未命名文件夹',
          count
        });
      }
    }
  }

  state.topFolders = topFolders;
  state.allBookmarks = allBookmarks;
}

function getEligiblePublicBookmarks() {
  const excludedSet = new Set(state.prefs.excludedFolderIds || []);
  const seen = new Set();
  const list = [];
  for (const bm of state.allBookmarks) {
    if (!bm.url || seen.has(bm.key)) continue;
    const inExcluded = (bm.ancestorFolderIds || []).some((id) => excludedSet.has(id));
    if (inExcluded || !isCapturableUrl(bm.url) || isPrivateOrInternalUrl(bm.url)) continue;
    if (!toSafePublicOrigin(bm.url)) continue;
    seen.add(bm.key);
    list.push(bm);
  }
  return list;
}

function renderLaunchList() {
  const isMac = /mac/i.test(navigator.platform || navigator.userAgent || '');
  const newTabKey = isMac ? '⌘T' : 'Ctrl+T';
  const items = [
    { key: 'launchOnNewTab', title: '新标签页', kbd: newTabKey },
    { key: 'launchOnAction', title: '工具栏图标' },
    { key: 'launchOnStartup', title: '浏览器首页' },
    { key: 'launchOnShortcut', title: '全局快捷键', kbd: state.shortcutLabel, editable: true }
  ];

  const activeCount = items.filter((it) => Boolean(state.prefs[it.key])).length;

  els.launchList.innerHTML = items
    .map((it) => {
      const checked = Boolean(state.prefs[it.key]);
      const locked = checked && activeCount <= 1;
      const kbdHtml = it.kbd ? renderShortcutKeycapsHtml(it.kbd) : '';
      const editHtml = it.editable ? `<button type="button" class="setting-inline-link" id="btn-welcome-shortcut">改键</button>` : '';
      return `
        <div class="welcome-switch-row">
          <span class="setting-title-inline">
            <span class="welcome-switch-title">${it.title}</span>
            ${kbdHtml}
            ${editHtml}
          </span>
          <button type="button" class="setting-switch${locked ? ' is-locked' : ''}" role="switch" aria-checked="${checked ? 'true' : 'false'}" aria-disabled="${locked ? 'true' : 'false'}" data-welcome-launch="${it.key}" aria-label="${it.title}"></button>
        </div>
      `;
    })
    .join('');

  // Sync live mini Chrome preview lights
  els.mockNewtab.classList.toggle('is-on', Boolean(state.prefs.launchOnNewTab));
  els.mockAction.classList.toggle('is-on', Boolean(state.prefs.launchOnAction));
  els.mockStartup.classList.toggle('is-on', Boolean(state.prefs.launchOnStartup));
  els.mockShortcut.classList.toggle('is-on', Boolean(state.prefs.launchOnShortcut));
  els.mockShortcut.innerHTML = renderShortcutKeycapsHtml(state.shortcutLabel, 'is-mini');
}

function renderCoverAndFolders() {
  const isRemote = Boolean(state.prefs.remoteCoverEnabled);
  els.modeLocal.classList.toggle('is-selected', !isRemote);
  els.modeLocal.setAttribute('aria-checked', !isRemote ? 'true' : 'false');
  els.modeRemote.classList.toggle('is-selected', isRemote);
  els.modeRemote.setAttribute('aria-checked', isRemote ? 'true' : 'false');

  const eligible = getEligiblePublicBookmarks();
  els.coverHint.textContent = isRemote ? '仅发根域名 · 无路径参数' : '纯本地 · 零外发';
  els.modeRemoteSub.textContent =
    eligible.length > 0 ? `立即补齐 ${eligible.length} 个公网站点` : '仅按根域名补齐';

  const excludedSet = new Set(state.prefs.excludedFolderIds || []);
  if (state.topFolders.length === 0) {
    els.folderChips.innerHTML = `<span class="welcome-exclude-note">暂无书签文件夹</span>`;
  } else {
    els.folderChips.innerHTML = state.topFolders
      .map((f) => {
        const excluded = excludedSet.has(f.id);
        return `
          <button type="button" class="welcome-folder-chip${excluded ? ' is-excluded' : ''}" data-toggle-exclude="${escapeHtml(f.id)}" aria-pressed="${excluded ? 'true' : 'false'}" title="${excluded ? `已跳过「${escapeHtml(f.title)}」` : `点击跳过「${escapeHtml(f.title)}」`}">
            <span class="welcome-folder-chip-icon" aria-hidden="true">${getFolderIcon(f.title)}</span>
            <span>${escapeHtml(f.title)}</span>
            ${excluded ? `<span class="welcome-folder-chip-eye" aria-hidden="true">${ICONS.eyeOff}</span>` : ''}
          </button>
        `;
      })
      .join('');
  }

  // Primary CTA label communicates exact next action concisely
  els.ctaLabel.textContent =
    isRemote && eligible.length > 0 ? `开启 Folio 并补齐 ${eligible.length} 个封面` : '开启 Folio';
}

function renderAll() {
  renderLaunchList();
  renderCoverAndFolders();
}

async function finishOnboarding(useDefaults = false) {
  const autoExcluded = state.topFolders
    .filter((f) => isLikelyInternalFolder(f.title))
    .map((f) => f.id);

  const patch = useDefaults
    ? {
        launchOnNewTab: true,
        launchOnAction: true,
        launchOnStartup: false,
        launchOnShortcut: false,
        remoteCoverEnabled: false,
        excludedFolderIds: autoExcluded,
        initialCapturePrompted: true,
        bannerHintDismissed: false
      }
    : {
        launchOnNewTab: Boolean(state.prefs.launchOnNewTab),
        launchOnAction: Boolean(state.prefs.launchOnAction),
        launchOnStartup: Boolean(state.prefs.launchOnStartup),
        launchOnShortcut: Boolean(state.prefs.launchOnShortcut),
        remoteCoverEnabled: Boolean(state.prefs.remoteCoverEnabled),
        excludedFolderIds: Array.from(new Set(state.prefs.excludedFolderIds || [])),
        initialCapturePrompted: true,
        bannerHintDismissed: false
      };

  await savePreferences(patch);

  let startRemoteBackfill = false;
  if (patch.remoteCoverEnabled) {
    const eligible = getEligiblePublicBookmarks();
    if (eligible.length > 0) {
      startRemoteBackfill = true;
      if (IS_EXTENSION) {
        await sendBackgroundMessage({ type: 'START_BATCH_CAPTURE', items: eligible, force: false });
      }
    }
  }

  const nextUrl = startRemoteBackfill && !IS_EXTENSION ? 'newtab.html?source=install&autobackfill=1' : 'newtab.html?source=install';
  window.location.replace(nextUrl);
}

function bindEvents() {
  els.brandMark.innerHTML = ICONS.brand;
  els.ctaArrow.innerHTML = ICONS.arrowRight;

  els.launchList.addEventListener('click', async (e) => {
    if (e.target.closest('#btn-welcome-shortcut')) {
      const opened = await openExtensionShortcutsPage();
      if (!opened) {
        showToast('请在 Chrome 中打开 chrome://extensions/shortcuts 修改');
      }
      return;
    }

    const sw = e.target.closest('[data-welcome-launch]');
    if (!sw) return;
    const key = sw.dataset.welcomeLaunch;
    const launchKeys = ['launchOnNewTab', 'launchOnAction', 'launchOnStartup', 'launchOnShortcut'];
    if (!launchKeys.includes(key)) return;

    const currentVal = Boolean(state.prefs[key]);
    const activeCount = launchKeys.filter((k) => Boolean(state.prefs[k])).length;
    if (currentVal && activeCount <= 1) {
      showToast('至少保留一种打开方式');
      return;
    }

    state.prefs[key] = !currentVal;
    renderAll();
  });

  els.modeLocal.addEventListener('click', () => {
    state.prefs.remoteCoverEnabled = false;
    renderAll();
  });

  els.modeRemote.addEventListener('click', () => {
    state.prefs.remoteCoverEnabled = true;
    renderAll();
  });

  els.folderChips.addEventListener('click', (e) => {
    const chip = e.target.closest('[data-toggle-exclude]');
    if (!chip) return;
    const fid = chip.dataset.toggleExclude;
    const set = new Set(state.prefs.excludedFolderIds || []);
    if (set.has(fid)) set.delete(fid);
    else set.add(fid);
    state.prefs.excludedFolderIds = Array.from(set);
    renderAll();
  });

  els.btnSkip.addEventListener('click', () => finishOnboarding(true));
  els.btnFinish.addEventListener('click', () => finishOnboarding(false));

  systemDarkQuery.addEventListener('change', applyTheme);
}

async function init() {
  applyTheme();
  bindEvents();

  const [prefs, tree, shortcutLabel] = await Promise.all([
    loadPreferences(),
    getBookmarkTree(),
    getOpenShortcutLabel()
  ]);

  parseTree(tree);
  state.shortcutLabel = shortcutLabel;

  const defaultExcluded = Array.isArray(prefs.excludedFolderIds)
    ? prefs.excludedFolderIds
    : state.topFolders.filter((f) => isLikelyInternalFolder(f.title)).map((f) => f.id);

  state.prefs = {
    launchOnNewTab: prefs.launchOnNewTab !== false,
    launchOnAction: prefs.launchOnAction !== false,
    launchOnStartup: prefs.launchOnStartup === true,
    launchOnShortcut: prefs.launchOnShortcut === true,
    remoteCoverEnabled: prefs.remoteCoverEnabled === true,
    excludedFolderIds: defaultExcluded
  };

  els.syncText.textContent =
    state.allBookmarks.length > 0
      ? `${state.topFolders.length} 个文件夹 · ${state.allBookmarks.length} 条书签`
      : '已连接本地书签';

  renderAll();
}

init();
