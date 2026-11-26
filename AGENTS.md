# AGENTS.md

Master engineering guide for AI coding agents (Claude Code, Cursor, Antigravity, Codex, etc.) customizing or extending **Folio**.

Read this file first before modifying any code. For deep dives, see:

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — Module graph, data schemas, message bus, local capture vs opt-in remote cover flow, and MV3 Service Worker lifecycle.
- [docs/UI_DESIGN_SYSTEM.md](docs/UI_DESIGN_SYSTEM.md) — `oklch.fyi`-inspired OKLCH color tokens, typography scale, `0.5px` hairline rules, component anatomy, custom scrollbar, and zero-lag custom cursor.
- [docs/CUSTOMIZATION_GUIDE.md](docs/CUSTOMIZATION_GUIDE.md) — Step-by-step modification recipes and common pitfalls for safe customization.

---

## 1. Project Identity & Non-Negotiable Invariants

Folio is a **zero-build, Manifest V3 Chrome Extension** overriding `chrome_url_overrides.newtab` with a minimalist visual bookmark gallery.

Preserve these five invariants unless the user explicitly asks to change them:

1. **Single Source of Truth (`chrome.bookmarks`)**: Never maintain a separate bookmark database. Chrome's native bookmark tree is authoritative. Store only compressed WebP thumbnails in IndexedDB (keyed by `normalizeUrl(url)`) and lightweight UI preferences in `chrome.storage.local`.
2. **Zero-Build Native ESM**: All JS files use native ES modules (`type="module"`) with zero `npm` runtime dependencies and no bundler. Users load the repo folder directly in `chrome://extensions/` and refresh UI changes with `Cmd + R`.
3. **Pure-Local Privacy by Default (`remoteCoverEnabled: false`)**:
   - In default mode, Folio MUST make **zero** third-party network requests and never send any bookmark URL off-device. Covers come exclusively from local `chrome.tabs.captureVisibleTab` when the user visits a non-excluded bookmark.
   - Optional remote cover fetching is strictly opt-in (`remoteCoverEnabled === true`) and enforces **Plan A origin-only sanitization** via `toSafePublicOrigin(url)` (strips all paths, document IDs, `?query`, `#hash`, credentials, raw IPs, and non-standard ports) plus `credentials: 'omit'` and `referrerPolicy: 'no-referrer'`.
4. **Unbypassable Exclusion Rules (Fail-Closed)**:
   - Private/internal URLs (`isPrivateOrInternalUrl`) and excluded folders (`excludedFolderIds`, auto-seeded with `公司`/`工作`/`内网`/etc. on first launch) must NEVER be captured locally, fetched remotely, or rendered with covers.
   - `force: true` on `START_BATCH_CAPTURE` ONLY bypasses thumbnail TTL expiration — it MUST NEVER bypass `meta.excluded` or `remoteCoverEnabled`.
   - If the same URL exists in both an excluded folder and a public folder, both frontend (`state.excludedKeys`) and backend (`bookmarkedMeta`) treat it as excluded.
5. **Dual Mode Compatibility (`IS_EXTENSION`)**:
   - Everything UI-related must keep working both inside Chrome (`IS_EXTENSION === true`) and over local HTTP (`python3 -m http.server`, `IS_EXTENSION === false`) via [src/shared/chrome-bridge.js](src/shared/chrome-bridge.js).

---

## 2. Repository Map

```text
folio-bookmarks/
├── manifest.json                 # MV3 manifest, permissions, newtab override, ESM background worker
├── newtab.html                   # Page skeleton, shared OKLCH SVG <defs>, sidebar, workspace, split Settings pane, modals
├── styles/
│   └── folio.css                 # Full design system: OKLCH Light/Dark tokens, layout, components, custom cursor & scrollbars
├── icons/                        # Extension PNG icons (16 / 32 / 48 / 128 px)
├── src/
│   ├── app.js                    # UI controller: tree model, gallery, favorites, DnD, Spotlight, Settings, scrollbar, custom cursor
│   ├── background.js             # MV3 Service Worker: local passive capture, opt-in Plan A remote queue, alarms, orphan pruning
│   ├── icons.js                  # Dual icon registry: Nucleo Glass (left sidebar) + Tabler Icons (all other controls)
│   └── shared/
│       ├── chrome-bridge.js      # Unified Chrome API / HTTP preview mock adapter + preferences load/save
│       ├── db.js                 # IndexedDB wrapper (folio_bookmark_gallery / thumbnails)
│       └── url.js                # URL normalization, privacy/internal guards, Plan A toSafePublicOrigin, favicon & hue helpers
├── README.md                     # User-facing overview, installation, shortcuts, privacy boundaries
├── AGENTS.md                     # This file (AI agent entry point)
└── docs/
    ├── ARCHITECTURE.md           # Deep technical architecture, data schemas & runtime flows
    ├── UI_DESIGN_SYSTEM.md       # Visual tokens, layout geometry, components & micro-interactions
    └── CUSTOMIZATION_GUIDE.md    # Concrete modification recipes & gotchas
```

---

## 3. Quick "Where to Edit What" Matrix

| Goal | Primary Files | Key Symbols / Sections |
| :--- | :--- | :--- |
| Change default preferences | `src/shared/chrome-bridge.js`, `src/app.js`, `src/background.js` | `loadPreferences()`, `state.prefs`, `getSettings()` |
| Modify bookmark tree / folder flattening | `src/app.js`, `src/background.js` | `buildTreeModel()`, `collectBookmarkEntries()` |
| Change card layout / columns / 2-row preview | `styles/folio.css`, `src/app.js` | `.card-grid`, `getGridColumnCount()`, `renderAllView()`, `createCardElement()` |
| Modify Favorites quick rail | `src/app.js`, `styles/folio.css` | `syncFavoritesSection()`, `toggleFavoriteKey()`, `.favorites-rail` |
| Modify card context menu or Edit Bookmark modal | `newtab.html`, `src/app.js`, `src/shared/chrome-bridge.js`, `styles/folio.css` | `#card-context-menu`, `#edit-bookmark-overlay`, `openBookmarkInSplitView()`, `updateBookmark()` |
| Edit Spotlight search or IME behavior | `src/app.js`, `newtab.html`, `styles/folio.css` | `openSpotlight()`, `updateSpotlightResults()`, `spotlightComposing` |
| Add/edit Settings controls or Health tab | `src/app.js`, `styles/folio.css` | `renderTidyContent()`, `els.tidyContent` click/change listeners |
| Change exclusion or URL sanitization rules | `src/shared/url.js`, `src/background.js`, `src/app.js` | `isPrivateOrInternalUrl()`, `toSafePublicOrigin()`, `rebuildExcludedKeySet()` |
| Change thumbnail size / WebP quality / TTL | `src/background.js` | `TARGET_WIDTH`, `TARGET_HEIGHT`, `compressBlobToWebP()`, `DEFAULT_REFRESH_DAYS` |
| Change sidebar icons (Nucleo Glass) | `src/icons.js`, `src/app.js`, `newtab.html` | `ICONS.glass*`, `getSidebarFolderIcon()`, `<svg><defs>` gradients |
| Change UI control icons (Tabler) | `src/icons.js`, `src/app.js` | `ICONS.*` (24x24, 1.75px round stroke) |
| Edit theme colors / borders / typography | `styles/folio.css` | `:root`, `[data-theme="dark"]`, `--border-hairline` (`0.5px`) |
| Edit sidebar bottom isometric boxes | `src/app.js`, `styles/folio.css`, `newtab.html` | `initSidebarBackgroundBoxes()`, `#sidebar-bg-boxes` |
| Edit floating overlay scrollbars | `src/app.js`, `styles/folio.css` | `initOverlayScrollbars()`, `suppressOverlayScrollbars()`, `.folio-scrollbar` |
| Edit zero-lag custom cursor & pill | `src/app.js`, `styles/folio.css` | `initCustomCursor()`, `resolveCursorPill()`, `.folio-cursor-pill` |
| Edit watermark footer / back-to-top | `newtab.html`, `styles/folio.css`, `src/app.js` | `#gallery-footer`, `#btn-back-to-top` |
| Update preview mock dataset | `src/shared/chrome-bridge.js` | `mockTree`, `MOCK_VISUAL_PRESETS` |

---

## 4. Design & Engineering Guardrails

1. **Theme**: Strictly achromatic (`C = 0`) Light (`oklch(0.991 0 0)`) and Dark (`oklch(0.17 0 0)`) neutrals following `prefers-color-scheme` automatically (`applyTheme()`). Only accents, Nucleo Glass sidebar icons, sidebar background boxes, and cursor semantics carry OKLCH chroma.
2. **Hairlines & Scroll**:
   - Use **`0.5px`** borders and ring hairlines sitewide (do not introduce `1px` borders).
   - Keep all native scrollbars hidden (`scrollbar-width: none` / `::-webkit-scrollbar { display: none }`) and preserve global `overscroll-behavior: none`.
   - Whenever animating a width-changing panel (sidebar or Settings split pane), call `suppressOverlayScrollbars(340)` so synthetic resize scroll events do not flash `.folio-scrollbar`.
3. **Icon Separation**:
   - Left sidebar folder/nav items use **Nucleo Glass** layered OKLCH SVGs (`ICONS.glass*`).
   - Every other UI button (sidebar collapse, settings gear, right collapse `chevrons-right`, search, card hover actions, back-to-top) uses **Tabler Icons** (`24×24`, `1.75px` round stroke).
4. **Motion & Performance**:
   - Never use `transition: all`; always name explicit CSS properties.
   - Respect `@media (prefers-reduced-motion: reduce)`.
   - Never add CSS `transition` or JS lerp/rAF delay to `.folio-cursor-pill` position (`translate3d`); keep pointer arrows on OS hardware `cursor: image-set(...)`.
   - Always revoke blob URLs (`URL.revokeObjectURL`) when clearing or replacing cached thumbnails.
5. **Copy & Security Hygiene**:
   - Keep Chinese UI copy concise, direct, UI-first (let controls speak instead of paragraphs), and free of em-dashes (`—`).
   - Escape every untrusted bookmark title, URL, host, and folder name with `escapeHtml()` before HTML interpolation.
   - Keep imports inside `src/shared/` sibling-relative (`./url.js`, `./db.js`), never `./shared/...`.
   - Preserve CJK IME composition guards (`isComposing`, `keyCode === 229`, `compositionend` timestamp grace) on Spotlight and global keydown handlers.

---

## 5. Verification Checklist (Run After Every Change)

### 5.1 Syntax & Security Unit Check
```bash
node --check src/app.js && \
node --check src/background.js && \
node --check src/icons.js && \
node --check src/shared/url.js && \
node --check src/shared/db.js && \
node --check src/shared/chrome-bridge.js
```

Run the Plan A URL sanitizer invariant check whenever touching `src/shared/url.js` or `src/background.js`:
```bash
node --input-type=module -e "
import assert from 'node:assert/strict';
import { toSafePublicOrigin, isPrivateOrInternalUrl } from './src/shared/url.js';
assert.equal(toSafePublicOrigin('https://u:p@docs.google.com/d/secret?token=1#a'), 'https://docs.google.com');
for (const u of ['http://localhost:3000', 'http://10.0.0.1', 'http://192.168.1.1', 'http://[::1]', 'http://wiki.internal.company/x', 'https://jira.corp.example.com', 'https://8.8.8.8', 'https://example.com:8443']) {
  assert.equal(toSafePublicOrigin(u), null, 'Must block: ' + u);
}
assert.equal(isPrivateOrInternalUrl('http://[fd00::1]'), true);
console.log('SECURITY_OK');
"
```

### 5.2 Local HTTP Visual Preview (No Chrome Install Needed)
```bash
python3 -m http.server 8765 --bind 127.0.0.1
```
- Normal gallery: `http://127.0.0.1:8765/newtab.html`
- First-time welcome modal: `http://127.0.0.1:8765/newtab.html?onboarding=1`

### 5.3 Real Chrome Extension Reload Rules
- Edits to `newtab.html`, `styles/folio.css`, `src/app.js`, `src/icons.js`, or `src/shared/*`: press `Cmd + R` (`Ctrl + R`) on the New Tab page.
- Edits to `manifest.json` or `src/background.js`: open `chrome://extensions/` and click the reload (`↻`) button on the Folio card to restart the MV3 Service Worker.
