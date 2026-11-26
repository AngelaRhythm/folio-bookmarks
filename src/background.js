// Manifest V3 Background Service Worker
// Handles:
// 1. Indexing bookmarked URLs in memory for O(1) lookup on tab visits
// 2. Passive silent first-screen capture when visiting bookmarked pages
// 3. OffscreenCanvas top-anchored 16:10 crop + WebP compression -> IndexedDB
// 4. Controlled batch capture queue (single dedicated window, cancellable)
// 5. Automatic orphan thumbnail pruning when bookmarks are removed

import { isCapturableUrl, normalizeUrl } from './shared/url.js';
import { getThumbnail, pruneOrphanThumbnails, saveThumbnail } from './shared/db.js';

const DEFAULT_TTL_DAYS = 30;
const PASSIVE_SETTLE_MS = 1800;
const BATCH_SETTLE_MS = 2200;
const BATCH_LOAD_TIMEOUT_MS = 11000;
const TARGET_WIDTH = 640;
const TARGET_HEIGHT = 400; // 16:10 aspect ratio

let bookmarkedKeys = new Set();
let indexReady = false;
let indexRebuildTimer = null;

// Track pending passive capture timers per tabId
const pendingTabTimers = new Map();

// Batch capture state
const batchState = {
  running: false,
  cancelled: false,
  windowId: null,
  tabId: null,
  current: 0,
  total: 0,
  captured: 0,
  failed: 0,
  currentTitle: ''
};

async function getSettings() {
  try {
    const res = await chrome.storage.local.get(['ttlDays', 'autoCapture']);
    return {
      ttlDays: typeof res.ttlDays === 'number' ? res.ttlDays : DEFAULT_TTL_DAYS,
      autoCapture: res.autoCapture !== false
    };
  } catch {
    return { ttlDays: DEFAULT_TTL_DAYS, autoCapture: true };
  }
}

function collectBookmarkKeys(nodes, keySet) {
  for (const node of nodes) {
    if (node.url && isCapturableUrl(node.url)) {
      keySet.add(normalizeUrl(node.url));
    }
    if (node.children) {
      collectBookmarkKeys(node.children, keySet);
    }
  }
}

async function rebuildBookmarkIndex(pruneOrphans = false) {
  try {
    const tree = await chrome.bookmarks.getTree();
    const nextKeys = new Set();
    collectBookmarkKeys(tree, nextKeys);
    bookmarkedKeys = nextKeys;
    indexReady = true;

    if (pruneOrphans) {
      await pruneOrphanThumbnails(nextKeys);
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

async function compressDataUrlToWebP(dataUrl) {
  const response = await fetch(dataUrl);
  const rawBlob = await response.blob();
  const bitmap = await createImageBitmap(rawBlob);

  // Anchor crop to the top (sy = 0) so we always capture the true first screen
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
    sy = 0;
  }

  const canvas = new OffscreenCanvas(TARGET_WIDTH, TARGET_HEIGHT);
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, TARGET_WIDTH, TARGET_HEIGHT);
  bitmap.close();

  const webpBlob = await canvas.convertToBlob({
    type: 'image/webp',
    quality: 0.8
  });

  return webpBlob;
}

function broadcast(message) {
  chrome.runtime.sendMessage(message).catch(() => {
    // No extension page currently open to receive message
  });
}

async function shouldCaptureKey(key, force = false) {
  if (force) return true;
  const existing = await getThumbnail(key);
  if (!existing || existing.status !== 'ok' || !existing.blob) return true;
  const { ttlDays } = await getSettings();
  if (ttlDays <= 0) return false; // Manual refresh only once captured
  const ageMs = Date.now() - (existing.capturedAt || 0);
  return ageMs > ttlDays * 24 * 60 * 60 * 1000;
}

async function captureActiveTab(tabId, expectedKey, force = false) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab || !tab.active || !tab.url || !isCapturableUrl(tab.url)) return false;

    const currentKey = normalizeUrl(tab.url);
    if (currentKey !== expectedKey) return false;

    const win = await chrome.windows.get(tab.windowId);
    if (!win || win.state === 'minimized') return false;

    if (!(await shouldCaptureKey(currentKey, force))) return false;

    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
      format: 'jpeg',
      quality: 88
    });

    const webpBlob = await compressDataUrlToWebP(dataUrl);
    const saved = await saveThumbnail(currentKey, webpBlob, {
      status: 'ok',
      width: TARGET_WIDTH,
      height: TARGET_HEIGHT
    });

    broadcast({
      type: 'SCREENSHOT_UPDATED',
      key: currentKey,
      capturedAt: saved.capturedAt,
      size: saved.size
    });
    return true;
  } catch (err) {
    console.debug('[Folio] Capture skipped:', err?.message || err);
    return false;
  }
}

async function schedulePassiveCapture(tabId, url) {
  if (!url || !isCapturableUrl(url)) return;
  if (batchState.running && tabId === batchState.tabId) return;

  const { autoCapture } = await getSettings();
  if (!autoCapture) return;

  await ensureIndexReady();
  const key = normalizeUrl(url);
  if (!bookmarkedKeys.has(key)) return;

  if (!(await shouldCaptureKey(key, false))) return;

  if (pendingTabTimers.has(tabId)) {
    clearTimeout(pendingTabTimers.get(tabId));
  }

  const timer = setTimeout(async () => {
    pendingTabTimers.delete(tabId);
    await captureActiveTab(tabId, key, false);
  }, PASSIVE_SETTLE_MS);

  pendingTabTimers.set(tabId, timer);
}

// Listen for bookmark visits
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
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
    // Ignore transient tab closure
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (pendingTabTimers.has(tabId)) {
    clearTimeout(pendingTabTimers.get(tabId));
    pendingTabTimers.delete(tabId);
  }
});

// Listen for bookmark mutations to keep index & cache clean
chrome.bookmarks.onCreated.addListener(() => scheduleIndexRebuild(false));
chrome.bookmarks.onChanged.addListener(() => scheduleIndexRebuild(false));
chrome.bookmarks.onMoved.addListener(() => scheduleIndexRebuild(false));
chrome.bookmarks.onRemoved.addListener(() => scheduleIndexRebuild(true));
chrome.bookmarks.onImportEnded.addListener(() => scheduleIndexRebuild(false));

// Wait for a specific tab to finish loading with timeout protection
function waitForTabLoad(tabId, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      resolve(ok);
    };

    const onUpdated = (id, changeInfo) => {
      if (id === tabId && changeInfo.status === 'complete') {
        finish(true);
      }
    };

    const onRemoved = (id) => {
      if (id === tabId) finish(false);
    };

    const timer = setTimeout(() => finish(true), timeoutMs);
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

async function cleanupBatchWindow() {
  const winId = batchState.windowId;
  batchState.windowId = null;
  batchState.tabId = null;
  if (winId) {
    try {
      await chrome.windows.remove(winId);
    } catch {
      // Already closed by user
    }
  }
}

chrome.windows.onRemoved.addListener((winId) => {
  if (batchState.running && winId === batchState.windowId) {
    batchState.cancelled = true;
    batchState.windowId = null;
    batchState.tabId = null;
  }
});

async function runBatchCapture(items, force = false) {
  if (batchState.running) return;

  const queue = items
    .filter((item) => item && item.url && isCapturableUrl(item.url))
    .map((item) => ({
      url: item.url,
      title: item.title || item.url,
      key: normalizeUrl(item.url)
    }));

  if (queue.length === 0) {
    broadcast({ type: 'BATCH_PROGRESS', running: false, current: 0, total: 0, captured: 0, failed: 0, currentTitle: '' });
    return;
  }

  batchState.running = true;
  batchState.cancelled = false;
  batchState.current = 0;
  batchState.total = queue.length;
  batchState.captured = 0;
  batchState.failed = 0;
  batchState.currentTitle = queue[0].title;
  broadcastBatchProgress();

  try {
    const win = await chrome.windows.create({
      url: 'about:blank',
      type: 'popup',
      width: 1280,
      height: 820,
      focused: true
    });
    batchState.windowId = win.id;
    batchState.tabId = win.tabs?.[0]?.id || null;

    if (!batchState.tabId) {
      throw new Error('Could not initialize capture tab');
    }

    for (let i = 0; i < queue.length; i++) {
      if (batchState.cancelled || !batchState.windowId) break;

      const item = queue[i];
      batchState.current = i + 1;
      batchState.currentTitle = item.title;
      broadcastBatchProgress();

      if (!force && !(await shouldCaptureKey(item.key, false))) {
        batchState.captured += 1;
        continue;
      }

      try {
        const loadPromise = waitForTabLoad(batchState.tabId, BATCH_LOAD_TIMEOUT_MS);
        await chrome.tabs.update(batchState.tabId, { url: item.url, muted: true });
        const loaded = await loadPromise;

        if (batchState.cancelled || !loaded || !batchState.windowId) break;

        await sleep(BATCH_SETTLE_MS);
        if (batchState.cancelled || !batchState.windowId) break;

        const dataUrl = await chrome.tabs.captureVisibleTab(batchState.windowId, {
          format: 'jpeg',
          quality: 88
        });

        const webpBlob = await compressDataUrlToWebP(dataUrl);
        const saved = await saveThumbnail(item.key, webpBlob, {
          status: 'ok',
          width: TARGET_WIDTH,
          height: TARGET_HEIGHT
        });

        batchState.captured += 1;
        broadcast({
          type: 'SCREENSHOT_UPDATED',
          key: item.key,
          capturedAt: saved.capturedAt,
          size: saved.size
        });
      } catch (err) {
        batchState.failed += 1;
        console.debug('[Folio] Batch item failed:', item.url, err?.message || err);
      }
    }
  } catch (err) {
    console.warn('[Folio] Batch capture aborted:', err);
  } finally {
    await cleanupBatchWindow();
    batchState.running = false;
    batchState.currentTitle = '';
    broadcastBatchProgress();
  }
}

// Handle messages from the New Tab gallery page
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || !message.type) return;

  if (message.type === 'START_BATCH_CAPTURE') {
    runBatchCapture(message.items || [], Boolean(message.force));
    sendResponse({ ok: true });
    return;
  }

  if (message.type === 'STOP_BATCH_CAPTURE') {
    batchState.cancelled = true;
    cleanupBatchWindow();
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
      const removed = await pruneOrphanThumbnails(bookmarkedKeys);
      sendResponse({ ok: true, removed });
    })();
    return true;
  }
});

// Initialize bookmark index on install / startup
chrome.runtime.onInstalled.addListener(() => rebuildBookmarkIndex(false));
chrome.runtime.onStartup.addListener(() => rebuildBookmarkIndex(true));
rebuildBookmarkIndex(false);
