/**
 * The simulated preflight demo mode answers (docs/phases/PHASE_14.md
 * workstream 4). No provider or database is touched: every photo reads as
 * a ready single product, except two cases the demo and its tests use on
 * purpose, chosen by words in the upload key:
 *
 * - "several": two products, so the chooser shows (a watch and sneakers,
 *   the evaluator's cafe photo), with the note's pick preselected when the
 *   note names one of them;
 * - "screenshot": a screenshot, so the photo blocks the pack.
 */

import { sizeNeeds } from "./result";
import { problemFor } from "./copy";
import type { PreflightItemView, PreflightView } from "./types";

const DEMO_PHOTO = { width: 3024, height: 4032 };

function thumb(label: string, fill: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160" viewBox="0 0 160 160"><rect width="160" height="160" fill="#f4f4f5"/><circle cx="80" cy="72" r="44" fill="${fill}"/><text x="80" y="146" font-family="sans-serif" font-size="14" text-anchor="middle" fill="#3f3f46">${label}</text></svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

/**
 * The demo's cutout preview (PHASE_15 P1): a product shape on a clear
 * background, so the preview strip shows a cut out product on the chosen
 * color in demo mode and e2e, as the signed preview does in db mode.
 */
const DEMO_CUTOUT_URL = `data:image/svg+xml;base64,${Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="320" viewBox="0 0 320 320"><rect x="110" y="40" width="100" height="40" rx="10" fill="#52525b"/><rect x="80" y="70" width="160" height="220" rx="28" fill="#a1a1aa"/><rect x="104" y="130" width="112" height="70" rx="8" fill="#e4e4e7"/></svg>`,
).toString("base64")}`;

const DEMO_ITEMS: PreflightItemView[] = [
  {
    number: 1,
    label: "silver watch",
    box: { x: 0.08, y: 0.3, width: 0.34, height: 0.3 },
    thumbUrl: thumb("silver watch", "#a1a1aa"),
    longSide: 1210,
  },
  {
    number: 2,
    label: "white sneakers",
    box: { x: 0.5, y: 0.45, width: 0.44, height: 0.3 },
    thumbUrl: thumb("white sneakers", "#e4e4e7"),
    longSide: 1331,
  },
];

export function demoPreflight(key: string, note?: string): PreflightView {
  const base: PreflightView = {
    key,
    status: "ready",
    found: "your product",
    problem: null,
    notice: null,
    items: [],
    preselect: null,
    photo: DEMO_PHOTO,
    productLongSide: 2400,
    sizes: sizeNeeds(),
    previewUrl: DEMO_CUTOUT_URL,
    demo: true,
  };
  const name = key.toLowerCase();
  if (name.includes("screenshot")) {
    return {
      ...base,
      status: "blocked",
      found: null,
      productLongSide: null,
      problem: problemFor("screenshot"),
      previewUrl: null,
    };
  }
  if (name.includes("several")) {
    const text = (note ?? "").toLowerCase();
    const named = DEMO_ITEMS.filter((item) => text.includes(item.label.split(" ")[1] ?? item.label));
    return {
      ...base,
      status: "choose",
      found: null,
      productLongSide: null,
      items: DEMO_ITEMS,
      preselect: named.length === 1 ? named[0].number : null,
      // The preview shows one product, so the chooser has none (as in db mode).
      previewUrl: null,
    };
  }
  return base;
}
