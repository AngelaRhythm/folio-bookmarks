// IndexedDB store for compressed WebP first-screen thumbnails

const DB_NAME = 'folio_bookmark_gallery';
const DB_VERSION = 1;
const STORE_THUMBS = 'thumbnails';

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(STORE_THUMBS)) {
        const store = db.createObjectStore(STORE_THUMBS, { keyPath: 'key' });
        store.createIndex('capturedAt', 'capturedAt', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

export async function getThumbnail(key) {
  if (!key) return null;
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_THUMBS, 'readonly');
    const req = tx.objectStore(STORE_THUMBS).get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

export async function getThumbnailMetaMap() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_THUMBS, 'readonly');
    const store = tx.objectStore(STORE_THUMBS);
    const map = new Map();
    const req = store.openCursor();
    req.onsuccess = (event) => {
      const cursor = event.target.result;
      if (cursor) {
        const { key, capturedAt, size, status, source } = cursor.value;
        map.set(key, {
          capturedAt,
          size: size || 0,
          status: status || 'ok',
          source: source || 'capture'
        });
        cursor.continue();
      } else {
        resolve(map);
      }
    };
    req.onerror = () => reject(req.error);
  });
}

export async function saveThumbnail(key, blob, extra = {}) {
  const db = await openDb();
  const record = {
    key,
    blob,
    size: blob ? blob.size : 0,
    capturedAt: Date.now(),
    status: extra.status || 'ok',
    source: extra.source || 'capture', // 'capture' | 'mshots' | 'og'
    width: extra.width || 640,
    height: extra.height || 400
  };
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_THUMBS, 'readwrite');
    tx.objectStore(STORE_THUMBS).put(record);
    tx.oncomplete = () => resolve(record);
    tx.onerror = () => reject(tx.error);
  });
}

export async function deleteThumbnail(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_THUMBS, 'readwrite');
    tx.objectStore(STORE_THUMBS).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function clearAllThumbnails() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_THUMBS, 'readwrite');
    tx.objectStore(STORE_THUMBS).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function pruneOrphanThumbnails(validKeySet) {
  const db = await openDb();
  let removed = 0;
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_THUMBS, 'readwrite');
    const store = tx.objectStore(STORE_THUMBS);
    const req = store.openCursor();
    req.onsuccess = (event) => {
      const cursor = event.target.result;
      if (cursor) {
        if (!validKeySet.has(cursor.key)) {
          cursor.delete();
          removed += 1;
        }
        cursor.continue();
      }
    };
    tx.oncomplete = () => resolve(removed);
    tx.onerror = () => reject(tx.error);
  });
}

export async function getStorageStats() {
  const meta = await getThumbnailMetaMap();
  let totalBytes = 0;
  let okCount = 0;
  for (const item of meta.values()) {
    totalBytes += item.size || 0;
    if (item.status === 'ok') okCount += 1;
  }
  return {
    count: okCount,
    totalRecords: meta.size,
    totalBytes
  };
}
