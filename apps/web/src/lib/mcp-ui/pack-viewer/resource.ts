/**
 * The pack viewer as an MCP Apps UI resource (docs/phases/PHASE_19.md,
 * P19-19, decision 6): served by resources/list and resources/read
 * (lib/api-v1/mcp.ts) and named by create_pack's `_meta.ui.resourceUri`
 * (lib/api-v1/mcp-tools.ts). Every fact below was checked on 2026-10-01
 * (docs/verification.md, "p19/ui: pack viewer"):
 *
 * - `mimeType` is `text/html;profile=mcp-app` and the uri starts with ui://
 *   (MCP Apps 2026-01-26, M5; O2, O11). The uri carries a version, because
 *   ChatGPT caches by uri: a breaking change gets v2 (O11).
 * - `_meta.ui.csp.resourceDomains` lets the previews load from the site
 *   origin; no connectDomains and no frameDomains, so the viewer fetches
 *   nothing and frames nothing (an omitted list means none, M5).
 * - `_meta.ui.domain` is the viewer's dedicated origin, "required when
 *   submitting a plugin with UI; must be unique per plugin" (O2): the site
 *   origin, as in OpenAI's example; ChatGPT derives the sandbox host from it.
 * - The legacy `openai/widgetCSP.redirect_domains` lets
 *   window.openai.openExternal open the site's links without ChatGPT's
 *   redirect page; `_meta.ui.csp` has no such field (O2).
 *
 * PACK_VIEWER_LIVE is the one switch: the plan ships the viewer by deploy
 * after the first publication (decision 6), so a branch that must merge
 * before then can set it to false, which takes the resources capability and
 * the resourceUri away together and leaves the endpoint as it was. Every
 * tool result still carries its links as text, so nothing depends on the
 * viewer.
 */

import type { McpResourceProvider } from "@/lib/api-v1/mcp";
import { siteUrl } from "@/lib/env";
import { packViewerHtml } from "./html";

/** Serve the viewer and name it on create_pack. Off until the first
 * publication (decision 6): the first submission's tool scan then reports no
 * UI template, so the ZIP carries no screenshots (O4). Flip it to true by
 * deploy after publishing (runbook E8), then Rescan. */
export const PACK_VIEWER_LIVE: boolean = false;

export const PACK_VIEWER_URI = "ui://curvi/pack-viewer/v1.html";
export const MCP_APP_MIME_TYPE = "text/html;profile=mcp-app";

/** The MCP server's fixed origin (decision 9), used only when the site URL
 * setting cannot be read. */
const FIXED_ORIGIN = "https://curvi.ai";

/** The origin the viewer loads previews from and opens links on: the site's,
 * the same one lib/mcp-links.ts signs links for. */
export function packViewerOrigin(site: string = siteUrl()): string {
  try {
    return new URL(site).origin;
  } catch {
    return FIXED_ORIGIN;
  }
}

/** The resource `_meta` (on the resources/list entry and the read contents). */
export function packViewerMeta(origin: string): Record<string, unknown> {
  return {
    ui: {
      csp: { resourceDomains: [origin] },
      domain: origin,
      prefersBorder: true,
    },
    "openai/widgetCSP": { connect_domains: [], resource_domains: [origin], redirect_domains: [origin] },
  };
}

const htmlByOrigin = new Map<string, string>();

function htmlFor(origin: string): string {
  let html = htmlByOrigin.get(origin);
  if (html === undefined) {
    html = packViewerHtml(origin);
    htmlByOrigin.set(origin, html);
  }
  return html;
}

/** The provider for an origin (the site's by default, read per call). */
export function packViewerResources(originOf: () => string = () => packViewerOrigin()): McpResourceProvider {
  return {
    list() {
      return [
        {
          uri: PACK_VIEWER_URI,
          name: "pack-viewer",
          title: "Pack viewer",
          description: "Shows a pack's progress and its finished images with a download button for each.",
          mimeType: MCP_APP_MIME_TYPE,
          _meta: packViewerMeta(originOf()),
        },
      ];
    },
    read(uri) {
      if (uri !== PACK_VIEWER_URI) {
        return null;
      }
      const origin = originOf();
      return [{ uri: PACK_VIEWER_URI, mimeType: MCP_APP_MIME_TYPE, text: htmlFor(origin), _meta: packViewerMeta(origin) }];
    },
  };
}

/** What /api/mcp serves: the viewer while it is live, else nothing. */
export const PACK_VIEWER_RESOURCES: McpResourceProvider | null = PACK_VIEWER_LIVE ? packViewerResources() : null;

/** create_pack's `_meta.ui.resourceUri` while the viewer is live. */
export const PACK_VIEWER_TEMPLATE: string | null = PACK_VIEWER_LIVE ? PACK_VIEWER_URI : null;
