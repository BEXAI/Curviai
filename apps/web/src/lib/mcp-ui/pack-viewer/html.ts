/**
 * The pack viewer as one self contained HTML document (PHASE_19 P19-19): an
 * inline style and an inline script, system fonts, no external script,
 * stylesheet or font, and no URL but the site origin's, which the script uses
 * only to check links. The script is built from the source of the self
 * contained functions in ./state.ts, ./render.ts and ./runtime.ts, so the
 * code tested in Node is the code the browser runs; the copy and settings go
 * in as JSON. About 50 KB at most (html.test.ts holds the budget).
 */

import { PACK_VIEWER_COPY } from "./copy";
import { renderPackViewer } from "./render";
import { startPackViewer, type ViewerConfig } from "./runtime";
import { initialViewerState, reduceViewer, viewerViewOf } from "./state";

/** MCP Apps protocol version the viewer speaks (ext-apps LATEST_PROTOCOL_VERSION). */
export const MCP_APPS_PROTOCOL_VERSION = "2026-01-26";

/** The viewer's settings, beside the origin (PHASE_19 "Long running packs":
 * get_pack every 5 seconds, for at most 30 minutes; O11: 3 to 8 carousel
 * items). */
export const PACK_VIEWER_SETTINGS: Omit<ViewerConfig, "origin"> = {
  tool: "get_pack",
  pollMs: 5_000,
  pollCapMs: 30 * 60_000,
  maxPollErrors: 3,
  requestTimeoutMs: 30_000,
  tickMs: 60_000,
  maxCarousel: 8,
  protocolVersion: MCP_APPS_PROTOCOL_VERSION,
  appName: "curvi-pack-viewer",
  appVersion: "1",
};

/** The size budget, in bytes (PHASE_19 P19-19). */
export const PACK_VIEWER_MAX_BYTES = 50_000;

/** JSON that is safe inside a script element: no "</script", no comment
 * openers and no line separators that end a JavaScript string. */
export function scriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/** The viewer's script: the embedded functions, then the start call. */
export function packViewerScript(config: ViewerConfig): string {
  const lib = [
    `initial:(${initialViewerState.toString()})`,
    `reduce:(${reduceViewer.toString()})`,
    `view:(${viewerViewOf.toString()})`,
    `render:(${renderPackViewer.toString()})`,
  ].join(",");
  return `(function(){"use strict";var lib={${lib}};(${startPackViewer.toString()})(window,lib,${scriptJson(PACK_VIEWER_COPY)},${scriptJson(config)});})();`;
}

const STYLE = `
:root{color-scheme:light dark;--bg:var(--color-background-primary,#ffffff);--fg:var(--color-text-primary,#171717);--muted:var(--color-text-secondary,#5d5d5d);--line:var(--color-border-primary,#e3e3e3);--tile:var(--color-background-secondary,#f6f6f6);--danger:var(--color-text-danger,#b42318);--radius:var(--border-radius-lg,12px);font-family:var(--font-sans,system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif);font-size:var(--font-text-md-size,15px);line-height:1.4}
:root[data-theme="dark"]{--bg:var(--color-background-primary,#212121);--fg:var(--color-text-primary,#f3f3f3);--muted:var(--color-text-secondary,#b4b4b4);--line:var(--color-border-primary,#3a3a3a);--tile:var(--color-background-secondary,#2c2c2c);--danger:var(--color-text-danger,#ff8a80)}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:var(--color-background-primary,#212121);--fg:var(--color-text-primary,#f3f3f3);--muted:var(--color-text-secondary,#b4b4b4);--line:var(--color-border-primary,#3a3a3a);--tile:var(--color-background-secondary,#2c2c2c);--danger:var(--color-text-danger,#ff8a80)}}
*{box-sizing:border-box}
html,body{margin:0;padding:0;background:var(--bg);color:var(--fg)}
main{padding:16px;display:flex;flex-direction:column;gap:12px}
.head{display:flex;flex-direction:column;gap:2px}
.heading{margin:0;font-size:var(--font-heading-sm-size,17px);font-weight:var(--font-weight-semibold,600)}
.product,.meta,.note{color:var(--muted)}
.product,.status,.note{margin:0;overflow-wrap:anywhere}
.status.error{color:var(--danger)}
.bar{height:6px;border-radius:3px;background:var(--line);overflow:hidden}
.fill{height:100%;background:var(--fg);transition:width .3s ease}
.files{list-style:none;margin:0;padding:0;display:grid;gap:12px}
.files.card{grid-template-columns:repeat(auto-fit,minmax(140px,1fr))}
.files.carousel{display:flex;overflow-x:auto;scroll-snap-type:x mandatory;padding-bottom:4px}
.files.carousel .file{flex:0 0 168px;scroll-snap-align:start}
.files.grid{grid-template-columns:repeat(auto-fill,minmax(160px,1fr))}
.file{display:flex;flex-direction:column;gap:8px;padding:8px;border:1px solid var(--line);border-radius:var(--radius);background:var(--tile);min-width:0}
.preview{display:block;width:100%;aspect-ratio:1/1;object-fit:contain;border-radius:calc(var(--radius) - 4px);background:var(--bg)}
.caption{display:flex;flex-direction:column;min-width:0}
.title,.meta{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.title{font-weight:var(--font-weight-medium,500)}
.meta{font-size:var(--font-text-sm-size,13px)}
button{font:inherit;cursor:pointer;border-radius:999px;padding:6px 14px;border:1px solid var(--line);background:var(--bg);color:var(--fg)}
button:focus-visible{outline:2px solid var(--fg);outline-offset:2px}
.action{align-self:flex-start}
.foot{display:flex;flex-wrap:wrap;gap:8px}
.link{border:none;background:none;padding:4px 0;text-decoration:underline}
`;

/** The whole document for an origin. */
export function packViewerHtml(origin: string): string {
  const config: ViewerConfig = { origin, ...PACK_VIEWER_SETTINGS };
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    "<title>Curvi pack</title>",
    `<style>${STYLE.trim()}</style>`,
    "</head>",
    "<body>",
    '<main id="root" aria-live="polite"></main>',
    `<script>${packViewerScript(config)}</script>`,
    "</body>",
    "</html>",
  ].join("\n");
}
