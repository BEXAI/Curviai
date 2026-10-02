/**
 * Pack results shaped like the MCP tools send them (PackChat, the
 * create_pack and get_pack chat view), for the pack viewer's tests.
 */

import type { PackChat, PackChatImage } from "@/lib/api-v1/chat-views";

export const ORIGIN = "https://curvi.ai";
export const PACK_ID = "0b7a4d1e-5c3f-4a2b-9e8d-7c6b5a4f3e2d";

export function image(index: number, overrides: Partial<PackChatImage> = {}): PackChatImage {
  return {
    name: `amazon-main-${index}.jpg`,
    channel: "amazon.main",
    kind: "image",
    passes_channel_rules: true,
    fill_percent: 86,
    preview_url: `${ORIGIN}/api/mcp/preview/tok-p${index}`,
    download_url: `${ORIGIN}/api/mcp/files/tok-f${index}`,
    ...overrides,
  };
}

export function pack(overrides: Partial<PackChat> = {}): PackChat {
  return {
    pack_id: PACK_ID,
    status: "queued",
    finished: false,
    product: "Lavender soy candle",
    channels: ["amazon.main"],
    credits: { held: 12, charged: 0 },
    progress: { done: 0, total: 0 },
    message: "Started a pack that holds 12 credits. You are charged only for images that pass their checks. It takes a few minutes.",
    error: null,
    ...overrides,
  };
}

/** A finished pack with n images, a zip and the report. */
export function finishedPack(n: number, overrides: Partial<PackChat> = {}): PackChat {
  const images = Array.from({ length: n }, (_, index) => image(index + 1));
  return pack({
    status: "done",
    finished: true,
    progress: { done: n, total: n },
    credits: { held: 12, charged: 12 },
    images: [
      ...images,
      { ...image(0), name: "pack.zip", channel: null, kind: "zip", passes_channel_rules: null, fill_percent: null, preview_url: null, download_url: `${ORIGIN}/api/mcp/files/tok-zip` },
      { ...image(0), name: "report.pdf", channel: null, kind: "report", passes_channel_rules: null, fill_percent: null, preview_url: null, download_url: `${ORIGIN}/api/mcp/files/tok-report` },
    ],
    links_valid_hours: 24,
    message: `The pack is ready: ${n} of ${n} images passed their channel checks. The links work for 24 hours.`,
    ...overrides,
  });
}

/** A successful tools/call result carrying the view, as toolResult builds it. */
export function toolOk(structuredContent: unknown): Record<string, unknown> {
  return { content: [{ type: "text", text: JSON.stringify(structuredContent) }], structuredContent, isError: false };
}

/** A refusal: isError and text only. */
export function toolRefusal(text: string): Record<string, unknown> {
  return { content: [{ type: "text", text }], isError: true };
}
