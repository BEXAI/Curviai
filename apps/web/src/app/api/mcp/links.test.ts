import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MCP_COPY } from "@/lib/api-v1/mcp-copy";
import { setMcpLinkBackendForTests } from "@/lib/mcp-links-backend";
import {
  MCP_LINK_TTL_SECONDS,
  clearMcpLinkCacheForTests,
  signLinkToken,
  type LinkClaims,
  type LinkedFile,
  type McpLinkBackend,
} from "@/lib/mcp-links";
import { parseSigningKeys } from "@/lib/mcp-signing";
import { MemoryRateLimitStore, RATE_LIMIT_POLICIES, checkRateLimit, setRateLimitStoreForTests } from "@/lib/rate-limit";

// The lasting link routes (docs/phases/PHASE_19.md, P19-17): every click
// checks the token, the connection or key, the member and the file again.

// Stored objects the preview reads; every other r2 helper is real, so the
// download redirect is a real presigned url.
const storedObjects = vi.hoisted(() => new Map<string, Buffer>());
vi.mock("@/lib/r2", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/r2")>();
  return { ...actual, getObjectBytes: vi.fn(async (key: string) => storedObjects.get(key) ?? null) };
});

import { GET as getFile } from "./files/[token]/route";
import { GET as getPreview } from "./preview/[token]/route";

 
const sharp = createRequire(new URL("../../../../../../packages/pipeline/package.json", import.meta.url))("sharp") as any;

const OLD = `old:${"o".repeat(40)}`;
const NEW = `new:${"n".repeat(40)}`;
const WS = "0b7a4d1e-5c3f-4a2b-9e8d-7c6b5a4f3e2d";
const OTHER_WS = "9c1d2e3f-4a5b-4c6d-8e7f-0a1b2c3d4e5f";
const JOB = "5a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d";
const CONNECTION = "00000000-0000-4000-8000-00000000c0c0";
const OTHER_CONNECTION = "00000000-0000-4000-8000-00000000c0c1";
const VARIANT = "v_11111111-2222-4333-8444-555555555555";
const REPORT = "p_66666666-7777-4888-8999-000000000000";
const IMAGE_KEY = `ws/${WS}/jobs/${JOB}/files/amazon/MUG1.MAIN.jpg`;

class FakeBackend implements McpLinkBackend {
  live = new Set<string>([`connection:${CONNECTION}:${WS}`, `connection:${OTHER_CONNECTION}:${WS}`]);
  files = new Map<string, LinkedFile>([
    [`${WS}/${JOB}/${VARIANT}`, { key: IMAGE_KEY, filename: "MUG1.MAIN.jpg", kind: "image" }],
    [`${WS}/${JOB}/${REPORT}`, { key: `ws/${WS}/jobs/${JOB}/pack/compliance-report.json`, filename: "compliance-report.json", kind: "report", reportBody: '{"files":[]}' }],
  ]);
  subjectLive = vi.fn(async (subject: { kind: string; id: string }, workspaceId: string) =>
    this.live.has(`${subject.kind}:${subject.id}:${workspaceId}`),
  );
  fileOf = vi.fn(async (workspaceId: string, jobId: string, fileId: string) => this.files.get(`${workspaceId}/${jobId}/${fileId}`) ?? null);
}

let backend: FakeBackend;

function token(overrides: Partial<LinkClaims> = {}, ring = `${NEW},${OLD}`): string {
  return signLinkToken(
    {
      subject: { kind: "connection", id: CONNECTION },
      workspaceId: WS,
      jobId: JOB,
      fileId: VARIANT,
      kind: "file",
      exp: Math.floor(Date.now() / 1000) + MCP_LINK_TTL_SECONDS,
      ...overrides,
    },
    parseSigningKeys(ring)!,
  );
}

function click(kind: "files" | "preview", value: string, query = "", ip = "198.51.100.7") {
  const request = new Request(`https://curvi.ai/api/mcp/${kind}/${value}${query}`, { headers: { "x-forwarded-for": ip } });
  const context = { params: Promise.resolve({ token: value }) };
  return kind === "files" ? getFile(request, context) : getPreview(request, context);
}

async function photoWithExif(): Promise<Buffer> {
  return sharp({ create: { width: 2400, height: 1600, channels: 3, background: "#336699" } })
    .withMetadata({ orientation: 1 })
    .withExifMerge({ IFD0: { Make: "PhoneCo", Model: "Secret Model", Copyright: "GPS 40.7,-74.0" } })
    .jpeg()
    .toBuffer();
}

beforeEach(() => {
  backend = new FakeBackend();
  setMcpLinkBackendForTests(backend);
  setRateLimitStoreForTests(new MemoryRateLimitStore());
  clearMcpLinkCacheForTests();
  vi.stubEnv("MCP_LINK_KEYS", `${NEW},${OLD}`);
  // Connections exist only while OAuth sign in is on (the kill switch).
  vi.stubEnv("MCP_OAUTH_ENABLED", "1");
  vi.stubEnv("R2_ACCOUNT_ID", "acct");
  vi.stubEnv("R2_ACCESS_KEY_ID", "id");
  vi.stubEnv("R2_SECRET_ACCESS_KEY", "secret");
  vi.stubEnv("R2_BUCKET_PRIVATE", "bucket");
});

afterEach(() => {
  setMcpLinkBackendForTests(null);
  setRateLimitStoreForTests(null);
  vi.unstubAllEnvs();
  storedObjects.clear();
});

describe("GET /api/mcp/files/{token}", () => {
  it("redirects to a fresh storage link that saves the file under its name, ignoring the query", async () => {
    for (const query of ["", "?redirectUrl=https%3A%2F%2Fchatgpt.com%2Fc%2Fabc"]) {
      const response = await click("files", token(), query);
      expect(response.status).toBe(302);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const location = new URL(response.headers.get("location") ?? "");
      expect(location.host).toBe("bucket.acct.r2.cloudflarestorage.com");
      expect(location.pathname).toBe(`/${IMAGE_KEY}`);
      expect(location.searchParams.get("response-content-disposition")).toContain('attachment; filename="MUG1.MAIN.jpg"');
      expect(location.searchParams.get("X-Amz-Expires")).toBe("900");
      expect(location.toString()).not.toContain("chatgpt");
    }
    expect(backend.fileOf).toHaveBeenCalledWith(WS, JOB, VARIANT);
  });

  it("downloads fresh report JSON directly with its filename", async () => {
    const response = await click("files", token({ fileId: REPORT }));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toContain("compliance-report.json");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ files: [] });
  });

  it("answers a tampered, foreign or wrong kind token with 404 and an expired one with 410", async () => {
    const good = token();
    const [kid, body, signature] = good.split(".") as [string, string, string];
    const tampered = `${kid}.${body}.${signature.slice(0, -2)}AA`;
    for (const value of [tampered, "nope", token({}, `other:${"x".repeat(40)}`), token({ kind: "preview" })]) {
      const response = await click("files", value);
      expect(response.status).toBe(404);
      expect(await response.text()).toBe(MCP_COPY.linkExpired);
    }
    const expired = await click("files", token({ exp: Math.floor(Date.now() / 1000) - 1 }));
    expect(expired.status).toBe(410);
    expect(await expired.text()).toBe(MCP_COPY.linkExpired);
    expect(backend.fileOf).not.toHaveBeenCalled();
  });

  it("stops working once the connection is disconnected or its member leaves", async () => {
    backend.live.delete(`connection:${CONNECTION}:${WS}`);
    const response = await click("files", token());
    expect(response.status).toBe(410);
    expect(await response.text()).toBe(MCP_COPY.linkExpired);
    expect(backend.fileOf).not.toHaveBeenCalled();
  });

  it("stops a connection's links while the kill switch is off, and keeps an API key's working", async () => {
    vi.stubEnv("MCP_OAUTH_ENABLED", "0");
    const response = await click("files", token());
    expect(response.status).toBe(410);
    expect(await response.text()).toBe(MCP_COPY.linkExpired);
    expect(backend.subjectLive).not.toHaveBeenCalled();
    expect((await click("preview", token({ kind: "preview" }))).status).toBe(410);

    const KEY = "00000000-0000-4000-8000-0000000000ee";
    backend.live.add(`key:${KEY}:${WS}`);
    expect((await click("files", token({ subject: { kind: "key", id: KEY } }))).status).toBe(302);

    vi.stubEnv("MCP_OAUTH_ENABLED", "1");
    expect((await click("files", token())).status).toBe(302);
  });

  it("refuses a link whose workspace does not hold the file, and a file that was deleted", async () => {
    backend.live.add(`connection:${CONNECTION}:${OTHER_WS}`);
    expect((await click("files", token({ workspaceId: OTHER_WS }))).status).toBe(404);
    backend.files.delete(`${WS}/${JOB}/${VARIANT}`);
    expect((await click("files", token())).status).toBe(404);
  });

  it("keeps an old key's links working after a rotation, and refuses them once the key is dropped", async () => {
    const before = token({}, OLD);
    expect((await click("files", before)).status).toBe(302);
    vi.stubEnv("MCP_LINK_KEYS", NEW);
    expect((await click("files", before)).status).toBe(404);
  });

  it("serves nothing when links or storage are not configured", async () => {
    const value = token();
    vi.stubEnv("MCP_LINK_KEYS", "");
    expect((await click("files", value)).status).toBe(404);
    vi.stubEnv("MCP_LINK_KEYS", `${NEW},${OLD}`);
    vi.stubEnv("R2_ACCOUNT_ID", "");
    expect((await click("files", value)).status).toBe(404);
  });

  it("answers 503 when the check cannot run, and never logs the token", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    backend.subjectLive.mockRejectedValueOnce(new Error("db down"));
    const value = token();
    const response = await click("files", value);
    expect(response.status).toBe(503);
    expect(await response.text()).toBe(MCP_COPY.linkUnavailable);
    expect(warn.mock.calls.flat().join(" ")).not.toContain(value.split(".")[1]);
    warn.mockRestore();
  });

  it("limits each connection's links on its own, so one never blocks another", async () => {
    const { limit } = RATE_LIMIT_POLICIES["mcp.links"].user;
    for (let i = 0; i < limit; i += 1) {
      await checkRateLimit("mcp.links", "user", `conn:${CONNECTION}`);
    }
    const blocked = await click("files", token(), "", "198.51.100.8");
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toBeTruthy();
    const other = await click("files", token({ subject: { kind: "connection", id: OTHER_CONNECTION } }), "", "198.51.100.9");
    expect(other.status).toBe(302);
  });
});

describe("GET /api/mcp/preview/{token}", () => {
  it("serves a bounded JPEG with no metadata", async () => {
    storedObjects.set(IMAGE_KEY, await photoWithExif());
    const response = await click("preview", token({ kind: "preview" }), "?redirectUrl=x");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/jpeg");
    expect(response.headers.get("cache-control")).toBe("private, max-age=300");
    const jpeg = Buffer.from(await response.arrayBuffer());
    const meta = await sharp(jpeg).metadata();
    expect(meta.format).toBe("jpeg");
    expect(Math.max(meta.width, meta.height)).toBe(1024);
    expect(meta.exif).toBeUndefined();
    expect(jpeg.includes(Buffer.from("Secret Model"))).toBe(false);
  });

  it("has no preview for the report and nothing for a download token", async () => {
    expect((await click("preview", token({ kind: "preview", fileId: REPORT }))).status).toBe(404);
    expect((await click("preview", token({ kind: "file" }))).status).toBe(404);
  });

  it("stops serving once the connection is disconnected, even with the preview cached", async () => {
    storedObjects.set(IMAGE_KEY, await photoWithExif());
    expect((await click("preview", token({ kind: "preview" }))).status).toBe(200);
    backend.live.delete(`connection:${CONNECTION}:${WS}`);
    clearMcpLinkCacheForTests();
    expect((await click("preview", token({ kind: "preview" }))).status).toBe(410);
  });
});
