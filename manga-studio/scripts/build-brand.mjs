/**
 * Kumanga brand mark — one geometry, every variant.
 *
 * The mark is a RECONSTRUCTION of the approved reference artwork: black bear
 * head, white muzzle and eyes, small outlined manga speech bubble at the lower
 * right with a gap where it crosses the head.
 *
 * It is built as a single-colour silhouette with holes rather than as stacked
 * black-and-white shapes, so the face reads as the surface behind it. That is
 * what lets one mark work on a dark toolbar, a light tile and a favicon without
 * three different drawings drifting apart.
 *
 * Run: node scripts/build-brand.mjs
 */

import { writeFileSync } from "node:fs";

// ─── Geometry (viewBox 0 0 64 64) ───────────────────────────────────────────

/** Squircle, not an ellipse: the reference head has flat cheeks. */
function squircle(cx, cy, rx, ry, k = 0.72) {
  const hx = rx * k;
  const hy = ry * k;
  return [
    `M ${cx} ${cy - ry}`,
    `C ${cx + hx} ${cy - ry} ${cx + rx} ${cy - hy} ${cx + rx} ${cy}`,
    `C ${cx + rx} ${cy + hy} ${cx + hx} ${cy + ry} ${cx} ${cy + ry}`,
    `C ${cx - hx} ${cy + ry} ${cx - rx} ${cy + hy} ${cx - rx} ${cy}`,
    `C ${cx - rx} ${cy - hy} ${cx - hx} ${cy - ry} ${cx} ${cy - ry}`,
    "Z",
  ].join(" ");
}

const HEAD = squircle(25, 33.5, 21, 19.5);
const EAR_L = { cx: 12.2, cy: 15.4, r: 8.7 };
const EAR_R = { cx: 37.8, cy: 15.4, r: 8.7 };
const EYE_L = { cx: 17.6, cy: 29.5, rx: 3.1, ry: 4.1 };
const EYE_R = { cx: 32.4, cy: 29.5, rx: 3.1, ry: 4.1 };
const MUZZLE = { cx: 25, cy: 41.5, rx: 9.4, ry: 6.6 };
const NOSE = { cx: 25, cy: 38.9, rx: 3.3, ry: 2.5 };

/** Bubble body and its tail, as two shapes unioned by painting both. */
const BUBBLE = "M 43 32.5 H 55 A 5 5 0 0 1 60 37.5 V 45.5 A 5 5 0 0 1 55 50.5 H 43 A 5 5 0 0 1 38 45.5 V 37.5 A 5 5 0 0 1 43 32.5 Z";
const TAIL = "M 42.6 47 L 38.4 57.4 L 49.4 50.4 Z";
const BUBBLE_HOLE = "M 44.2 36.4 H 53.8 A 2.6 2.6 0 0 1 56.4 39 V 44 A 2.6 2.6 0 0 1 53.8 46.6 H 44.2 A 2.6 2.6 0 0 1 41.6 44 V 39 A 2.6 2.6 0 0 1 44.2 36.4 Z";

/** How far the bear is cut back around the bubble, in units of stroke width. */
const GAP = 5.4;

/**
 * The mask IS the mark: white paints ink, black punches a hole. Painting order
 * is the drawing order — head, then face holes, then the nose back in, then the
 * bubble gap, then the bubble.
 */
function maskBody() {
  return `
    <path d="${HEAD}" fill="#fff"/>
    <circle cx="${EAR_L.cx}" cy="${EAR_L.cy}" r="${EAR_L.r}" fill="#fff"/>
    <circle cx="${EAR_R.cx}" cy="${EAR_R.cy}" r="${EAR_R.r}" fill="#fff"/>
    <ellipse cx="${EYE_L.cx}" cy="${EYE_L.cy}" rx="${EYE_L.rx}" ry="${EYE_L.ry}" fill="#000"/>
    <ellipse cx="${EYE_R.cx}" cy="${EYE_R.cy}" rx="${EYE_R.rx}" ry="${EYE_R.ry}" fill="#000"/>
    <ellipse cx="${MUZZLE.cx}" cy="${MUZZLE.cy}" rx="${MUZZLE.rx}" ry="${MUZZLE.ry}" fill="#000"/>
    <ellipse cx="${NOSE.cx}" cy="${NOSE.cy}" rx="${NOSE.rx}" ry="${NOSE.ry}" fill="#fff"/>
    <g fill="#000" stroke="#000" stroke-width="${GAP}" stroke-linejoin="round">
      <path d="${BUBBLE}"/>
      <path d="${TAIL}"/>
    </g>
    <path d="${BUBBLE}" fill="#fff"/>
    <path d="${TAIL}" fill="#fff"/>
    <path d="${BUBBLE_HOLE}" fill="#000"/>`;
}

/**
 * Favicon geometry: the same bear, without the bubble.
 *
 * At 16px the bubble's 2.6-unit ring is a third of a pixel — it turns to mud and
 * drags the head off-centre with it. Dropping it keeps the silhouette the
 * browser tab actually shows readable, which is the identity that matters there.
 */
function maskBodyCompact() {
  return `
    <path d="${squircle(32, 34, 24, 22.5)}" fill="#fff"/>
    <circle cx="${14}" cy="${14.5}" r="10" fill="#fff"/>
    <circle cx="${50}" cy="${14.5}" r="10" fill="#fff"/>
    <ellipse cx="22" cy="29.5" rx="3.7" ry="4.9" fill="#000"/>
    <ellipse cx="42" cy="29.5" rx="3.7" ry="4.9" fill="#000"/>
    <ellipse cx="32" cy="43" rx="11" ry="7.8" fill="#000"/>
    <ellipse cx="32" cy="40" rx="4" ry="3" fill="#fff"/>`;
}

function mark(ink, { compact = false, id = "km" } = {}) {
  const body = compact ? maskBodyCompact() : maskBody();
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none" role="img" aria-label="Kumanga">
  <mask id="${id}" maskUnits="userSpaceOnUse" x="0" y="0" width="64" height="64">${body}
  </mask>
  <rect width="64" height="64" fill="${ink}" mask="url(#${id})"/>
</svg>
`;
}

/** Favicon: the mark on the brand tile, so the tab reads as an app icon. */
function tile(bg, ink, radius) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="Kumanga">
  <mask id="kmf" maskUnits="userSpaceOnUse" x="0" y="0" width="64" height="64">${maskBodyCompact()}
  </mask>
  <rect width="64" height="64" rx="${radius}" fill="${bg}"/>
  <g transform="translate(32 32) scale(0.76) translate(-32 -32)">
    <rect width="64" height="64" fill="${ink}" mask="url(#kmf)"/>
  </g>
</svg>
`;
}

const INK_DARK = "#18181b";
const INK_LIGHT = "#fafafa";
const FONT = "Inter, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";

function wordmark(ink, sub) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 76" fill="none" role="img" aria-label="Kumanga — AI Manga Studio">
  <mask id="kmw" maskUnits="userSpaceOnUse" x="0" y="0" width="64" height="64">${maskBody()}
  </mask>
  <g transform="translate(0 6)">
    <rect width="64" height="64" fill="${ink}" mask="url(#kmw)"/>
  </g>
  <text x="82" y="42" font-family="${FONT}" font-size="38" font-weight="800" letter-spacing="-1" fill="${ink}">Kumanga</text>
  <text x="84" y="62" font-family="${FONT}" font-size="12.5" font-weight="600" letter-spacing="4.4" fill="${sub}">AI MANGA STUDIO</text>
</svg>
`;
}

const out = {
  "public/brand/kumanga-mark.svg": mark(INK_DARK, { id: "km-light" }),
  "public/brand/kumanga-mark-dark.svg": mark(INK_LIGHT, { id: "km-dark" }),
  "public/brand/kumanga-wordmark.svg": wordmark(INK_DARK, "#52525b"),
  "public/brand/kumanga-wordmark-dark.svg": wordmark(INK_LIGHT, "#a1a1aa"),
  "src/app/icon.svg": tile("#18181b", INK_LIGHT, 13),
  "public/brand/kumanga-icon.svg": tile("#18181b", INK_LIGHT, 13),
  "public/brand/kumanga-mark-compact.svg": mark(INK_DARK, { compact: true, id: "km-compact" }),
};

for (const [path, svg] of Object.entries(out)) {
  writeFileSync(path, svg);
  console.log("wrote", path);
}
