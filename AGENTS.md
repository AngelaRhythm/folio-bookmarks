# AGENTS.md

Guidance for AI coding agents working on the **Folio** Chrome Extension repository.

## Project Overview

Folio is a zero-build, Manifest V3 Chrome Extension that overrides the browser New Tab page (`chrome_url_overrides.newtab`) with a minimalist visual bookmark gallery.

- **Single Source of Truth**: Chrome's native bookmark tree (`chrome.bookmarks`) is always authoritative. Never store an independent copy of bookmarks; only store thumbnail blobs in IndexedDB keyed by normalized URL and lightweight UI preferences in `chrome.storage.local`.
- **Zero-Build Native ES Modules**: All browser and Service Worker code uses native ESM (`type="module"`) with zero external runtime dependencies and no bundler step. Keep it zero-build so users can load the repository directory directly in `chrome://extensions/` and refresh with `Cmd + R`.

## Architecture & Key Files

- `manifest.json`: MV3 manifest declaring `newtab.html`, module Service Worker `src/background.js`, and permissions (`bookmarks`, `tabs`, `storage`, `unlimitedStorage`, `favicon`, `alarms`, `<all_urls>`).
- `newtab.html`: Semantic HTML shell containing the collapsible sidebar, sticky topbar, first-time onboarding modal, Spotlight search overlay, Tidy Studio slide-over drawer, move popover, tooltip, and toast.
- `styles/folio.css`: Design tokens (`:root` light stone & `[data-theme="dark"]` darkroom), layout, responsive breakpoints, and calibrated micro-interactions.
- `src/app.js`: Frontend controller managing tree parsing, real-time bookmark subscription (debounced 150ms), `IntersectionObserver` lazy IndexedDB thumbnail decoding, drag-and-drop moves onto sidebar folders, 72-hour `New` tag lifecycle, Spotlight search, first-time onboarding flow, top Favorites quick-launch bar, dynamic 2-row group previews with in-place expand/collapse, redirect open-intent registration, and Tidy Studio actions.
- `src/background.js`: MV3 Service Worker implementing the 3-layer silent self-updating engine: (1) zero-popup concurrent background capture for public non-internal bookmarks (WordPress mShots -> `og:image` fallback, persisted queue resilient to MV3 worker sleep), (2) redirect-aware passive `captureVisibleTab` upgrade (`source: 'capture'`) when visiting bookmarks, and (3) long-interval weekly/monthly `chrome.alarms` auto-refresh + orphan thumbnail pruning on `bookmarks.onRemoved`.
- `src/shared/chrome-bridge.js`: Adapter wrapping `chrome.bookmarks`, `chrome.storage.local`, and `chrome.runtime`. When `IS_EXTENSION` is `false` (previewed via HTTP outside Chrome), it seamlessly provides an in-memory demo bookmark tree and procedural canvas preview thumbnails.
- `src/shared/db.js`: IndexedDB wrapper (`folio_bookmark_gallery` / `thumbnails` store) with stats and orphan pruning.
- `src/shared/organizer.js`: Pure local analysis engine for folder overlap insights, domain/keyword move suggestions, scattered same-domain clusters, and duplicate URL detection.
- `src/shared/url.js`: URL normalization (strips hash and common tracking params, preserves functional query params), capturable protocol guard, root domain helper, favicon URL helper, and deterministic placeholder hue.
- `src/icons.js`: Inline crisp `1.5px`-stroke SVG icon registry.

## Design & UX Guardrails

Preserve the established minimalist gallery direction in every change:

1. **Theme**: Follows browser/OS `prefers-color-scheme` automatically (`applyTheme()` in `src/app.js`). Do not re-add manual theme switchers unless explicitly requested.
2. **Typography**: One versatile Neo-Grotesk system font stack (`--font-sans`) with `font-variant-numeric: tabular-nums` for counts. Maintain the strict 3-size body scale (`--text-heading`, `--text-body`, `--text-sm`) plus `--text-h1` for the view title.
3. **Minimal Chrome**:
   - Left sidebar collapses smoothly between `228px` and `60px` rail; footer contains only the on-demand `整理建议` entry.
   - Main gallery uses a fixed compact `16:10` card grid with zero persistent batch-capture buttons on the page or section headers (initial capture is handled once via the first-time onboarding modal, then passively on visit; individual recapture remains in the card hover action bar).
   - `New` tags appear inline beside card titles only when `0 <= Date.now() - dateAdded <= 72h` (`NEW_TAG_TTL_MS`).
4. **Motion Hygiene**:
   - Never use `transition: all`. Always name explicit CSS properties.
   - Use smooth ease-out timing (`150ms–240ms`, `cubic-bezier(0.22, 1, 0.36, 1)`).
   - Respect `@media (prefers-reduced-motion: reduce)`.
5. **Copy Hygiene**: Keep Chinese UI copy concise, direct, and free of em-dashes (`—`).

## Local Verification Workflow

1. **Syntax check all modules**:
   ```bash
   node --check src/app.js && node --check src/background.js && node --check src/icons.js && node --check src/shared/url.js && node --check src/shared/db.js && node --check src/shared/organizer.js && node --check src/shared/chrome-bridge.js
   ```
2. **Visual & interactive preview**:
   ```bash
   python3 -m http.server 8765 --bind 127.0.0.1
   ```
   - Normal gallery preview: `http://127.0.0.1:8765/newtab.html`
   - Force-show first-time onboarding prompt: `http://127.0.0.1:8765/newtab.html?onboarding=1`
3. **Real Extension Testing**:
   - Load unpacked at `chrome://extensions/`.
   - UI/CSS/JS edits under `newtab.html`, `styles/`, `src/app.js`, or `src/shared/` apply on `Cmd + R`.
   - Changes to `manifest.json` or `src/background.js` require clicking the reload icon (`↻`) on the extension card in `chrome://extensions/`.

## Coding Conventions

- Keep relative imports inside `src/shared/` sibling-relative (`./url.js`, `./db.js`), never `./shared/...`.
- Always revoke blob URLs (`URL.revokeObjectURL`) when invalidating cached thumbnails.
- Escape all bookmark titles, URLs, and folder names with `escapeHtml()` before interpolating into HTML strings.
- Never silently swallow Service Worker errors that break queue cleanup; always close the batch capture popup window in `finally`.
