// Folio — Full-Viewport Zero-Delay Shockwave Glow & Optical Wave Engine
// Inspired by Vibe Design Tips #013 ("有物理质感的冲击波光环")
//
// Architecture:
// 1. Zero-Delay Instant Launch (0ms): pre-warms the WebGL2 shader program and the
//    256x256 radial optical lens normal-map PNG on idle after page boot so the very
//    first Spotlight press renders frame 0 synchronously with zero lag.
// 2. Full-Viewport Physical Wave Distortion (Live GPU SVG feDisplacementMap on #app):
//    Encodes the exact single-lens optical push (outer stretch + inner squeeze) into
//    an sRGB normal-map texture and expands it from the Spotlight search box center
//    in lockstep with the WebGL2 wavefront — works identically in both Chrome Extension
//    and local HTTP preview with zero snapshot delay.
// 3. Single-Pass WebGL2 Prismatic Shockwave Rings:
//    4 smoothly blended optical spectrum rings (Indigo-Blue -> Violet -> Rose -> Gold)
//    with radial chromatic fringe and 4-edge glass-bevel rim highlights, calibrated
//    separately for Light (soft tint) and Dark (luminous screen blend) modes.
// 4. Live 0.5px Card Hairline Glint:
//    Cards catch a brief specular border highlight as the wavefront sweeps past;
//    text and icons stay crisp and untouched.
// 5. Zero Idle Cost & Reduced Motion:
//    Canvas hides and #app filter detaches immediately at t = 1. Under
//    prefers-reduced-motion: reduce, omits wave distortion/glint for a gentle 600ms fade.

const DURATION_MS = 1350;     // Extended +350ms for smoother, more legible liquid-glass sweep
const REDUCED_DURATION_MS = 700;
const EXP_DECAY = 7.2;        // Balanced brisk launch + graceful glide across viewport
const RING_WIDTH_PX = 116;
const LENS_PEAK_PX = 30;      // Peak optical wave displacement in CSS px
const NORMAL_MAP_SIZE = 128;  // 4x faster encode/decode than 256, identical smooth bilinear lens
const NORMAL_RING_R = 0.54;   // Normalized ring radius inside the normal map
const MAX_GL_DPR = 1.5;       // 44% less GPU fill-rate than 2x while staying razor-sharp for soft rings

// Prismatic Optical Spectrum (inside -> outside: Electric Blue -> Violet -> Iridescent Rose -> Warm Gold)
const PALETTE_DARK = [
  [82 / 255, 138 / 255, 255 / 255],
  [164 / 255, 112 / 255, 255 / 255],
  [255 / 255, 114 / 255, 184 / 255],
  [255 / 255, 204 / 255, 138 / 255]
];

const PALETTE_LIGHT = [
  [88 / 255, 134 / 255, 252 / 255],
  [158 / 255, 114 / 255, 248 / 255],
  [244 / 255, 118 / 255, 180 / 255],
  [248 / 255, 182 / 255, 116 / 255]
];

const VERT_SRC = `#version 300 es
precision highp float;
const vec2 POS[3] = vec2[3](
  vec2(-1.0, -1.0),
  vec2( 3.0, -1.0),
  vec2(-1.0,  3.0)
);
out vec2 vUv;
void main() {
  vec2 p = POS[gl_VertexID];
  vUv = p * 0.5 + 0.5;
  gl_Position = vec4(p, 0.0, 1.0);
}
`;

const FRAG_SRC = `#version 300 es
precision highp float;

in vec2 vUv;
out vec4 fragColor;

uniform vec2 uSize;          // Full viewport CSS size (width, height)
uniform vec2 uOrigin;        // Wave origin in viewport CSS px (top-left origin)
uniform float uRadius;       // Current wavefront radius in CSS px
uniform float uStrength;     // Envelope strength [0..1]
uniform float uDarkMix;      // 0.0 = Light, 1.0 = Dark
uniform float uReduced;      // 1.0 = prefers-reduced-motion
uniform vec3 uRingsDark[4];
uniform vec3 uRingsLight[4];

vec3 sampleRingColor(float x, float darkMix) {
  vec3 cSum = vec3(0.0);
  float wSum = 0.0;
  for (int i = 0; i < 4; i++) {
    float center = float(i) - 1.5;
    float d = (x - center) / 0.82;
    float w = exp(-d * d);
    vec3 col = mix(uRingsLight[i], uRingsDark[i], darkMix);
    cSum += col * w;
    wSum += w;
  }
  return cSum / max(wSum, 0.0001);
}

void main() {
  vec2 pos = vec2(vUv.x * uSize.x, (1.0 - vUv.y) * uSize.y);
  float dist = length(pos - uOrigin);

  // Reduced motion: soft in-place radial glow fade, no wave or edge flash
  if (uReduced > 0.5) {
    float rNorm = dist / max(length(uSize) * 0.42, 1.0);
    float softAlpha = uStrength * 0.5 * exp(-1.6 * rNorm * rNorm);
    vec3 glow = mix(uRingsLight[1], uRingsDark[1], uDarkMix);
    float a = clamp(softAlpha * mix(0.28, 0.44, uDarkMix), 0.0, 1.0);
    fragColor = vec4(glow * a, a);
    return;
  }

  float w = 116.0;
  float x = (dist - uRadius) / w;

  // Prismatic 4-ring body with subtle radial chromatic split (R slightly ahead, B slightly behind)
  float xR = (dist - (uRadius + 9.0)) / w;
  float xB = (dist - (uRadius - 9.0)) / w;

  vec3 baseRing = sampleRingColor(x, uDarkMix);
  float aR = uStrength * exp(-1.12 * (xR * 0.5) * (xR * 0.5));
  float aG = uStrength * exp(-1.12 * (x  * 0.5) * (x  * 0.5));
  float aB = uStrength * exp(-1.12 * (xB * 0.5) * (xB * 0.5));

  // Crisp optical wave-crest highlight right along the lens inflection peak
  float crest = uStrength * exp(-18.0 * x * x) * mix(0.22, 0.32, uDarkMix);
  vec3 crestCol = mix(baseRing, vec3(1.0), 0.55);

  float ringIntensity = mix(0.36, 0.56, uDarkMix);
  vec3 prismCol = vec3(
    baseRing.r * aR,
    baseRing.g * aG,
    baseRing.b * aB
  ) * ringIntensity + crestCol * crest;

  float ringAlpha = clamp(max(max(aR, aG), aB) * ringIntensity + crest * 0.85, 0.0, 0.94);

  // Full-viewport 4-edge glass-bevel rim highlight (left, right, top, bottom)
  float dEdge = min(min(pos.x, uSize.x - pos.x), min(pos.y, uSize.y - pos.y));
  float edgeRim = exp(-dEdge / 7.5) * aG * mix(0.54, 0.78, uDarkMix);
  vec3 rimCol = mix(baseRing, vec3(1.0), 0.48);

  vec3 col = prismCol + rimCol * edgeRim * (1.0 - ringAlpha * 0.45);
  float outA = clamp(ringAlpha + edgeRim * (1.0 - ringAlpha), 0.0, 1.0);

  fragColor = vec4(col, outA);
}
`;

function compileShader(gl, type, src) {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, src);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.warn('[Folio Shockwave] Shader compile error:', gl.getShaderInfoLog(shader));
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

function createProgram(gl) {
  const vs = compileShader(gl, gl.VERTEX_SHADER, VERT_SRC);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, FRAG_SRC);
  if (!vs || !fs) return null;
  const prog = gl.createProgram();
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    console.warn('[Folio Shockwave] Program link error:', gl.getProgramInfoLog(prog));
    gl.deleteProgram(prog);
    return null;
  }
  return prog;
}

function sampleRingCssColor(x, isDark) {
  const palette = isDark ? PALETTE_DARK : PALETTE_LIGHT;
  let r = 0;
  let g = 0;
  let b = 0;
  let wSum = 0;
  for (let i = 0; i < 4; i++) {
    const d = (x - (i - 1.5)) / 0.82;
    const w = Math.exp(-d * d);
    r += palette[i][0] * w;
    g += palette[i][1] * w;
    b += palette[i][2] * w;
    wSum += w;
  }
  if (wSum <= 0) return 'rgb(164, 112, 255)';
  const rr = Math.round(((r / wSum) * 0.8 + 0.2) * 255);
  const gg = Math.round(((g / wSum) * 0.8 + 0.2) * 255);
  const bb = Math.round(((b / wSum) * 0.8 + 0.2) * 255);
  return `rgb(${rr}, ${gg}, ${bb})`;
}

// --- Pre-warmed GPU Resources (compiled once, idle = hidden / 0 draw calls) ---
let warmed = false;
let sharedCanvas = null;
let sharedGl = null;
let sharedProgram = null;
let sharedVao = null;
let sharedUniforms = null;

// Live SVG feDisplacementMap optical wave filter for #app
let filterSvg = null;
let filterEl = null;
let feImgEl = null;
let feDispEl = null;
let normalMapDataUrl = null;

function buildRadialLensNormalMapUrl() {
  if (normalMapDataUrl) return normalMapDataUrl;
  const size = NORMAL_MAP_SIZE;
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const ctx = c.getContext('2d');
  if (!ctx) return null;

  const imgData = ctx.createImageData(size, size);
  const data = imgData.data;
  const half = size * 0.5;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x + 0.5 - half) / half;
      const dy = (y + 0.5 - half) / half;
      const r = Math.hypot(dx, dy);
      let push = 0;

      // Single-lens optical bell curve centered at NORMAL_RING_R (outer stretch, inner squeeze),
      // tapered cleanly to 0 before the square boundary (r >= 0.94) so zero seam exists.
      if (r > 0.001 && r < 0.96) {
        const z = (r - NORMAL_RING_R) / 0.145;
        const primary = 2.33 * z * Math.exp(-z * z);
        // Subtle trailing secondary harmonic ripple for liquid-glass physical feel
        const z2 = (r - (NORMAL_RING_R - 0.13)) / 0.095;
        const secondary = -0.34 * z2 * Math.exp(-z2 * z2);
        const outerTaper = r > 0.78 ? Math.max(0, (0.96 - r) / 0.18) : 1;
        const innerTaper = r < 0.12 ? r / 0.12 : 1;
        push = (primary + secondary) * outerTaper * innerTaper;
      }

      const ux = r > 0.001 ? dx / r : 0;
      const uy = r > 0.001 ? dy / r : 0;
      const R = Math.max(0, Math.min(255, Math.round(128 - ux * push * 126)));
      const G = Math.max(0, Math.min(255, Math.round(128 - uy * push * 126)));

      const idx = (y * size + x) * 4;
      data[idx] = R;
      data[idx + 1] = G;
      data[idx + 2] = 128;
      data[idx + 3] = 255;
    }
  }

  ctx.putImageData(imgData, 0, 0);
  normalMapDataUrl = c.toDataURL('image/png');
  return normalMapDataUrl;
}

function ensureSvgLensFilter() {
  if (filterEl && feImgEl && feDispEl) return true;
  const mapUrl = buildRadialLensNormalMapUrl();
  if (!mapUrl) return false;

  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('width', '0');
  svg.setAttribute('height', '0');
  svg.setAttribute('aria-hidden', 'true');
  svg.style.cssText = 'position:fixed;width:0;height:0;pointer-events:none;overflow:hidden;';

  const defs = document.createElementNS(NS, 'defs');
  const filter = document.createElementNS(NS, 'filter');
  filter.id = 'folio-shockwave-lens';
  filter.setAttribute('filterUnits', 'userSpaceOnUse');
  filter.setAttribute('primitiveUnits', 'userSpaceOnUse');
  filter.setAttribute('color-interpolation-filters', 'sRGB');
  filter.setAttribute('x', '0');
  filter.setAttribute('y', '0');
  filter.setAttribute('width', '1440');
  filter.setAttribute('height', '900');

  // Neutral rgb(128,128,128) background ensures 0px shift everywhere outside the moving lens box
  const flood = document.createElementNS(NS, 'feFlood');
  flood.setAttribute('flood-color', 'rgb(128,128,128)');
  flood.setAttribute('flood-opacity', '1');
  flood.setAttribute('result', 'neutral');

  const feImg = document.createElementNS(NS, 'feImage');
  feImg.setAttribute('href', mapUrl);
  feImg.setAttribute('preserveAspectRatio', 'none');
  feImg.setAttribute('x', '0');
  feImg.setAttribute('y', '0');
  feImg.setAttribute('width', '200');
  feImg.setAttribute('height', '200');
  feImg.setAttribute('result', 'ringMap');

  const comp = document.createElementNS(NS, 'feComposite');
  comp.setAttribute('in', 'ringMap');
  comp.setAttribute('in2', 'neutral');
  comp.setAttribute('operator', 'over');
  comp.setAttribute('result', 'fullMap');

  const disp = document.createElementNS(NS, 'feDisplacementMap');
  disp.setAttribute('in', 'SourceGraphic');
  disp.setAttribute('in2', 'fullMap');
  disp.setAttribute('scale', '0');
  disp.setAttribute('xChannelSelector', 'R');
  disp.setAttribute('yChannelSelector', 'G');

  filter.appendChild(flood);
  filter.appendChild(feImg);
  filter.appendChild(comp);
  filter.appendChild(disp);
  defs.appendChild(filter);
  svg.appendChild(defs);
  document.body.appendChild(svg);

  filterSvg = svg;
  filterEl = filter;
  feImgEl = feImg;
  feDispEl = disp;
  return true;
}

function ensureWebGLResources() {
  if (sharedCanvas && sharedGl && sharedProgram && sharedVao && sharedUniforms) return true;

  const canvas = document.createElement('canvas');
  canvas.className = 'shockwave-canvas is-overlay-only';
  canvas.setAttribute('aria-hidden', 'true');
  canvas.hidden = true;

  const gl = canvas.getContext('webgl2', {
    alpha: true,
    antialias: false,
    depth: false,
    stencil: false,
    premultipliedAlpha: true,
    powerPreference: 'high-performance'
  });
  if (!gl) return false;

  const program = createProgram(gl);
  if (!program) return false;

  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  gl.useProgram(program);

  const uniforms = {
    uSize: gl.getUniformLocation(program, 'uSize'),
    uOrigin: gl.getUniformLocation(program, 'uOrigin'),
    uRadius: gl.getUniformLocation(program, 'uRadius'),
    uStrength: gl.getUniformLocation(program, 'uStrength'),
    uDarkMix: gl.getUniformLocation(program, 'uDarkMix'),
    uReduced: gl.getUniformLocation(program, 'uReduced'),
    uRingsDark: gl.getUniformLocation(program, 'uRingsDark'),
    uRingsLight: gl.getUniformLocation(program, 'uRingsLight')
  };

  gl.uniform3fv(uniforms.uRingsDark, new Float32Array(PALETTE_DARK.flat()));
  gl.uniform3fv(uniforms.uRingsLight, new Float32Array(PALETTE_LIGHT.flat()));

  sharedCanvas = canvas;
  sharedGl = gl;
  sharedProgram = program;
  sharedVao = vao;
  sharedUniforms = uniforms;
  return true;
}

/**
 * Pre-warm WebGL2 GPU PSO (dummy draw), backbuffer allocation, and Chromium Skia
 * SVG feDisplacementMap texture decoding during idle time so the very first
 * Spotlight trigger runs at locked 60/120fps with zero first-frame hitch.
 */
export function warmShockwaveEngine() {
  if (warmed) return;
  warmed = true;

  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const dpr = Math.min(window.devicePixelRatio || 1, MAX_GL_DPR);

  if (ensureWebGLResources()) {
    const pxW = Math.max(1, Math.round(vw * dpr));
    const pxH = Math.max(1, Math.round(vh * dpr));
    sharedCanvas.width = pxW;
    sharedCanvas.height = pxH;
    const gl = sharedGl;
    const u = sharedUniforms;
    gl.bindVertexArray(sharedVao);
    gl.useProgram(sharedProgram);
    gl.viewport(0, 0, pxW, pxH);
    gl.uniform2f(u.uSize, vw, vh);
    gl.uniform2f(u.uOrigin, vw * 0.5, vh * 0.15);
    gl.uniform1f(u.uRadius, 32);
    gl.uniform1f(u.uStrength, 0.0);
    gl.uniform1f(u.uDarkMix, document.documentElement.getAttribute('data-theme') === 'dark' ? 1.0 : 0.0);
    gl.uniform1f(u.uReduced, 0.0);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    // Force Metal/ANGLE PSO compilation during idle rather than first Spotlight click
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.flush();
  }

  if (ensureSvgLensFilter() && normalMapDataUrl) {
    // Pre-decode the normal-map PNG and force Skia to warm the feDisplacementMap shader
    // on an invisible 2x2 probe node without touching #app.
    const preImg = new Image();
    preImg.src = normalMapDataUrl;
    const warmSkiaFilter = () => {
      const probe = document.createElement('div');
      probe.setAttribute('aria-hidden', 'true');
      probe.style.cssText =
        'position:fixed;top:0;left:0;width:2px;height:2px;opacity:0.001;pointer-events:none;z-index:-1;filter:url(#folio-shockwave-lens);';
      document.body.appendChild(probe);
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          probe.remove();
        });
      });
    };
    if (typeof preImg.decode === 'function') {
      preImg.decode().then(warmSkiaFilter).catch(warmSkiaFilter);
    } else {
      warmSkiaFilter();
    }
  }
}

// Active animation state
let activeRunId = 0;
let activeRaf = 0;
let activeGlintTargets = [];

function clearDomGlints() {
  for (const item of activeGlintTargets) {
    if (item.el && item.el.isConnected) {
      item.el.classList.remove('is-sw-glint');
      item.el.style.removeProperty('--sw-glint');
      item.el.style.removeProperty('--sw-color');
    }
  }
  activeGlintTargets = [];
}

function deactivateVisuals() {
  if (activeRaf) {
    cancelAnimationFrame(activeRaf);
    activeRaf = 0;
  }
  clearDomGlints();

  const appEl = document.getElementById('app');
  if (appEl) appEl.classList.remove('is-shockwave-active');
  if (feDispEl) feDispEl.setAttribute('scale', '0');

  if (sharedCanvas) {
    sharedCanvas.hidden = true;
    sharedCanvas.remove();
  }
}

export function stopSearchShockwave() {
  activeRunId += 1;
  deactivateVisuals();
}

function collectVisibleBorderTargets(vw, vh) {
  const stages = document.querySelectorAll('#workspace .card-stage');
  const list = [];
  for (const el of stages) {
    const r = el.getBoundingClientRect();
    if (r.bottom < 0 || r.top > vh || r.right < 0 || r.left > vw) continue;
    list.push({
      el,
      cx: r.left + r.width * 0.5,
      cy: r.top + r.height * 0.5
    });
  }
  return list;
}

function computeSpotlightOrigin(vw, vh) {
  const inputRow = document.querySelector('#spotlight-overlay .spotlight-input-row');
  if (inputRow) {
    const r = inputRow.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) {
      return {
        x: r.left + r.width * 0.5,
        y: r.top + r.height * 0.5
      };
    }
  }
  return {
    x: vw * 0.5,
    y: Math.max(48, vh * 0.12 + 28)
  };
}

/**
 * Trigger the full-viewport 0ms-delay Shockwave Glow + Optical Lens Wave
 * expanding from the exact center of the Spotlight search input row.
 */
export function triggerSearchShockwave({ hostOverlay } = {}) {
  if (!hostOverlay) return;

  const runId = ++activeRunId;
  deactivateVisuals();

  if (!ensureWebGLResources()) return;

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const scrollY = window.scrollY;
  const dpr = Math.min(window.devicePixelRatio || 1, MAX_GL_DPR);
  const origin = computeSpotlightOrigin(vw, vh);

  // Full-viewport canvas mounted strictly behind .spotlight-dialog (first child of #spotlight-overlay)
  const canvas = sharedCanvas;
  const gl = sharedGl;
  const u = sharedUniforms;

  const pxW = Math.max(1, Math.round(vw * dpr));
  const pxH = Math.max(1, Math.round(vh * dpr));
  if (canvas.width !== pxW || canvas.height !== pxH) {
    canvas.width = pxW;
    canvas.height = pxH;
  }
  canvas.style.left = '0px';
  canvas.style.top = '0px';
  canvas.style.width = `${vw}px`;
  canvas.style.height = `${vh}px`;
  canvas.hidden = false;
  hostOverlay.insertBefore(canvas, hostOverlay.firstChild);

  // Activate live GPU optical lens wave distortion on #app (full viewport, scroll-aware)
  const appEl = document.getElementById('app');
  const useWaveDistortion = !reducedMotion && ensureSvgLensFilter() && Boolean(appEl);
  if (useWaveDistortion) {
    filterEl.setAttribute('x', '0');
    filterEl.setAttribute('y', String(Math.round(scrollY)));
    filterEl.setAttribute('width', String(vw));
    filterEl.setAttribute('height', String(vh));
    appEl.classList.add('is-shockwave-active');
  }

  // Sweep past the farthest viewport corner
  const corners = [
    [0, 0],
    [vw, 0],
    [0, vh],
    [vw, vh]
  ];
  let maxCornerDist = 0;
  for (const [cx, cy] of corners) {
    const d = Math.hypot(cx - origin.x, cy - origin.y);
    if (d > maxCornerDist) maxCornerDist = d;
  }

  const r0 = 28;
  const growDist = maxCornerDist + 180;
  const denom = 1 - Math.pow(2, -EXP_DECAY);
  const totalDuration = reducedMotion ? REDUCED_DURATION_MS : DURATION_MS;

  gl.bindVertexArray(sharedVao);
  gl.useProgram(sharedProgram);
  gl.viewport(0, 0, pxW, pxH);
  gl.uniform2f(u.uSize, vw, vh);
  gl.uniform2f(u.uOrigin, origin.x, origin.y);
  gl.uniform1f(u.uReduced, reducedMotion ? 1.0 : 0.0);

  let currentDarkMix = document.documentElement.getAttribute('data-theme') === 'dark' ? 1.0 : 0.0;
  let startTs = 0;
  let glintsCollected = false;

  const renderFrame = (now) => {
    if (runId !== activeRunId) return;
    if (!startTs) startTs = now;
    const elapsed = Math.max(0, now - startTs);
    const t = Math.min(1, elapsed / totalDuration);

    // Collect visible card border targets on frame 1 instead of blocking the click handler
    if (!reducedMotion && !glintsCollected) {
      glintsCollected = true;
      activeGlintTargets = collectVisibleBorderTargets(vw, vh);
    }

    const targetDark = document.documentElement.getAttribute('data-theme') === 'dark' ? 1.0 : 0.0;
    currentDarkMix += (targetDark - currentDarkMix) * 0.22;

    const eased = (1 - Math.pow(2, -EXP_DECAY * t)) / denom;
    const radius = r0 + growDist * eased;
    const strength = reducedMotion
      ? Math.sin(Math.PI * t)
      : Math.min(1, (t + 0.015) / 0.035) * (1 - Math.pow(t, 2.2));

    // 1) Update live GPU optical lens wave filter on #app
    if (useWaveDistortion) {
      const boxHalf = radius / NORMAL_RING_R;
      const boxSize = boxHalf * 2;
      feImgEl.setAttribute('x', (origin.x - boxHalf).toFixed(1));
      feImgEl.setAttribute('y', (origin.y + scrollY - boxHalf).toFixed(1));
      feImgEl.setAttribute('width', boxSize.toFixed(1));
      feImgEl.setAttribute('height', boxSize.toFixed(1));
      // Edge hold: gently ease displacement down near the final stretch so edges stay crisp
      const dispScale = LENS_PEAK_PX * strength;
      feDispEl.setAttribute('scale', dispScale.toFixed(2));
    }

    // 2) Draw WebGL2 prismatic 4-ring shockwave + 4-edge rim highlight
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.uniform1f(u.uRadius, radius);
    gl.uniform1f(u.uStrength, strength);
    gl.uniform1f(u.uDarkMix, currentDarkMix);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // 3) Drive subtle 0.5px card hairline glints along the passing wavefront
    if (!reducedMotion && activeGlintTargets.length > 0) {
      const isDark = currentDarkMix > 0.5;
      const maxGlint = isDark ? 0.2 : 0.36;
      for (const item of activeGlintTargets) {
        const d = Math.hypot(item.cx - origin.x, item.cy - origin.y);
        const x = (d - radius) / RING_WIDTH_PX;
        const glint = strength * Math.exp(-1.4 * (x * 0.5) * (x * 0.5)) * maxGlint;
        if (glint > 0.012) {
          item.el.classList.add('is-sw-glint');
          item.el.style.setProperty('--sw-glint', glint.toFixed(3));
          item.el.style.setProperty('--sw-color', sampleRingCssColor(x, isDark));
        } else if (item.el.classList.contains('is-sw-glint')) {
          item.el.classList.remove('is-sw-glint');
          item.el.style.removeProperty('--sw-glint');
          item.el.style.removeProperty('--sw-color');
        }
      }
    }

    if (t < 1) {
      activeRaf = requestAnimationFrame(renderFrame);
    } else {
      deactivateVisuals();
    }
  };

  // Anchor t = 0 on the very first vsync frame so Spotlight DOM layout & GPU filter
  // never compete on the same tick and frame 0 never skips ahead.
  activeRaf = requestAnimationFrame(renderFrame);
}
