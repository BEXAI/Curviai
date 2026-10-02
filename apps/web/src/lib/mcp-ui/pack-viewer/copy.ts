/**
 * Every word the pack viewer shows (docs/phases/PHASE_19.md, P19-19 "Viewer
 * copy"). Plain spoken (CLAUDE.md rule 9) and, like every string the MCP
 * endpoint sends, free of plan, price and key wording (mcp-copy.ts): the
 * viewer runs inside ChatGPT, so it is held to the same rules as a tool
 * result. The HTML carries this object as JSON, and the viewer fills the
 * {done}, {total} and {n} slots itself; tests lint every line.
 */

import { MCP_COPY } from "@/lib/api-v1/mcp-copy";

export const PACK_VIEWER_COPY = {
  awaiting: "Waiting for your go ahead",
  making: "Making your images",
  progress: "{done} of {total} ready",
  ready: "Ready",
  download: "Download",
  seeAll: "See all {n} files",
  openInCurvi: "Open in Curvi",
  someFailed: "Some images did not pass their checks and were not charged.",
  notStarted: "This pack was not started, so nothing was charged.",
  askAssistant: "Ask ChatGPT how the pack is going.",
  images: "Images",
  linkExpired: MCP_COPY.linkExpired,
  unavailable: MCP_COPY.unavailable,
} as const;

export type PackViewerCopy = { readonly [K in keyof typeof PACK_VIEWER_COPY]: string };
