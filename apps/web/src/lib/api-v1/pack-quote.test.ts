import { describe, expect, it } from "vitest";
import { SigningKeyConfigError, type SigningKey } from "@/lib/mcp-signing";
import {
  DERIVED_KEY_WINDOW_MS,
  QUOTE_TTL_MINUTES,
  canonicalPack,
  checkQuote,
  derivedIdempotencyKeys,
  quoteSigningKeys,
  signQuote,
  stableJson,
  type ParsedPackRequest,
} from "./pack-quote";
import { CreatePackRequest } from "./schemas";

// The estimate quote and the derived replay key (PHASE_19 P19-16, founder
// decision 5): a quote binds the workspace, the choices, the photos and the
// credits for 15 minutes, and carries no id in the clear.

const KEYS: SigningKey[] = [{ kid: "k1", secret: "s".repeat(40) }];
const WS = "00000000-0000-4000-8000-0000000000a1";
const OTHER_WS = "00000000-0000-4000-8000-0000000000a2";
const NOW = new Date("2026-10-01T12:00:00.000Z");
const PHOTO_A = { sha256: "a".repeat(64), angle: "front" };
const PHOTO_B = { sha256: "b".repeat(64) };

function request(body: Record<string, unknown>): ParsedPackRequest {
  return CreatePackRequest.parse(body);
}

const BASE = request({ channels: ["amazon", "shopify.product"], title: "Mug", bundle: "main" });
const PACK = canonicalPack(BASE, ["amazon.main", "amazon.secondary", "shopify.product"], [PHOTO_A, PHOTO_B]);

describe("canonicalPack", () => {
  it("is the same however the channels, the photos or the fields were ordered", () => {
    const reordered = request({ bundle: "main", title: "Mug", channels: ["shopify.product", "amazon"] });
    expect(canonicalPack(reordered, ["shopify.product", "amazon.secondary", "amazon.main"], [PHOTO_B, PHOTO_A])).toEqual(PACK);
    expect(stableJson({ b: 1, a: { d: 2, c: undefined } })).toBe('{"a":{"d":2},"b":1}');
  });

  it("changes with any choice, any photo or a photo's role", () => {
    const other = (body: Record<string, unknown>) => canonicalPack(request(body), ["amazon.main"], [PHOTO_A]);
    const base = other({ channels: ["amazon.main"] });
    expect(other({ channels: ["amazon.main"], note: "on a desk" }).optionsHash).not.toBe(base.optionsHash);
    expect(other({ channels: ["amazon.main"], look: "keep_photo" }).optionsHash).not.toBe(base.optionsHash);
    expect(canonicalPack(request({ channels: ["amazon.main"] }), ["amazon.main", "shopify.product"], [PHOTO_A]).optionsHash).not.toBe(
      base.optionsHash,
    );
    expect(canonicalPack(request({ channels: ["amazon.main"] }), ["amazon.main"], [PHOTO_B]).photosHash).not.toBe(base.photosHash);
    expect(canonicalPack(request({ channels: ["amazon.main"] }), ["amazon.main"], [{ ...PHOTO_A, angle: "back" }]).optionsHash).not.toBe(
      base.optionsHash,
    );
  });
});

describe("quotes", () => {
  it("round trips and carries only the credits and the expiry in the clear", () => {
    const quote = signQuote(KEYS, { workspaceId: WS, pack: PACK, credits: 12, now: NOW });
    expect(quote).toMatch(/^q1\.12\.\d+\.k1\.[A-Za-z0-9_-]{43}$/);
    expect(quote).not.toContain(WS);
    expect(quote).not.toContain(PACK.optionsHash);
    expect(checkQuote(KEYS, quote, { workspaceId: WS, pack: PACK, now: NOW })).toEqual({ ok: true, credits: 12 });
  });

  it("refuses another workspace, other choices, other photos and a changed figure", () => {
    const quote = signQuote(KEYS, { workspaceId: WS, pack: PACK, credits: 12, now: NOW });
    expect(checkQuote(KEYS, quote, { workspaceId: OTHER_WS, pack: PACK, now: NOW })).toEqual({ ok: false, reason: "mismatch" });
    expect(checkQuote(KEYS, quote, { workspaceId: WS, pack: { ...PACK, optionsHash: "0".repeat(64) }, now: NOW })).toEqual({
      ok: false,
      reason: "mismatch",
    });
    expect(checkQuote(KEYS, quote, { workspaceId: WS, pack: { ...PACK, photosHash: "0".repeat(64) }, now: NOW })).toEqual({
      ok: false,
      reason: "mismatch",
    });
    expect(checkQuote(KEYS, quote.replace("q1.12.", "q1.99."), { workspaceId: WS, pack: PACK, now: NOW })).toEqual({
      ok: false,
      reason: "mismatch",
    });
    const otherKeys = [{ kid: "k1", secret: "t".repeat(40) }];
    expect(checkQuote(otherKeys, quote, { workspaceId: WS, pack: PACK, now: NOW })).toEqual({ ok: false, reason: "mismatch" });
    expect(checkQuote(KEYS, "not a quote", { workspaceId: WS, pack: PACK, now: NOW })).toEqual({ ok: false, reason: "malformed" });
  });

  it("expires after 15 minutes", () => {
    const quote = signQuote(KEYS, { workspaceId: WS, pack: PACK, credits: 12, now: NOW });
    const justBefore = new Date(NOW.getTime() + QUOTE_TTL_MINUTES * 60_000 - 1000);
    const after = new Date(NOW.getTime() + QUOTE_TTL_MINUTES * 60_000);
    expect(checkQuote(KEYS, quote, { workspaceId: WS, pack: PACK, now: justBefore }).ok).toBe(true);
    expect(checkQuote(KEYS, quote, { workspaceId: WS, pack: PACK, now: after })).toEqual({ ok: false, reason: "expired" });
  });

  it("is signed by the newest key and still checks after a rotation", () => {
    const quote = signQuote(KEYS, { workspaceId: WS, pack: PACK, credits: 3, now: NOW });
    const rotated = [{ kid: "k2", secret: "n".repeat(40) }, ...KEYS];
    expect(checkQuote(rotated, quote, { workspaceId: WS, pack: PACK, now: NOW }).ok).toBe(true);
    expect(signQuote(rotated, { workspaceId: WS, pack: PACK, credits: 3, now: NOW })).toContain(".k2.");
  });

  it("reads MCP_LINK_KEYS, falls back to a process key outside production, and signs nothing in production without keys", () => {
    expect(quoteSigningKeys({ MCP_LINK_KEYS: `k9:${"z".repeat(32)}`, NODE_ENV: "production" })).toEqual([
      { kid: "k9", secret: "z".repeat(32) },
    ]);
    expect(quoteSigningKeys({ NODE_ENV: "production" })).toBeNull();
    const dev = quoteSigningKeys({ NODE_ENV: "test" });
    expect(dev).toHaveLength(1);
    expect(quoteSigningKeys({ NODE_ENV: "development" })).toBe(dev);
    expect(() => quoteSigningKeys({ MCP_LINK_KEYS: "short:abc" })).toThrow(SigningKeyConfigError);
  });
});

describe("derivedIdempotencyKeys", () => {
  const args = { subject: "conn-1", userId: "user-1", pack: PACK, now: NOW };

  it("is the same for the same caller, photos and choices in one window, and names the previous window", () => {
    const keys = derivedIdempotencyKeys(args);
    expect(keys.current).toMatch(/^mcp:[0-9a-f]{64}$/);
    expect(derivedIdempotencyKeys({ ...args, now: new Date(NOW.getTime() + 1000) })).toEqual(keys);
    const next = derivedIdempotencyKeys({ ...args, now: new Date(NOW.getTime() + DERIVED_KEY_WINDOW_MS) });
    expect(next.previous).toBe(keys.current);
  });

  it("differs for another connection, member, photo set or choice", () => {
    const base = derivedIdempotencyKeys(args).current;
    expect(derivedIdempotencyKeys({ ...args, subject: "conn-2" }).current).not.toBe(base);
    expect(derivedIdempotencyKeys({ ...args, userId: "user-2" }).current).not.toBe(base);
    expect(derivedIdempotencyKeys({ ...args, pack: { ...PACK, photosHash: "1".repeat(64) } }).current).not.toBe(base);
    expect(derivedIdempotencyKeys({ ...args, pack: { ...PACK, optionsHash: "1".repeat(64) } }).current).not.toBe(base);
  });
});
