// Early New Tab Gate & Pre-Paint Layout Hydration — runs in <head> before paint so:
// 1) Collapsed sidebar renders immediately at 60px on frame 0 with zero reload collapse animation.
// 2) Turning OFF "launchOnNewTab" seamlessly falls back to Chrome's native New Tab Page without flashing Folio's UI.
(() => {
  const root = document.documentElement;
  root.classList.add('is-booting');
  try {
    if (localStorage.getItem('folio_sidebar_collapsed') === '1') {
      root.classList.add('is-sidebar-collapsed-boot');
    }
  } catch {
    // Ignore storage restrictions
  }

  if (typeof chrome === 'undefined' || !chrome.storage?.local || !chrome.runtime?.id) {
    return;
  }

  const params = new URLSearchParams(window.location.search);
  const source = params.get('source');
  if (source === 'action' || source === 'startup' || source === 'shortcut') {
    try {
      sessionStorage.setItem('folio_explicit_tab', '1');
      // Keep address bar clean while preserving explicit-tab status across Cmd+R reloads
      if (window.history?.replaceState) {
        window.history.replaceState(null, '', window.location.pathname);
      }
    } catch {
      // Ignore storage restrictions
    }
    return;
  }

  // Never redirect an already-open Folio tab when the user reloads (Cmd+R)
  try {
    if (sessionStorage.getItem('folio_explicit_tab') === '1') return;
    const nav = performance.getEntriesByType?.('navigation')?.[0];
    if (nav && nav.type === 'reload') return;
  } catch {
    // Continue to preference check
  }

  root.classList.add('is-gate-pending');

  chrome.storage.local.get('launchOnNewTab', (res) => {
    if (res && res.launchOnNewTab === false) {
      if (chrome.tabs?.getCurrent && chrome.tabs?.update) {
        chrome.tabs.getCurrent((tab) => {
          if (tab && typeof tab.id === 'number') {
            chrome.tabs.update(tab.id, { url: 'chrome://new-tab-page/' });
          } else {
            window.location.replace('chrome://new-tab-page/');
          }
        });
      } else {
        window.location.replace('chrome://new-tab-page/');
      }
      return;
    }
    root.classList.remove('is-gate-pending');
  });
})();
