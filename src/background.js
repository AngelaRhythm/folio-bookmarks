// Manifest V3 Background Service Worker — Silent Self-Updating First-Screen Engine
//
// 3-Layer Strategy:
// 1. Silent Background Cover Fetch (Public non-internal bookmarks only, zero popups):
//    WordPress mShots true first-screen -> automatic fallback to page og:image / twitter:image.
//    Internal/private hosts and user-excluded folders (auto-detected: 公司/工作/内网...) are skipped.
// 2. Redirect-Aware Passive True-Screenshot Upgrade:
//    Tracks bookmark open intents and navigation redirects so visiting a bookmarked site
//    upgrades its thumbnail to your real rendered viewport screenshot (source: 'capture').
// 3. Persistent Queue + Weekly/Monthly chrome.alarms Auto-Refresh:
//    Survives MV3 Service Worker sleep cleanly and refreshes stale public previews on a
//    gentle weekly (7d) or monthly (30d) cadence — zero minute-level polling.

import {
  isCapturableUrl,
  isLikelyInternalFolder,
  isPrivateOrInternalUrl,
  normalizeUrl
} from './shared/url.js';
import { getThumbnail, pruneOrphanThumbnails, saveThumbnail } from './shared/db.js';

const DEFAULT_REFRESH_DAYS = 30; // Monthly by default
const PASSIVE_SETTLE_MS = 1800;
const MSHOTS_RETRY_WAIT_MS = 4500;
const FETCH_TIMEOUT_MS = 12000;
const SILENT_CONCURRENCY = 3;
const TARGET_WIDTH = 640;
const TARGET_HEIGHT = 400; // 16:10

const ALARM_PERIODIC_REFRESH = 'folio_periodic_refresh';
const ALARM_QUEUE_RESUME = 'folio_queue_resume';
const QUEUE_STORAGE_KEY = 'folio_silent_queue_v1';

// In-memory fast bookmark lookup
let bookmarkedMeta = new Map(); // normalizedUrl -> { url, title, excluded }
let indexReady = false;
let indexRebuildTimer = null;

// Redirect & open-intent tracking
const pendingTabTimers = new Map(); // tabId -> timeoutId
const tabOriginKeyMap = new Map();  // tabId -> original bookmark key (survives redirects)
let recentOpenIntent = null;        // { key, url, ts }

// Live silent batch state
const batchState = {
  running: false,
  cancelled: false,
  current: 0,
  total: 0,
  captured: 0,
  failed: 0,
  currentTitle: ''
};

async function getSettings() {
  try {
    const res = await chrome.storage.local.get([
      'ttlDays',
      'autoCapture',
      'excludedFolderIds'
    ]);
    return {
      ttlDays: typeof res.ttlDays === 'number' ? res.ttlDays : DEFAULT_REFRESH_DAYS,
      autoCapture: res.autoCapture !== false,
      excludedFolderIds: Array.isArray(res.excludedFolderIds) ? res.excludedFolderIds : null
    };
  } catch {
    return { ttlDays: DEFAULT_REFRESH_DAYS, autoCapture: true, excludedFolderIds: null };
  }
}

function collectBookmarkEntries(tree, excludedSet) {
  const map = new Map();
  const autoDetectedExcluded = [];
  const root = tree?.[0];
  const containers = root?.children || [];

  function walk(nodes, topFolderId, isExcludedFolder) {
    for (const node of nodes) {
      if (node.url) {
        if (!isCapturableUrl(node.url)) continue;
        const key = normalizeUrl(node.url);
        const excluded = isExcludedFolder || isPrivateOrInternalUrl(node.url);
        const existing = map.get(key);
        // If same URL exists in both excluded and non-excluded folders, keep excluded=true for safety
        map.set(key, {
          key,
          url: node.url,
          title: node.title || node.url,
          excluded: existing ? existing.excluded || excluded : excluded
        });
      } else if (node.children) {
        const nextTopId = topFolderId || node.id;
        const folderExcluded =
          isExcludedFolder ||
          (excludedSet ? excludedSet.has(node.id) || excludedSet.has(nextTopId) : isLikelyInternalFolder(node.title));
        if (!topFolderId && isLikelyInternalFolder(node.title)) {
          autoDetectedExcluded.push(node.id);
        }
        walk(node.children, nextTopId, folderExcluded);
      }
    }
  }

  for (const container of containers) {
    walk(container.children || [], null, false);
  }

  return { map, autoDetectedExcluded };
}

async function rebuildBookmarkIndex(pruneOrphans = false) {
  try {
    const [tree, settings] = await Promise.all([
      chrome.bookmarks.getTree(),
      getSettings()
    ]);

    const excludedSet = settings.excludedFolderIds ? new Set(settings.excludedFolderIds) : null;
    const { map, autoDetectedExcluded } = collectBookmarkEntries(tree, excludedSet);

    if (settings.excludedFolderIds === null && autoDetectedExcluded.length > 0) {
      await chrome.storage.local.set({ excludedFolderIds: autoDetectedExcluded });
    }

    bookmarkedMeta = map;
    indexReady = true;

    if (pruneOrphans) {
      await pruneOrphanThumbnails(new Set(map.keys()));
    }
  } catch (err) {
    console.warn('[Folio] Failed to build bookmark index:', err);
  }
}

function scheduleIndexRebuild(pruneOrphans = false) {
  clearTimeout(indexRebuildTimer);
  indexRebuildTimer = setTimeout(() => {
    rebuildBookmarkIndex(pruneOrphans);
  }, 350);
}

async function ensureIndexReady() {
  if (!indexReady) {
    await rebuildBookmarkIndex(false);
  }
}

function broadcast(message) {
  chrome.runtime.sendMessage(message).catch(() => {
    // No extension page currently listening
  });
}

function broadcastBatchProgress() {
  broadcast({
    type: 'BATCH_PROGRESS',
    running: batchState.running,
    current: batchState.current,
    total: batchState.total,
    captured: batchState.captured,
    failed: batchState.failed,
    currentTitle: batchState.currentTitle
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function compressBlobToWebP(rawBlob, anchorTop = true) {
  const bitmap = await createImageBitmap(rawBlob);
  const srcRatio = bitmap.width / bitmap.height;
  const dstRatio = TARGET_WIDTH / TARGET_HEIGHT;
  let sx = 0;
  let sy = 0;
  let sw = bitmap.width;
  let sh = bitmap.height;

  if (srcRatio > dstRatio) {
    sw = bitmap.height * dstRatio;
    sx = (bitmap.width - sw) / 2;
  } else {
    sh = bitmap.width / dstRatio;
    sy = anchorTop ? 0 : (bitmap.height - sh) / 2;
  }

  const canvas = new OffscreenCanvas(TARGET_WIDTH, TARGET_HEIGHT);
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, TARGET_WIDTH, TARGET_HEIGHT);
  bitmap.close();

  return canvas.convertToBlob({ type: 'image/webp', quality: 0.8 });
}

// --- Layer 1: Silent Background Cover Fetch (mShots -> OG Image Fallback) ---

function isRealMshotsResponse(res, blob) {
  if (!res.ok || !blob || blob.size < 6500) return false;
  const ct = (res.headers.get('content-type') || '').toLowerCase();
  // WordPress mShots serves an animated GIF while generating a cold screenshot
  if (!ct.startsWith('image/') || ct.includes('gif') || ct.includes('svg')) return false;
  const finalUrl = (res.url || '').toLowerCase();
  if (finalUrl.includes('default') || finalUrl.includes('loading')) return false;
  return true;
}

async function fetchMshotsBlob(url) {
  const endpoint = `https://s.wordpress.com/mshots/v1/${encodeURIComponent(url)}?w=1280&h=800`;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(endpoint, {
        redirect: 'follow',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
      });
      const blob = await res.blob();
      if (isRealMshotsResponse(res, blob)) {
        return blob;
      }
      // First call often triggers generation on mShots; wait briefly then try once more
      if (attempt === 0) {
        await sleep(MSHOTS_RETRY_WAIT_MS);
      }
    } catch {
      return null;
    }
  }
  return null;
}

function extractMetaImageUrl(html, baseUrl) {
  const patterns = [
    /<meta[^>]+(?:property|name)=["'](?:og:image|og:image:secure_url|twitter:image|twitter:image:src)["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["'](?:og:image|og:image:secure_url|twitter:image|twitter:image:src)["']/i,
    /<link[^>]+rel=["']image_src["'][^>]+href=["']([^"']+)["']/i
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m && m[1]) {
      const raw = m[1].trim().replace(/&amp;/g, '&');
      if (!raw || raw.startsWith('data:')) continue;
      try {
        return new URL(raw, baseUrl).toString();
      } catch {
        continue;
      }
    }
  }
  return null;
}

async function fetchOgImageBlob(url) {
  try {
    const pageRes = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(9000),
      headers: { Accept: 'text/html,application/xhtml+xml' }
    });
    if (!pageRes.ok) return null;
    const ct = (pageRes.headers.get('content-type') || '').toLowerCase();
    if (!ct.includes('text/html') && !ct.includes('xhtml')) return null;

    // Read only head slice when possible for speed
    const reader = pageRes.body?.getReader();
    let html = '';
    if (reader) {
      const decoder = new TextDecoder();
      let bytes = 0;
      while (bytes < 90000) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        html += decoder.decode(value, { stream: true });
        if (html.includes('</head>')) break;
      }
      reader.cancel().catch(() => {});
    } else {
      html = (await pageRes.text()).slice(0, 90000);
    }

    const imgUrl = extractMetaImageUrl(html, pageRes.url || url);
    if (!imgUrl || isPrivateOrInternalUrl(imgUrl)) return null;

    const imgRes = await fetch(imgUrl, {
      redirect: 'follow',
      signal: AbortSignal.timeout(9000)
    });
    if (!imgRes.ok) return null;
    const imgCt = (imgRes.headers.get('content-type') || '').toLowerCase();
    if (!imgCt.startsWith('image/') || imgCt.includes('svg')) return null;

    const blob = await imgRes.blob();
    if (!blob || blob.size < 2500) return null;
    return blob;
  } catch {
    return null;
  }
}

async function fetchSilentCoverForItem(item) {
  if (!item || !item.url || isPrivateOrInternalUrl(item.url)) return false;

  // 1) Try true first-screen screenshot via WordPress mShots
  const mshotsBlob = await fetchMshotsBlob(item.url);
  if (mshotsBlob) {
    try {
      const webp = await compressBlobToWebP(mshotsBlob, true);
      const saved = await saveThumbnail(item.key, webp, {
        status: 'ok',
        source: 'mshots',
        width: TARGET_WIDTH,
        height: TARGET_HEIGHT
      });
      broadcast({
        type: 'SCREENSHOT_UPDATED',
        key: item.key,
        capturedAt: saved.capturedAt,
        size: saved.size,
        source: 'mshots'
      });
      return true;
    } catch {
      // Fall through to OG image
    }
  }

  // 2) Fallback: parse og:image / twitter:image cover
  const ogBlob = await fetchOgImageBlob(item.url);
  if (ogBlob) {
    try {
      const webp = await compressBlobToWebP(ogBlob, false);
      const saved = await saveThumbnail(item.key, webp, {
        status: 'ok',
        source: 'og',
        width: TARGET_WIDTH,
        height: TARGET_HEIGHT
      });
      broadcast({
        type: 'SCREENSHOT_UPDATED',
        key: item.key,
        capturedAt: saved.capturedAt,
        size: saved.size,
        source: 'og'
      });
      return true;
    } catch {
      return false;
    }
  }

  return false;
}

// --- Persistent Silent Queue (Survives MV3 Service Worker Sleep) ---

async function loadPersistedQueue() {
  const res = await chrome.storage.local.get(QUEUE_STORAGE_KEY);
  return Array.isArray(res[QUEUE_STORAGE_KEY]) ? res[QUEUE_STORAGE_KEY] : [];
}

async function savePersistedQueue(items) {
  if (!items || items.length === 0) {
    await chrome.storage.local.remove(QUEUE_STORAGE_KEY);
    await chrome.alarms.clear(ALARM_QUEUE_RESUME);
  } else {
    await chrome.storage.local.set({ [QUEUE_STORAGE_KEY]: items });
  }
}

async function enqueueSilentCapture(items, force = false) {
  await ensureIndexReady();
  const existingQueue = await loadPersistedQueue();
  const byKey = new Map(existingQueue.map((q) => [q.key, q]));

  for (const raw of items) {
    if (!raw || !raw.url) continue;
    const key = raw.key || normalizeUrl(raw.url);
    const meta = bookmarkedMeta.get(key);
    if (isPrivateOrInternalUrl(raw.url) || (!force && meta?.excluded)) continue;
    byKey.set(key, {
      key,
      url: raw.url,
      title: raw.title || meta?.title || raw.url,
      force: Boolean(force)
    });
  }

  const merged = Array.from(byKey.values());
  await savePersistedQueue(merged);
  if (merged.length > 0 && !batchState.running) {
    processSilentQueue();
  }
}

async function shouldSilentFetchKey(key, force = false) {
  if (force) return true;
  const existing = await getThumbnail(key);
  if (!existing || existing.status !== 'ok' || !existing.blob) return true;
  const { ttlDays } = await getSettings();
  if (ttlDays <= 0) return false;
  const ageMs = Date.now() - (existing.capturedAt || 0);
  // Never downgrade a fresh real viewport capture with a remote cover
  if (existing.source === 'capture' && ageMs <= ttlDays * 24 * 60 * 60 * 1000) {
    return false;
  }
  return ageMs > ttlDays * 24 * 60 * 60 * 1000;
}

async function processSilentQueue() {
  if (batchState.running) return;
  const queue = await loadPersistedQueue();
  if (queue.length === 0) return;

  batchState.running = true;
  batchState.cancelled = false;
  batchState.current = 0;
  batchState.total = queue.length;
  batchState.captured = 0;
  batchState.failed = 0;
  batchState.currentTitle = queue[0]?.title || '';
  broadcastBatchProgress();

  // Safety resume alarm in case MV3 suspends the worker mid-batch (cleared when done)
  await chrome.alarms.create(ALARM_QUEUE_RESUME, { delayInMinutes: 2 });

  const remaining = [...queue];
  let cursor = 0;

  async function worker() {
    while (cursor < queue.length && !batchState.cancelled) {
      const idx = cursor++;
      const item = queue[idx];
      batchState.currentTitle = item.title;
      broadcastBatchProgress();

      let ok = false;
      try {
        if (await shouldSilentFetchKey(item.key, item.force)) {
          ok = await fetchSilentCoverForItem(item);
        } else {
          ok = true;
        }
      } catch {
        ok = false;
      }

      batchState.current += 1;
      if (ok) batchState.captured += 1;
      else batchState.failed += 1;

      const remIdx = remaining.findIndex((r) => r.key === item.key);
      if (remIdx >= 0) remaining.splice(remIdx, 1);
      await savePersistedQueue(remaining);
      broadcastBatchProgress();
    }
  }

  try {
    const runners = [];
    for (let i = 0; i < Math.min(SILENT_CONCURRENCY, queue.length); i++) {
      runners.push(worker());
    }
    await Promise.all(runners);
  } finally {
    if (batchState.cancelled) {
      await savePersistedQueue([]);
    }
    if ((await loadPersistedQueue()).length === 0) {
      await chrome.alarms.clear(ALARM_QUEUE_RESUME);
    }
    batchState.running = false;
    batchState.currentTitle = '';
    broadcastBatchProgress();
  }
}

// --- Layer 2: Redirect-Aware Passive True-Screenshot Upgrade ---

async function shouldPassiveCaptureKey(key) {
  const existing = await getThumbnail(key);
  if (!existing || existing.status !== 'ok' || !existing.blob) return true;
  // Always upgrade remote cover ('mshots' / 'og') to a real viewport capture once visited
  if (existing.source && existing.source !== 'capture') return true;
  const { ttlDays } = await getSettings();
  if (ttlDays <= 0) return false;
  return Date.now() - (existing.capturedAt || 0) > ttlDays * 24 * 60 * 60 * 1000;
}

async function captureActiveTab(tabId, targetKey) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab || !tab.active || !tab.url || !isCapturableUrl(tab.url)) return false;

    // Verify tab still corresponds to the intended bookmark (either direct URL or tracked redirect)
    const currentKey = normalizeUrl(tab.url);
    const trackedKey = tabOriginKeyMap.get(tabId);
    if (currentKey !== targetKey && trackedKey !== targetKey) return false;

    const win = await chrome.windows.get(tab.windowId);
    if (!win || win.state === 'minimized') return false;

    if (!(await shouldPassiveCaptureKey(targetKey))) return false;

    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
      format: 'jpeg',
      quality: 88
    });
    const res = await fetch(dataUrl);
    const webpBlob = await compressBlobToWebP(await res.blob(), true);

    const saved = await saveThumbnail(targetKey, webpBlob, {
      status: 'ok',
      source: 'capture',
      width: TARGET_WIDTH,
      height: TARGET_HEIGHT
    });

    broadcast({
      type: 'SCREENSHOT_UPDATED',
      key: targetKey,
      capturedAt: saved.capturedAt,
      size: saved.size,
      source: 'capture'
    });
    return true;
  } catch (err) {
    console.debug('[Folio] Passive capture skipped:', err?.message || err);
    return false;
  }
}

async function schedulePassiveCapture(tabId, url) {
  if (!url || !isCapturableUrl(url)) return;

  const { autoCapture } = await getSettings();
  if (!autoCapture) return;

  await ensureIndexReady();
  const currentKey = normalizeUrl(url);
  const trackedKey = tabOriginKeyMap.get(tabId);
  const targetKey = bookmarkedMeta.has(currentKey)
    ? currentKey
    : trackedKey && bookmarkedMeta.has(trackedKey)
      ? trackedKey
      : null;

  if (!targetKey) return;

  const meta = bookmarkedMeta.get(targetKey);
  // Respect "internal / company sites don't need cover"
  if (meta?.excluded) return;

  if (!(await shouldPassiveCaptureKey(targetKey))) return;

  if (pendingTabTimers.has(tabId)) {
    clearTimeout(pendingTabTimers.get(tabId));
  }

  const timer = setTimeout(async () => {
    pendingTabTimers.delete(tabId);
    await captureActiveTab(tabId, targetKey);
  }, PASSIVE_SETTLE_MS);

  pendingTabTimers.set(tabId, timer);
}

// Track newly created tabs from Folio clicks (preserves original bookmark key across redirects)
chrome.tabs.onCreated.addListener((tab) => {
  if (recentOpenIntent && Date.now() - recentOpenIntent.ts < 15000 && tab.id) {
    tabOriginKeyMap.set(tab.id, recentOpenIntent.key);
    recentOpenIntent = null;
  }
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.url && isCapturableUrl(changeInfo.url)) {
    await ensureIndexReady();
    const navKey = normalizeUrl(changeInfo.url);
    if (bookmarkedMeta.has(navKey)) {
      tabOriginKeyMap.set(tabId, navKey);
    }
  }
  if (changeInfo.status === 'complete' && tab.active && tab.url) {
    schedulePassiveCapture(tabId, tab.url);
  }
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab && tab.status === 'complete' && tab.url) {
      schedulePassiveCapture(tabId, tab.url);
    }
  } catch {
    // Ignore transient tab close
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabOriginKeyMap.delete(tabId);
  if (pendingTabTimers.has(tabId)) {
    clearTimeout(pendingTabTimers.get(tabId));
    pendingTabTimers.delete(tabId);
  }
});

// --- Layer 3: Weekly / Monthly Long-Interval Periodic Auto-Refresh ---

async function syncPeriodicAlarm() {
  const { ttlDays, autoCapture } = await getSettings();
  await chrome.alarms.clear(ALARM_PERIODIC_REFRESH);
  if (!autoCapture || ttlDays <= 0) return;

  // Long cadence: weekly (7d) or monthly (30d) or quarterly (90d) — zero minute-level polling
  const periodInMinutes = Math.max(7 * 24 * 60, ttlDays * 24 * 60);
  await chrome.alarms.create(ALARM_PERIODIC_REFRESH, {
    delayInMinutes: periodInMinutes,
    periodInMinutes
  });
}

async function runPeriodicRefreshScan() {
  const { autoCapture, ttlDays } = await getSettings();
  if (!autoCapture || ttlDays <= 0) return;

  await rebuildBookmarkIndex(true);
  const staleItems = [];
  for (const meta of bookmarkedMeta.values()) {
    if (meta.excluded) continue;
    if (await shouldSilentFetchKey(meta.key, false)) {
      staleItems.push(meta);
    }
  }

  if (staleItems.length > 0) {
    await enqueueSilentCapture(staleItems, false);
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_QUEUE_RESUME) {
    processSilentQueue();
  } else if (alarm.name === ALARM_PERIODIC_REFRESH) {
    runPeriodicRefreshScan();
  }
});

// Bookmark event listeners: auto-fetch newly created public bookmarks silently
chrome.bookmarks.onCreated.addListener(async (_id, node) => {
  scheduleIndexRebuild(false);
  if (node && node.url && isCapturableUrl(node.url) && !isPrivateOrInternalUrl(node.url)) {
    const { autoCapture } = await getSettings();
    if (!autoCapture) return;
    setTimeout(async () => {
      await rebuildBookmarkIndex(false);
      const key = normalizeUrl(node.url);
      const meta = bookmarkedMeta.get(key);
      if (meta && !meta.excluded) {
        enqueueSilentCapture([meta], false);
      }
    }, 1500);
  }
});

chrome.bookmarks.onChanged.addListener(() => scheduleIndexRebuild(false));
chrome.bookmarks.onMoved.addListener(() => scheduleIndexRebuild(false));
chrome.bookmarks.onRemoved.addListener(() => scheduleIndexRebuild(true));
chrome.bookmarks.onImportEnded.addListener(() => scheduleIndexRebuild(false));

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.excludedFolderIds) {
    rebuildBookmarkIndex(false);
  }
  if (changes.ttlDays || changes.autoCapture) {
    syncPeriodicAlarm();
  }
});

// --- Message API for New Tab Gallery ---

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || !message.type) return;

  if (message.type === 'REGISTER_OPEN_INTENT' && message.key) {
    recentOpenIntent = { key: message.key, url: message.url || '', ts: Date.now() };
    sendResponse({ ok: true });
    return;
  }

  if (message.type === 'START_BATCH_CAPTURE') {
    enqueueSilentCapture(message.items || [], Boolean(message.force));
    sendResponse({ ok: true });
    return;
  }

  if (message.type === 'STOP_BATCH_CAPTURE') {
    batchState.cancelled = true;
    savePersistedQueue([]);
    sendResponse({ ok: true });
    return;
  }

  if (message.type === 'GET_BATCH_STATE') {
    sendResponse({
      running: batchState.running,
      current: batchState.current,
      total: batchState.total,
      captured: batchState.captured,
      failed: batchState.failed,
      currentTitle: batchState.currentTitle
    });
    return;
  }

  if (message.type === 'PRUNE_CACHE') {
    (async () => {
      await rebuildBookmarkIndex(false);
      const removed = await pruneOrphanThumbnails(new Set(bookmarkedMeta.keys()));
      sendResponse({ ok: true, removed });
    })();
    return true;
  }
});

// Initialize on install / startup / wake
chrome.runtime.onInstalled.addListener(async () => {
  await rebuildBookmarkIndex(false);
  await syncPeriodicAlarm();
});

chrome.runtime.onStartup.addListener(async () => {
  await rebuildBookmarkIndex(true);
  await syncPeriodicAlarm();
  processSilentQueue();
});

rebuildBookmarkIndex(false).then(() => {
  syncPeriodicAlarm();
  processSilentQueue();
});
