/**
 * Inline SVG demo imagery for the marketing site. Everything is drawn in
 * code so the site ships with zero binary assets and zero external requests.
 * These are illustrations of the before and after format, not real results,
 * and every page that shows them labels them as such (see
 * isIllustrationSrc). Real sample packs replace them once there are product
 * photos Curvi has the rights to show.
 */

/** The label shown on any image drawn in code rather than produced by Curvi. */
export const ILLUSTRATION_LABEL = "Illustration";

const SVG_DATA_URI_PREFIX = "data:image/svg+xml";

export function svgDataUri(svg: string): string {
  return `${SVG_DATA_URI_PREFIX};charset=utf-8,${encodeURIComponent(svg)}`;
}

/** True for images drawn in code, which must never be presented as real outputs. */
export function isIllustrationSrc(src: string): boolean {
  return src.startsWith(SVG_DATA_URI_PREFIX);
}

/** The same bottle shape is used in both demo frames so the product pixels visibly match. */
function bottle(fill: string, capFill: string, labelStroke: string): string {
  return `
    <g>
      <rect x="272" y="120" width="56" height="60" rx="10" fill="${capFill}"/>
      <path d="M276 176 L324 176 L338 232 L338 448 Q338 472 314 472 L286 472 Q262 472 262 448 L262 232 Z" fill="${fill}"/>
      <rect x="270" y="264" width="60" height="132" rx="8" fill="#ffffff" stroke="${labelStroke}" stroke-width="2"/>
      <rect x="280" y="284" width="40" height="8" rx="3" fill="#384153"/>
      <rect x="280" y="302" width="40" height="5" rx="2" fill="#8494ad"/>
      <rect x="280" y="314" width="32" height="5" rx="2" fill="#8494ad"/>
      <rect x="280" y="326" width="36" height="5" rx="2" fill="#8494ad"/>
      <rect x="280" y="352" width="40" height="26" rx="4" fill="#ec4899"/>
    </g>`;
}

/** A messy home photo look: colored cast, clutter, hard shadow, vignette. */
export const beforeDemoImage = svgDataUri(`<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600" viewBox="0 0 600 600">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#c9b8a1"/>
      <stop offset="0.55" stop-color="#a89478"/>
      <stop offset="1" stop-color="#7d6a52"/>
    </linearGradient>
    <radialGradient id="vig" cx="0.5" cy="0.45" r="0.75">
      <stop offset="0.6" stop-color="#000000" stop-opacity="0"/>
      <stop offset="1" stop-color="#000000" stop-opacity="0.45"/>
    </radialGradient>
  </defs>
  <rect width="600" height="600" fill="url(#bg)"/>
  <rect x="0" y="430" width="600" height="170" fill="#6b5a45"/>
  <ellipse cx="150" cy="470" rx="110" ry="26" fill="#514336"/>
  <rect x="60" y="330" width="120" height="140" rx="8" fill="#8a7a63" transform="rotate(-8 120 400)"/>
  <rect x="440" y="300" width="90" height="170" rx="10" fill="#94826a" transform="rotate(6 485 385)"/>
  <circle cx="500" cy="150" r="60" fill="#b3a186" opacity="0.7"/>
  <path d="M330 470 L520 500 L510 520 L330 486 Z" fill="#3f342a" opacity="0.55"/>
  ${bottle("#5c8aa6", "#31586f", "#d3d9e3")}
  <rect width="600" height="600" fill="url(#vig)"/>
  <rect width="600" height="600" fill="#8a6f3f" opacity="0.14"/>
</svg>`);

/** The studio result look: pure white sweep, soft contact shadow, same bottle. */
export const afterDemoImage = svgDataUri(`<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600" viewBox="0 0 600 600">
  <rect width="600" height="600" fill="#ffffff"/>
  <ellipse cx="300" cy="484" rx="120" ry="18" fill="#131826" opacity="0.10"/>
  ${bottle("#5c8aa6", "#31586f", "#e9ecf1")}
</svg>`);

export interface GalleryCase {
  slug: string;
  title: string;
  category: string;
  before: string;
  after: string;
}

function caseBefore(hueBg: string, hueBg2: string, product: string, cap: string): string {
  return svgDataUri(`<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400" viewBox="0 0 600 600">
    <defs>
      <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="${hueBg}"/>
        <stop offset="1" stop-color="${hueBg2}"/>
      </linearGradient>
      <radialGradient id="v" cx="0.5" cy="0.4" r="0.8">
        <stop offset="0.55" stop-color="#000" stop-opacity="0"/>
        <stop offset="1" stop-color="#000" stop-opacity="0.4"/>
      </radialGradient>
    </defs>
    <rect width="600" height="600" fill="url(#g)"/>
    <rect x="40" y="360" width="140" height="130" rx="10" fill="#000" opacity="0.15" transform="rotate(-7 110 425)"/>
    <rect x="430" y="330" width="110" height="160" rx="10" fill="#000" opacity="0.12" transform="rotate(5 485 410)"/>
    ${bottle(product, cap, "#d3d9e3")}
    <rect width="600" height="600" fill="url(#v)"/>
  </svg>`);
}

function caseAfter(product: string, cap: string): string {
  return svgDataUri(`<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400" viewBox="0 0 600 600">
    <rect width="600" height="600" fill="#ffffff"/>
    <ellipse cx="300" cy="484" rx="118" ry="17" fill="#131826" opacity="0.10"/>
    ${bottle(product, cap, "#e9ecf1")}
  </svg>`);
}

export const galleryCases: GalleryCase[] = [
  { slug: "demo-serum", title: "Face serum, kitchen table to studio", category: "Beauty", before: caseBefore("#c9b8a1", "#7d6a52", "#5c8aa6", "#31586f"), after: caseAfter("#5c8aa6", "#31586f") },
  { slug: "demo-hot-sauce", title: "Hot sauce, garage shelf to studio", category: "Food", before: caseBefore("#b3a58e", "#6f5f49", "#b0532f", "#7c3316"), after: caseAfter("#b0532f", "#7c3316") },
  { slug: "demo-supplement", title: "Supplement jar, desk photo to studio", category: "Health", before: caseBefore("#a9b3bd", "#5d6a77", "#3f6f52", "#274734"), after: caseAfter("#3f6f52", "#274734") },
  { slug: "demo-candle", title: "Candle, windowsill to studio", category: "Home", before: caseBefore("#c4b49f", "#8a7a63", "#8a6796", "#5b3f66"), after: caseAfter("#8a6796", "#5b3f66") },
  { slug: "demo-dog-shampoo", title: "Dog shampoo, bathroom to studio", category: "Pet", before: caseBefore("#b9c2c9", "#6e7a84", "#c78a2e", "#8a5c17"), after: caseAfter("#c78a2e", "#8a5c17") },
  { slug: "demo-cold-brew", title: "Cold brew bottle, counter to studio", category: "Beverage", before: caseBefore("#c2ab92", "#75604a", "#4a4038", "#2b2520"), after: caseAfter("#4a4038", "#2b2520") },
];
