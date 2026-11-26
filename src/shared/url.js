// URL normalization, domain utilities, and deterministic ambient color helpers

const TRACKING_PARAMS = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'fbclid', 'gclid', 'yclid', 'mc_cid', 'mc_eid', 'spm', 'from', 'ref_src'
]);

const NON_CAPTURABLE_PROTOCOLS = new Set([
  'chrome:', 'chrome-extension:', 'edge:', 'about:', 'file:',
  'javascript:', 'data:', 'blob:', 'view-source:', 'devtools:'
]);

const BLOCKED_HOSTS = [
  'chrome.google.com',
  'chromewebstore.google.com',
  'microsoftedge.microsoft.com'
];

export function isCapturableUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return false;
  try {
    const parsed = new URL(rawUrl);
    if (NON_CAPTURABLE_PROTOCOLS.has(parsed.protocol)) return false;
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    if (BLOCKED_HOSTS.includes(parsed.hostname)) return false;
    return true;
  } catch {
    return false;
  }
}

export function normalizeUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return '';
  try {
    const parsed = new URL(rawUrl.trim());
    parsed.hash = '';
    parsed.hostname = parsed.hostname.toLowerCase();

    // Remove common tracking query parameters while keeping functional params
    const kept = [];
    for (const [k, v] of parsed.searchParams.entries()) {
      if (!TRACKING_PARAMS.has(k.toLowerCase())) {
        kept.push([k, v]);
      }
    }
    kept.sort((a, b) => a[0].localeCompare(b[0]));
    parsed.search = '';
    for (const [k, v] of kept) {
      parsed.searchParams.append(k, v);
    }

    let pathname = parsed.pathname;
    if (pathname.length > 1 && pathname.endsWith('/')) {
      pathname = pathname.slice(0, -1);
    }
    parsed.pathname = pathname;

    return parsed.toString().replace(/\/$/, '');
  } catch {
    return rawUrl.trim();
  }
}

export function getDisplayHost(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    return parsed.hostname.replace(/^www\./i, '');
  } catch {
    return rawUrl || '';
  }
}

export function getRootDomain(rawUrl) {
  const host = getDisplayHost(rawUrl);
  const parts = host.split('.');
  if (parts.length <= 2) return host;
  // Handle common 2-level TLDs like .co.uk, .com.cn
  const tail = parts.slice(-2).join('.');
  if (['com.cn', 'org.cn', 'net.cn', 'co.uk', 'co.jp', 'com.hk'].includes(tail) && parts.length >= 3) {
    return parts.slice(-3).join('.');
  }
  return tail;
}

export function getFaviconUrl(rawUrl, size = 32) {
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id && chrome.runtime.getURL) {
    const url = new URL(chrome.runtime.getURL('/_favicon/'));
    url.searchParams.set('pageUrl', rawUrl);
    url.searchParams.set('size', String(size));
    return url.toString();
  }
  // Preview fallback when opened outside Chrome extension context
  return '';
}

export function hashString(str) {
  let hash = 2166136261;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash);
}

// Deterministic architectural cool/neutral-harmonized hue for placeholder surfaces
export function getDomainHue(rawUrl) {
  const host = getDisplayHost(rawUrl) || rawUrl || 'folio';
  return hashString(host) % 360;
}

export function formatRelativeDate(timestamp) {
  if (!timestamp) return '';
  const diff = Date.now() - timestamp;
  const mins = Math.floor(diff / 60000);
  if (mins < 2) return '刚刚';
  if (mins < 60) return `${mins} 分钟前`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} 个月前`;
  const d = new Date(timestamp);
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}`;
}
