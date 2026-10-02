/**
 * Credits shown before they are spent (docs/phases/PHASE_19.md, P19-16 and
 * founder decision 5). estimate_pack returns a signed quote; create_pack
 * sends it back with max_credits, and the pack is refused unless the quote
 * was signed for the same workspace, the same choices and the same photos
 * within 15 minutes. createJob then refuses any hold above the quote or
 * max_credits, so a pack never holds more than the estimate the assistant
 * was given.
 *
 * The quote carries only the credits and its expiry in the clear. The
 * workspace, the canonical hash of the choices and the hash of the sorted
 * photo hashes are inside the HMAC only, so no internal id reaches the chat
 * (OpenAI O6) and any change to them fails the signature. It is signed with
 * the MCP_LINK_KEYS ring (lib/mcp-signing.ts) under its own purpose, so a
 * link token can never pass as a quote.
 *
 * The derived Idempotency-Key for assistants lives here too: a key written
 * by the model cannot defeat replay, so the server derives one from the
 * connection (or key), the member, the photos and the choices, per 10 minute
 * window, and checks the previous window's key first.
 */

import { createHash, randomBytes } from "node:crypto";
import type { z } from "zod";
import { optionalEnv } from "@/lib/env";
import { parseSigningKeys, signPayload, verifyPayload, type SigningKey } from "@/lib/mcp-signing";
import type { CreatePackRequest } from "./schemas";

/** How long a quote holds (decision 5). */
export const QUOTE_TTL_MINUTES = 15;

/** The replay window of a derived key; a retry within at least this long
 * returns the same pack (10 to 20 minutes, since the previous window's key
 * is checked too). */
export const DERIVED_KEY_WINDOW_MS = 10 * 60 * 1000;

const QUOTE_VERSION = "q1";
const QUOTE_PATTERN = /^q1\.(\d{1,9})\.(\d{1,12})\.([A-Za-z0-9_-]{1,32})\.([A-Za-z0-9_-]{43})$/;

/** The parsed create_pack body, after the bundle and look shortcuts. */
export type ParsedPackRequest = z.output<typeof CreatePackRequest>;

/** One of the pack's photos as the quote and the replay key see it. */
export interface QuotePhoto {
  sha256: string;
  angle?: string;
}

/** The two hashes a quote and a derived key bind. */
export interface CanonicalPack {
  /** Every choice that shapes the pack: the expanded channels, the product,
   * the seller inputs, the output options, the answers and each photo's
   * role. */
  optionsHash: string;
  /** The sorted, distinct photo hashes. */
  photosHash: string;
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** JSON with object keys sorted at every level and undefined left out, so
 * equal requests always serialize alike. */
export function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value ?? null);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
}

/**
 * The canonical hashes of a pack request: estimate_pack and create_pack
 * compute them from the same parsed body, channel specs and photos, so the
 * same request gives the same hashes however the model ordered its fields
 * or its channel list.
 */
export function canonicalPack(
  request: ParsedPackRequest,
  channels: readonly string[],
  photos: readonly QuotePhoto[],
): CanonicalPack {
  const { photos: _photos, images: _images, channels: _sent, ...choices } = request;
  const hashes = [...new Set(photos.map((photo) => photo.sha256))].sort();
  // The first role sent for a photo counts, as the pack keeps the first copy.
  const firstRole = new Map<string, string | null>();
  for (const photo of photos) {
    if (!firstRole.has(photo.sha256)) {
      firstRole.set(photo.sha256, photo.angle ?? null);
    }
  }
  const roles = [...firstRole.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return {
    optionsHash: sha256Hex(
      stableJson({
        ...choices,
        productId: request.productId ?? "new",
        channels: [...new Set(channels)].sort(),
        roles,
      }),
    ),
    photosHash: sha256Hex(hashes.join(",")),
  };
}

let devKeys: SigningKey[] | null = null;

/**
 * The quote signing ring: MCP_LINK_KEYS when set. Outside production an
 * unset value falls back to a random key kept for this process, so local
 * runs and tests need no setup; production with no keys signs nothing and
 * estimate_pack answers that it cannot count credits. A malformed value
 * throws SigningKeyConfigError (it never echoes a secret).
 */
export function quoteSigningKeys(
  env: Record<string, string | undefined> = { MCP_LINK_KEYS: optionalEnv("MCP_LINK_KEYS"), NODE_ENV: optionalEnv("NODE_ENV") },
): SigningKey[] | null {
  const configured = parseSigningKeys(env.MCP_LINK_KEYS);
  if (configured) {
    return configured;
  }
  if (env.NODE_ENV === "production") {
    return null;
  }
  devKeys ??= [{ kid: "dev", secret: randomBytes(32).toString("base64url") }];
  return devKeys;
}

function quotePayload(workspaceId: string, pack: CanonicalPack, credits: number, expiresAt: number): string {
  return [workspaceId, pack.optionsHash, pack.photosHash, credits, expiresAt].join("|");
}

/** A quote for this workspace, request and credit figure, valid for
 * QUOTE_TTL_MINUTES from now. */
export function signQuote(
  keys: readonly SigningKey[],
  args: { workspaceId: string; pack: CanonicalPack; credits: number; now: Date },
): string {
  const credits = Math.max(0, Math.ceil(args.credits));
  const expiresAt = Math.floor(args.now.getTime() / 1000) + QUOTE_TTL_MINUTES * 60;
  const { kid, signature } = signPayload(keys, "quote", quotePayload(args.workspaceId, args.pack, credits, expiresAt));
  return [QUOTE_VERSION, credits, expiresAt, kid, signature].join(".");
}

export type QuoteCheck =
  | { ok: true; credits: number }
  /** malformed: not a quote; expired: older than QUOTE_TTL_MINUTES;
   * mismatch: signed for another workspace, other choices or other photos,
   * or tampered with. */
  | { ok: false; reason: "malformed" | "expired" | "mismatch" };

/** Checks a quote against the request it is sent with. */
export function checkQuote(
  keys: readonly SigningKey[],
  quote: string,
  args: { workspaceId: string; pack: CanonicalPack; now: Date },
): QuoteCheck {
  const match = QUOTE_PATTERN.exec(quote.trim());
  if (!match) {
    return { ok: false, reason: "malformed" };
  }
  const credits = Number(match[1]);
  const expiresAt = Number(match[2]);
  const payload = quotePayload(args.workspaceId, args.pack, credits, expiresAt);
  if (!verifyPayload(keys, "quote", match[3] ?? "", payload, match[4] ?? "")) {
    return { ok: false, reason: "mismatch" };
  }
  if (Math.floor(args.now.getTime() / 1000) >= expiresAt) {
    return { ok: false, reason: "expired" };
  }
  return { ok: true, credits };
}

/**
 * The Idempotency-Keys of an assistant's create_pack: "mcp:" and the sha256
 * of the connection (or API key) id, the member, the photos, the choices and
 * the 10 minute window. current is this window's key; previous is the one
 * before, which createJob checks first for a replay.
 */
export function derivedIdempotencyKeys(args: {
  /** The mcp_connections row or the API key the call came through. */
  subject: string;
  userId: string;
  pack: CanonicalPack;
  now: Date;
}): { current: string; previous: string } {
  const window = Math.floor(args.now.getTime() / DERIVED_KEY_WINDOW_MS);
  const keyFor = (bucket: number) =>
    `mcp:${sha256Hex([args.subject, args.userId, args.pack.photosHash, args.pack.optionsHash, bucket].join("|"))}`;
  return { current: keyFor(window), previous: keyFor(window - 1) };
}
