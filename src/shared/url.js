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

const INTERNAL_FOLDER_HINTS = ['公司', '工作', '内网', '内部', 'work', 'company', 'office', 'intranet', 'internal'];

const INTERNAL_TLD_SUFFIXES = [
  '.local', '.localhost', '.internal', '.intranet', '.lan', '.corp', '.home', '.arpa'
];

const INTERNAL_HOST_LABELS = new Set([
  'internal', 'intranet', 'corp', 'lan', 'local', 'localhost'
]);

export function isLikelyInternalFolder(folderTitle) {
  if (!folderTitle) return false;
  const lower = folderTitle.toLowerCase();
  return INTERNAL_FOLDER_HINTS.some((hint) => lower.includes(hint));
}

export function isPrivateOrInternalUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return true;
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return true;
    const host = parsed.hostname.toLowerCase();

    if (!host || host === 'localhost' || host === '::1' || host === '[::1]') return true;
    // IPv6 literal hostnames (loopback, link-local, ULA, or raw IPv6 addresses)
    if (host.startsWith('[') || host.includes(':')) return true;
    // Single-label hostnames (e.g., http://oa, http://wiki)
    if (!host.includes('.')) return true;
    if (INTERNAL_TLD_SUFFIXES.some((s) => host.endsWith(s))) return true;
    // Internal subdomain labels anywhere in hostname (e.g., wiki.internal.company, oa.corp.example.com)
    if (host.split('.').some((label) => INTERNAL_HOST_LABELS.has(label))) return true;

    // IPv4 private / loopback / link-local / CGNAT ranges
    const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (ipv4) {
      const a = Number(ipv4[1]);
      const b = Number(ipv4[2]);
      if (a === 10 || a === 127 || a === 0) return true;
      if (a === 192 && b === 168) return true;
      if (a === 169 && b === 254) return true;
      if (a === 172 && b >= 16 && b <= 31) return true;
      if (a === 100 && b >= 64 && b <= 127) return true;
    }

    return false;
  } catch {
    return true;
  }
}

// Strict Plan A sanitizer for optional third-party cover fetch:
// Returns ONLY a standard public domain origin (e.g. "https://example.com"),
// stripping all paths, doc IDs, query params, hashes, credentials, raw IPs, and custom ports.
export function toSafePublicOrigin(rawUrl) {
  if (!isCapturableUrl(rawUrl) || isPrivateOrInternalUrl(rawUrl)) return null;
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    const host = parsed.hostname.toLowerCase();
    // Reject raw IPv4 literals (even public IPs are often VPN gateways or staging servers)
    if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return null;
    // Reject non-standard ports
    if (parsed.port && parsed.port !== '80' && parsed.port !== '443') return null;
    return `${parsed.protocol}//${host}`;
  } catch {
    return null;
  }
}

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
