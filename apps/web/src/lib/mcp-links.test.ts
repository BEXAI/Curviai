import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiCaller } from "@/lib/api-keys/auth";
import {
  MCP_LINK_LIVE_CACHE_MS,
  MCP_LINK_TTL_SECONDS,
  clearMcpLinkCacheForTests,
  linkSigningKeys,
  linkSubjectLive,
  packFileLinks,
  signLinkToken,
  verifyLinkToken,
  type LinkClaims,
  type McpLinkBackend,
} from "./mcp-links";
import { openPayload, parseSigningKeys, sealPayload } from "./mcp-signing";

// Lasting link tokens (docs/phases/PHASE_19.md, P19-17): signed, tied to the
// connection or key that made them, 24 hours, rotation safe.

const OLD = `old:${"o".repeat(40)}`;
const NEW = `new:${"n".repeat(40)}`;
const RING = parseSigningKeys(`${NEW},${OLD}`)!;
const OLD_RING = parseSigningKeys(OLD)!;
const NEW_ONLY = parseSigningKeys(NEW)!;

const WS = "0b7a4d1e-5c3f-4a2b-9e8d-7c6b5a4f3e2d";
const JOB = "5a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d";
const CONNECTION = "00000000-0000-4000-8000-00000000c0c0";
const KEY_ID = "00000000-0000-4000-8000-0000000003a1";
const VARIANT = "v_11111111-2222-4333-8444-555555555555";
const REPORT = "p_66666666-7777-4888-8999-000000000000";
const NOW = 1_790_000_000;

function claims(overrides: Partial<LinkClaims> = {}): LinkClaims {
  return {
    subject: { kind: "connection", id: CONNECTION },
    workspaceId: WS,
    jobId: JOB,
    fileId: VARIANT,
    kind: "file",
    exp: NOW + MCP_LINK_TTL_SECONDS,
    ...overrides,
  };
}

function caller(kind: "oauth" | "api_key"): Pick<ApiCaller, "kind" | "keyId" | "connectionId" | "principal"> {
  return {
    kind,
    keyId: kind === "api_key" ? KEY_ID : null,
    connectionId: kind === "oauth" ? CONNECTION : null,
    principal: { workspaceId: WS, workspaceName: "W", plan: "free", role: "owner", userId: "u" },
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  clearMcpLinkCacheForTests();
});

describe("link tokens", () => {
  it("round trips the claims and names the key that signed", () => {
    const token = signLinkToken(claims(), RING);
    expect(token.startsWith("new.")).toBe(true);
    expect(verifyLinkToken(token, RING, NOW)).toEqual({ ok: true, claims: claims(), kid: "new" });
  });

  it("refuses a tampered token, a swapped key id and a value sealed for quotes", () => {
    const token = signLinkToken(claims(), RING);
    const [kid, iv, sealed] = token.split(".") as [string, string, string];
    const bytes = Buffer.from(sealed, "base64url");
    for (const index of [0, Math.floor(bytes.length / 2), bytes.length - 1]) {
      const changed = Buffer.from(bytes);
      changed[index] = (changed[index] ?? 0) ^ 1;
      expect(verifyLinkToken(`${kid}.${iv}.${changed.toString("base64url")}`, RING, NOW), String(index)).toEqual({
        ok: false,
        reason: "signature",
      });
    }
    const ivBytes = Buffer.from(iv, "base64url");
    ivBytes[0] = (ivBytes[0] ?? 0) ^ 1;
    expect(verifyLinkToken(`${kid}.${ivBytes.toString("base64url")}.${sealed}`, RING, NOW)).toEqual({ ok: false, reason: "signature" });
    expect(verifyLinkToken(`old.${iv}.${sealed}`, RING, NOW)).toEqual({ ok: false, reason: "signature" });
    expect(verifyLinkToken(`nope.${iv}.${sealed}`, RING, NOW)).toEqual({ ok: false, reason: "signature" });
    // The same ring serves estimate quotes under another purpose.
    const quote = sealPayload(RING, "quote", openPayload(RING, "link", kid, iv, sealed)!);
    expect(verifyLinkToken(`${quote.kid}.${quote.iv}.${quote.sealed}`, RING, NOW)).toEqual({ ok: false, reason: "signature" });
  });

  it("carries no readable id or time: only the key id is in the clear", () => {
    const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
    const ids = [WS, JOB, CONNECTION, KEY_ID, VARIANT.slice(2), REPORT.slice(2)];
    for (const subject of [{ kind: "connection", id: CONNECTION }, { kind: "key", id: KEY_ID }] as const) {
      for (const kind of ["file", "preview"] as const) {
        const token = signLinkToken(claims({ subject, kind, fileId: kind === "file" ? REPORT : VARIANT }), RING);
        const segments = token.split(".");
        expect(segments[0]).toBe("new");
        for (const segment of segments) {
          const bytes = Buffer.from(segment, "base64url");
          for (const text of [segment, bytes.toString("utf8"), bytes.toString("latin1")]) {
            expect(text).not.toMatch(UUID);
            expect(text).not.toContain(String(NOW + MCP_LINK_TTL_SECONDS));
            expect(text).not.toMatch(/"[swjfke]":/);
          }
          // Nor the ids' raw 16 bytes.
          for (const id of ids) {
            expect(bytes.includes(Buffer.from(id.replace(/-/g, ""), "hex")), id).toBe(false);
            expect(bytes.toString("hex")).not.toContain(id.replace(/-/g, ""));
          }
        }
      }
    }
    // Two links for the same file differ, so equal files cannot be spotted.
    expect(signLinkToken(claims(), RING)).not.toBe(signLinkToken(claims(), RING));
  });

  it("refuses malformed tokens before any parsing", () => {
    for (const token of ["", "a.b", "a.b.c.d", "new.%%%.sig", `new.${"a".repeat(2000)}.sig`]) {
      expect(verifyLinkToken(token, RING, NOW).ok, token.slice(0, 20)).toBe(false);
    }
  });

  it("expires after 24 hours", () => {
    const token = signLinkToken(claims(), RING);
    expect(verifyLinkToken(token, RING, NOW + MCP_LINK_TTL_SECONDS - 1).ok).toBe(true);
    expect(verifyLinkToken(token, RING, NOW + MCP_LINK_TTL_SECONDS)).toEqual({ ok: false, reason: "expired" });
  });

  it("keeps an old key's links working after a rotation until the old key is dropped", () => {
    const before = signLinkToken(claims(), OLD_RING);
    expect(verifyLinkToken(before, RING, NOW).ok).toBe(true);
    expect(signLinkToken(claims(), RING).startsWith("new.")).toBe(true);
    expect(verifyLinkToken(before, NEW_ONLY, NOW)).toEqual({ ok: false, reason: "signature" });
  });

  it("reads the ring from MCP_LINK_KEYS and turns links off when it is unset or malformed", () => {
    vi.stubEnv("MCP_LINK_KEYS", `${NEW},${OLD}`);
    expect(linkSigningKeys()?.map((key) => key.kid)).toEqual(["new", "old"]);
    vi.stubEnv("MCP_LINK_KEYS", "");
    expect(linkSigningKeys()).toBeNull();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.stubEnv("MCP_LINK_KEYS", "short:abc");
    expect(linkSigningKeys()).toBeNull();
    expect(warn.mock.calls.flat().join(" ")).not.toContain("abc");
    warn.mockRestore();
  });
});

describe("packFileLinks", () => {
  const files = [
    { id: VARIANT, kind: "image" as const, downloadUrl: `/api/jobs/${JOB}/files/${VARIANT}` },
    { id: REPORT, kind: "report" as const, downloadUrl: `/api/jobs/${JOB}/files/${REPORT}` },
    { id: "demo_zip_amazon", kind: "zip" as const, downloadUrl: null },
  ];
  const now = new Date(NOW * 1000);

  it("gives stored files a 24 hour download link and images a preview, tied to the connection", () => {
    const links = packFileLinks(caller("oauth"), JOB, files, { keys: RING, now, origin: "https://curvi.ai" });
    const image = links.get(VARIANT)!;
    expect(image.preview_url).toMatch(/^https:\/\/curvi\.ai\/api\/mcp\/preview\/new\.[\w-]+\.[\w-]+$/);
    expect(image.download_url).toMatch(/^https:\/\/curvi\.ai\/api\/mcp\/files\/new\.[\w-]+\.[\w-]+$/);
    const token = image.download_url!.split("/").pop()!;
    expect(verifyLinkToken(token, RING, NOW)).toMatchObject({
      ok: true,
      claims: { subject: { kind: "connection", id: CONNECTION }, workspaceId: WS, jobId: JOB, fileId: VARIANT, kind: "file", exp: NOW + 86_400 },
    });
    expect(verifyLinkToken(image.preview_url!.split("/").pop()!, RING, NOW)).toMatchObject({ ok: true, claims: { kind: "preview" } });
    expect(links.get(REPORT)).toEqual({ preview_url: null, download_url: expect.stringContaining("/api/mcp/files/") });
    // A file that is not stored (the demo) gets no links.
    expect(links.get("demo_zip_amazon")).toEqual({ preview_url: null, download_url: null });
  });

  it("ties an API key caller's links to the key", () => {
    const links = packFileLinks(caller("api_key"), JOB, files.slice(0, 1), { keys: RING, now, origin: "https://curvi.ai" });
    const token = links.get(VARIANT)!.download_url!.split("/").pop()!;
    expect(verifyLinkToken(token, RING, NOW)).toMatchObject({ ok: true, claims: { subject: { kind: "key", id: KEY_ID } } });
  });

  it("makes no links without keys or without a connection to tie them to", () => {
    expect(packFileLinks(caller("oauth"), JOB, files, { keys: null, now }).get(VARIANT)).toEqual({ preview_url: null, download_url: null });
    const unbound = { ...caller("oauth"), connectionId: null };
    expect(packFileLinks(unbound, JOB, files, { keys: RING, now }).get(VARIANT)).toEqual({ preview_url: null, download_url: null });
  });
});

describe("linkSubjectLive", () => {
  it("reads once a minute per connection and workspace", async () => {
    const backend: McpLinkBackend = { subjectLive: vi.fn(async () => true), fileOf: vi.fn(async () => null) };
    const subject = { kind: "connection" as const, id: CONNECTION };
    expect(await linkSubjectLive(backend, subject, WS, 1000)).toBe(true);
    expect(await linkSubjectLive(backend, subject, WS, 1000 + MCP_LINK_LIVE_CACHE_MS - 1)).toBe(true);
    expect(backend.subjectLive).toHaveBeenCalledTimes(1);
    vi.mocked(backend.subjectLive).mockResolvedValue(false);
    expect(await linkSubjectLive(backend, subject, WS, 1000 + MCP_LINK_LIVE_CACHE_MS)).toBe(false);
    expect(backend.subjectLive).toHaveBeenCalledTimes(2);
  });
});
