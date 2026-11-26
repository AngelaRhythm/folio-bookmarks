// Icon Registry
// - Left sidebar icons (except collapse): Nucleo Glass aesthetic (layered translucent frosted glass + specular rim)
// - All other UI icons (including sidebar collapse): Tabler Icons (24x24, 1.75px round stroke)

export const ICONS = {
  // Brand aperture mark
  brand: `<svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
    <rect x="2" y="2" width="7" height="7" rx="2" fill="url(#ng-cobalt)"/>
    <rect x="11" y="2" width="7" height="7" rx="2" fill="currentColor" fill-opacity="0.82"/>
    <rect x="2" y="11" width="7" height="7" rx="2" fill="currentColor" fill-opacity="0.82"/>
    <rect x="11" y="11" width="7" height="7" rx="2" fill="url(#ng-glass-pane)" stroke="url(#ng-glass-stroke)" stroke-width="0.9"/>
  </svg>`,

  // --- Nucleo Glass Style Sidebar Icons ---
  glassAllGrid: `<svg width="19" height="19" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <rect x="3" y="3" width="8.5" height="8.5" rx="2.4" fill="url(#ng-cobalt)"/>
    <rect x="12.5" y="12.5" width="8.5" height="8.5" rx="2.4" fill="url(#ng-cobalt)" fill-opacity="0.72"/>
    <rect x="12.5" y="3" width="8.5" height="8.5" rx="2.4" fill="url(#ng-glass-pane)" stroke="url(#ng-glass-stroke)" stroke-width="1"/>
    <rect x="3" y="12.5" width="8.5" height="8.5" rx="2.4" fill="url(#ng-glass-pane)" stroke="url(#ng-glass-stroke)" stroke-width="1"/>
    <path d="M5 5.2h4.2" stroke="#FFFFFF" stroke-opacity="0.55" stroke-width="1.1" stroke-linecap="round"/>
  </svg>`,

  glassInbox: `<svg width="19" height="19" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <rect x="4.5" y="4" width="15" height="10" rx="2.5" fill="url(#ng-amber)" fill-opacity="0.9"/>
    <path d="M3.2 12.2a1.6 1.6 0 0 1 1.6-1.6h3.8l1.4 2.4h4l1.4-2.4h3.8a1.6 1.6 0 0 1 1.6 1.6v5.4a2.4 2.4 0 0 1-2.4 2.4H5.6a2.4 2.4 0 0 1-2.4-2.4v-5.4Z" fill="url(#ng-glass-pane)" stroke="url(#ng-glass-stroke)" stroke-width="1"/>
    <path d="M7.5 7.5h9" stroke="#FFFFFF" stroke-opacity="0.6" stroke-width="1.2" stroke-linecap="round"/>
  </svg>`,

  glassFolder: `<svg width="19" height="19" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M3 7.2A2.2 2.2 0 0 1 5.2 5h4.3c.62 0 1.21.27 1.62.74L12.5 7.3h6.3A2.2 2.2 0 0 1 21 9.5v8.3a2.2 2.2 0 0 1-2.2 2.2H5.2A2.2 2.2 0 0 1 3 17.8V7.2Z" fill="url(#ng-slate)" fill-opacity="0.72"/>
    <rect x="2.6" y="9.2" width="18.8" height="11" rx="2.5" fill="url(#ng-glass-pane)" stroke="url(#ng-glass-stroke)" stroke-width="1"/>
    <path d="M6.2 12.2h6.6" stroke="#FFFFFF" stroke-opacity="0.52" stroke-width="1.15" stroke-linecap="round"/>
  </svg>`,

  glassFolderActive: `<svg width="19" height="19" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M3 7.2A2.2 2.2 0 0 1 5.2 5h4.3c.62 0 1.21.27 1.62.74L12.5 7.3h6.3A2.2 2.2 0 0 1 21 9.5v8.3a2.2 2.2 0 0 1-2.2 2.2H5.2A2.2 2.2 0 0 1 3 17.8V7.2Z" fill="url(#ng-cobalt)"/>
    <rect x="2.6" y="9.2" width="18.8" height="11" rx="2.5" fill="url(#ng-glass-pane)" stroke="url(#ng-glass-stroke)" stroke-width="1"/>
    <path d="M6.2 12.2h6.6" stroke="#FFFFFF" stroke-opacity="0.65" stroke-width="1.15" stroke-linecap="round"/>
  </svg>`,

  glassTidy: `<svg width="19" height="19" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M11 3.2c.35-.9 1.65-.9 2 0l1.55 4.05 4.05 1.55c.9.35.9 1.65 0 2l-4.05 1.55-1.55 4.05c-.35.9-1.65.9-2 0l-1.55-4.05-4.05-1.55c-.9-.35-.9-1.65 0-2l4.05-1.55L11 3.2Z" fill="url(#ng-violet)"/>
    <circle cx="17.5" cy="17.5" r="4" fill="url(#ng-glass-pane)" stroke="url(#ng-glass-stroke)" stroke-width="1"/>
    <path d="M17.5 15.8v3.4M15.8 17.5h3.4" stroke="#FFFFFF" stroke-opacity="0.72" stroke-width="1.15" stroke-linecap="round"/>
  </svg>`,

  // Semantic Nucleo Glass Folder Icons (for crisp recognition in collapsed rail)
  glassWork: `<svg width="19" height="19" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M8.5 6.5V5.2A1.7 1.7 0 0 1 10.2 3.5h3.6a1.7 1.7 0 0 1 1.7 1.7v1.3" stroke="url(#ng-cobalt)" stroke-width="2" stroke-linecap="round"/>
    <rect x="4" y="6.2" width="16" height="12.6" rx="2.8" fill="url(#ng-cobalt)" fill-opacity="0.88"/>
    <rect x="2.8" y="9.8" width="18.4" height="10.2" rx="2.6" fill="url(#ng-glass-pane)" stroke="url(#ng-glass-stroke)" stroke-width="1"/>
    <rect x="10.2" y="12.2" width="3.6" height="2" rx="1" fill="#FFFFFF" fill-opacity="0.72"/>
  </svg>`,

  glassForum: `<svg width="19" height="19" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <rect x="6" y="4" width="15" height="11" rx="3" fill="url(#ng-cyan)" fill-opacity="0.88"/>
    <path d="M3 9.5a2.8 2.8 0 0 1 2.8-2.8h10.4A2.8 2.8 0 0 1 19 9.5v6.2a2.8 2.8 0 0 1-2.8 2.8H9.2L5.4 21v-2.5H5.8A2.8 2.8 0 0 1 3 15.7V9.5Z" fill="url(#ng-glass-pane)" stroke="url(#ng-glass-stroke)" stroke-width="1"/>
    <path d="M7.2 11.4h7.2M7.2 14.4h4.6" stroke="#FFFFFF" stroke-opacity="0.68" stroke-width="1.2" stroke-linecap="round"/>
  </svg>`,

  glassVisual: `<svg width="19" height="19" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <circle cx="14.5" cy="9.5" r="6" fill="url(#ng-rose)" fill-opacity="0.88"/>
    <rect x="3" y="8.5" width="14.5" height="11.5" rx="3" fill="url(#ng-glass-pane)" stroke="url(#ng-glass-stroke)" stroke-width="1"/>
    <circle cx="7.4" cy="12.6" r="1.4" fill="#FFFFFF" fill-opacity="0.75"/>
    <path d="M5.5 17.5l3.5-3.2 2.4 2.1 2.2-1.8 2 2.9" stroke="#FFFFFF" stroke-opacity="0.68" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`,

  glassGlobe: `<svg width="19" height="19" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <circle cx="12" cy="12" r="8.2" fill="url(#ng-emerald)" fill-opacity="0.86"/>
    <ellipse cx="12" cy="12" rx="4.2" ry="8.2" fill="url(#ng-glass-pane)" stroke="url(#ng-glass-stroke)" stroke-width="1"/>
    <path d="M4.2 12h15.6" stroke="#FFFFFF" stroke-opacity="0.62" stroke-width="1.15" stroke-linecap="round"/>
  </svg>`,

  glassTools: `<svg width="19" height="19" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <rect x="4" y="4" width="16" height="6.8" rx="2.4" fill="url(#ng-amber)" fill-opacity="0.88"/>
    <rect x="4" y="13.2" width="16" height="6.8" rx="2.4" fill="url(#ng-glass-pane)" stroke="url(#ng-glass-stroke)" stroke-width="1"/>
    <circle cx="15" cy="7.4" r="1.6" fill="#FFFFFF" fill-opacity="0.85"/>
    <circle cx="9" cy="16.6" r="1.6" fill="#FFFFFF" fill-opacity="0.85"/>
  </svg>`,

  glassCode: `<svg width="19" height="19" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <rect x="4.5" y="3.8" width="15" height="16.4" rx="3" fill="url(#ng-cobalt)" fill-opacity="0.86"/>
    <rect x="2.8" y="6.8" width="18.4" height="12.4" rx="2.8" fill="url(#ng-glass-pane)" stroke="url(#ng-glass-stroke)" stroke-width="1"/>
    <path d="M9.4 10.6 7 13l2.4 2.4M14.6 10.6 17 13l-2.4 2.4" stroke="#FFFFFF" stroke-opacity="0.82" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`,

  glassSpec: `<svg width="19" height="19" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <rect x="6" y="3.5" width="13.5" height="17" rx="2.6" fill="url(#ng-slate)" fill-opacity="0.82"/>
    <rect x="4.2" y="5.2" width="13.5" height="15.3" rx="2.6" fill="url(#ng-glass-pane)" stroke="url(#ng-glass-stroke)" stroke-width="1"/>
    <path d="M7.5 10h6.8M7.5 13.2h6.8M7.5 16.4h4.2" stroke="#FFFFFF" stroke-opacity="0.72" stroke-width="1.2" stroke-linecap="round"/>
  </svg>`,

  glassAi: `<svg width="19" height="19" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <rect x="4.5" y="4.5" width="15" height="15" rx="4.2" fill="url(#ng-violet)" fill-opacity="0.9"/>
    <circle cx="12" cy="12" r="5.6" fill="url(#ng-glass-pane)" stroke="url(#ng-glass-stroke)" stroke-width="1"/>
    <path d="M12 8.8l.9 2.3 2.3.9-2.3.9-.9 2.3-.9-2.3-2.3-.9 2.3-.9.9-2.3Z" fill="#FFFFFF" fill-opacity="0.88"/>
  </svg>`,

  // --- Tabler Icons (24x24, 1.75px stroke, round cap & join) ---

  // Tabler: layout-sidebar-left-collapse / layout-sidebar-left-expand
  sidebarCollapse: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M4 4m0 2a2 2 0 0 1 2 -2h12a2 2 0 0 1 2 2v12a2 2 0 0 1 -2 2h-12a2 2 0 0 1 -2 -2z"/>
    <path d="M9 4v16"/>
    <path d="M15 10l-2 2l2 2"/>
  </svg>`,

  sidebarExpand: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M4 4m0 2a2 2 0 0 1 2 -2h12a2 2 0 0 1 2 2v12a2 2 0 0 1 -2 2h-12a2 2 0 0 1 -2 -2z"/>
    <path d="M9 4v16"/>
    <path d="M14 10l2 2l-2 2"/>
  </svg>`,

  // Tabler: menu-2
  menu: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M4 6l16 0"/>
    <path d="M4 12l16 0"/>
    <path d="M4 18l16 0"/>
  </svg>`,

  // Tabler: chevron-right
  chevron: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M9 6l6 6l-6 6"/>
  </svg>`,

  // Tabler: search
  search: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M10 10m-7 0a7 7 0 1 0 14 0a7 7 0 1 0 -14 0"/>
    <path d="M21 21l-6 -6"/>
  </svg>`,

  // Tabler: refresh
  refresh: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M20 11a8.1 8.1 0 0 0 -15.5 -2m-.5 -4v4h4"/>
    <path d="M4 13a8.1 8.1 0 0 0 15.5 2m.5 4v-4h-4"/>
  </svg>`,

  // Tabler: copy
  copy: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M7 7m0 2.667a2.667 2.667 0 0 1 2.667 -2.667h8.666a2.667 2.667 0 0 1 2.667 2.667v8.666a2.667 2.667 0 0 1 -2.667 2.667h-8.666a2.667 2.667 0 0 1 -2.667 -2.667z"/>
    <path d="M4.012 16.737a2.005 2.005 0 0 1 -1.012 -1.737v-10c0 -1.1 .9 -2 2 -2h10c.75 0 1.158 .385 1.5 1"/>
  </svg>`,

  // Tabler: folder-symlink
  move: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M3 21v-4a3 3 0 0 1 3 -3h5"/>
    <path d="M8 17l3 -3l-3 -3"/>
    <path d="M3 11v-5a2 2 0 0 1 2 -2h4l3 3h7a2 2 0 0 1 2 2v8a2 2 0 0 1 -2 2h-8"/>
  </svg>`,

  // Tabler: star
  star: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M12 17.75l-6.172 3.245l1.179 -6.873l-5 -4.867l6.9 -1l3.086 -6.253l3.086 6.253l6.9 1l-5 4.867l1.179 6.873z"/>
  </svg>`,

  // Tabler: star-filled
  starFilled: `<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M12 17.75l-6.172 3.245l1.179 -6.873l-5 -4.867l6.9 -1l3.086 -6.253l3.086 6.253l6.9 1l-5 4.867l1.179 6.873z"/>
  </svg>`,

  // Tabler: arrow-right
  arrowRight: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M5 12l14 0"/>
    <path d="M13 18l6 -6"/>
    <path d="M13 6l6 6"/>
  </svg>`,

  // Tabler: trash
  trash: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M4 7l16 0"/>
    <path d="M10 11l0 6"/>
    <path d="M14 11l0 6"/>
    <path d="M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2 -2l1 -12"/>
    <path d="M9 7v-3a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v3"/>
  </svg>`,

  // Tabler: x
  close: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M18 6l-12 12"/>
    <path d="M6 6l12 12"/>
  </svg>`
};
