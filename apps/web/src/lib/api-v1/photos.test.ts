import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { ApiCaller } from "@/lib/api-keys/auth";
import { checkMainImage, createPack, type ApiContext } from "@/lib/api-v1/actions";
import { MCP_COPY } from "@/lib/api-v1/mcp-copy";
import {
  NO_ATTACHMENT,
  PACK_PHOTO_FETCH_CONCURRENCY,
  attachmentMissing,
  readPackPhotos,
  readPhoto,
  storePackPhotos,
  type PhotoDeps,
} from "@/lib/api-v1/photos";
import { CreatePackRequest, MainImageCheckRequest, OpenAIFileObject } from "@/lib/api-v1/schemas";
import { mainImagePng } from "@/lib/api-v1/test-fixtures";
import { MemoryRateLimitStore, setRateLimitStoreForTests } from "@/lib/rate-limit";
import { createFakeServices, OTHER_WORKSPACE_ID } from "@/lib/testing/fake-services";
import { importPhoto, type PhotoImportResult } from "@/lib/url-import/image";
import { safeFetch, type Transport } from "@/lib/url-import/safe-fetch";

// Photos attached in ChatGPT (docs/phases/PHASE_19.md, P19-15): OpenAI's
// file object, read only through the SSRF safe import, typed by its bytes,
// three at a time under one deadline, and never stored or logged by link.

const WS = OTHER_WORKSPACE_ID;
const FILE_HOST = "https://files.oaiusercontent.com";

function attachment(name: string, extra: Record<string, unknown> = {}) {
  return { download_url: `${FILE_HOST}/${name}?se=2026-10-01&sig=secret-${name}`, file_id: `file-${name}`, ...extra };
}

async function pngPhoto(sha: string, size = 300): Promise<PhotoImportResult> {
  return {
    ok: true,
    photo: { body: await mainImagePng(size, 0.8), contentType: "image/png", sha256: sha.repeat(64).slice(0, 64), width: size, height: size },
  };
}

/** A HEIC photo's first bytes: an ISO BMFF ftyp box with the heic brand. */
const HEIC_HEAD = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypheic", "latin1"), Buffer.alloc(24)]);

function oauthCaller(overrides: Partial<ApiCaller> = {}): ApiCaller {
  return {
    kind: "oauth",
    keyId: null,
    prefix: null,
    connectionId: "00000000-0000-4000-8000-00000000c0c0",
    ipExempt: true,
    scopes: ["packs:write", "packs:read", "checks"],
    principal: { workspaceId: WS, workspaceName: "W", plan: "free", role: "owner", userId: "00000000-0000-4000-8000-000000000777" },
    services: createFakeServices("owner"),
    rateSubject: "user:00000000-0000-4000-8000-000000000777",
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  setRateLimitStoreForTests(null);
});

describe("the file object (OpenAI O2)", () => {
  it("declares four properties and requires exactly download_url and file_id", () => {
    const schema = z.toJSONSchema(OpenAIFileObject, { io: "input" }) as { properties: object; required: string[] };
    expect(Object.keys(schema.properties).sort()).toEqual(["download_url", "file_id", "file_name", "mime_type"]);
    expect([...schema.required].sort()).toEqual(["download_url", "file_id"]);
  });

  it("parses the documented runtime example in both tools' fields", () => {
    const example = {
      download_url: "https://files.oaiusercontent.com/file-AbC123?se=2026-10-01T12%3A00%3A00Z&sp=r&sig=abc",
      file_id: "file-AbC123",
      mime_type: "image/jpeg",
      file_name: "candle.jpg",
    };
    expect(CreatePackRequest.safeParse({ channels: ["amazon.main"], images: [example] }).success).toBe(true);
    expect(MainImageCheckRequest.safeParse({ image: example }).success).toBe(true);
    // Only the two required fields, as ChatGPT may send them.
    expect(OpenAIFileObject.safeParse({ download_url: example.download_url, file_id: example.file_id }).success).toBe(true);
  });
});

describe("attachmentMissing", () => {
  it("treats an absent file, a placeholder string or an entry without a link as missing", () => {
    for (const value of [undefined, null, "", "photo.jpg", "[attached image]", [], ["file-abc"], [{}], [{ file_id: "file-abc" }], { download_url: "attached" }]) {
      expect(attachmentMissing(value), JSON.stringify(value)).toBe(true);
    }
    expect(attachmentMissing([attachment("a")])).toBe(false);
    expect(attachmentMissing(attachment("a"))).toBe(false);
  });
});

describe("readPhoto with an attachment", () => {
  it("fetches only download_url and types the photo by its bytes, not mime_type", async () => {
    const fetchPhoto = vi.fn(async () => pngPhoto("a"));
    const read = await readPhoto({ ...attachment("a", { mime_type: "image/heic", file_name: "x.heic" }) }, { fetchPhoto });
    expect(fetchPhoto).toHaveBeenCalledTimes(1);
    expect(fetchPhoto).toHaveBeenCalledWith(attachment("a").download_url);
    expect(read.ok && read.photo.contentType).toBe("image/png");
  });

  it("names a HEIC attachment and keeps the API copy for a HEIC link", async () => {
    const fetcher = vi.fn(async () => ({ status: 200, contentType: "image/jpeg", body: HEIC_HEAD, url: new URL(FILE_HOST) }));
    const fetchPhoto = (url: string) => importPhoto(url, { fetcher });
    const chat = await readPhoto(attachment("h"), { fetchPhoto });
    expect(chat).toMatchObject({ ok: false, reason: "not_image", format: "heic", message: MCP_COPY.heic });
    const api = await readPhoto({ url: "https://shop.example/h.heic" }, { fetchPhoto });
    expect(api).toMatchObject({ ok: false, reason: "not_image", format: "heic" });
    expect(api.ok ? "" : api.message).not.toBe(MCP_COPY.heic);
  });

  it("still refuses a download_url that resolves to a private address", async () => {
    let connected = false;
    // Runs the guarded DNS lookup the way a socket connect does.
    const transport: Transport = (url, init) =>
      new Promise((_resolve, reject) => {
        init.lookup(url.hostname, {}, (err) => {
          connected = !err;
          reject(err ?? new Error("connected"));
        });
      });
    const fetchPhoto = (url: string) =>
      importPhoto(url, {
        fetcher: (u, options) =>
          safeFetch(u, { ...options, resolver: async () => [{ address: "10.0.0.7", family: 4 }], transport }),
      });
    const put = vi.fn(async () => true);
    const stored = await storePackPhotos(WS, [attachment("private")], { store: true, fetchPhoto, put });
    expect(stored).toEqual({ ok: false, status: 400, reason: "blocked_host", message: MCP_COPY.photoNotDownloaded(1) });
    expect(connected).toBe(false);
    expect(put).not.toHaveBeenCalled();

    const literal = await readPhoto({ download_url: "https://127.0.0.1/file" }, {});
    expect(literal).toMatchObject({ ok: false, message: MCP_COPY.photoNotDownloaded(1) });
  });
});

describe("storePackPhotos", () => {
  it("reads three at a time and keeps the request's order and de-duplication", async () => {
    let inFlight = 0;
    let most = 0;
    const delays: Record<string, number> = { a: 30, b: 5, c: 15, d: 1, e: 10 };
    const fetchPhoto = vi.fn(async (url: string) => {
      const name = new URL(url).pathname.slice(1);
      inFlight += 1;
      most = Math.max(most, inFlight);
      await new Promise((resolve) => setTimeout(resolve, delays[name] ?? 1));
      inFlight -= 1;
      return pngPhoto(name === "e" ? "a" : name);
    });
    const put = vi.fn(async () => true);
    const photos = [attachment("a"), attachment("b"), attachment("c"), attachment("d"), attachment("e")];
    const stored = await storePackPhotos(WS, photos, { store: true, fetchPhoto, put });
    expect(most).toBe(PACK_PHOTO_FETCH_CONCURRENCY);
    expect(stored.ok).toBe(true);
    if (!stored.ok) return;
    // e is the same photo as a: one upload, in a's place.
    expect(stored.uploads.map((upload) => upload.sha256[0])).toEqual(["a", "b", "c", "d"]);
    expect(put).toHaveBeenCalledTimes(4);
    expect(stored.created).toHaveLength(4);
  });

  it("answers the first refusal in order, starts nothing after it and takes back what it stored", async () => {
    const started: string[] = [];
    const fetchPhoto = vi.fn(async (url: string) => {
      const name = new URL(url).pathname.slice(1);
      started.push(name);
      if (name === "b") {
        return { ok: false as const, reason: "not_image" as const, message: "Not an image." };
      }
      if (name === "a") {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { ok: false as const, reason: "too_large" as const, message: "Too large." };
      }
      return pngPhoto(name);
    });
    const put = vi.fn(async () => true);
    const remove = vi.fn(async () => [] as string[]);
    const photos = ["a", "b", "c", "d", "e", "f"].map((name) => attachment(name));
    const stored = await storePackPhotos(WS, photos, { store: true, fetchPhoto, put, remove });
    expect(stored).toEqual({ ok: false, status: 422, reason: "too_large", message: MCP_COPY.photoTooLarge(1) });
    expect(started).toEqual(["a", "b", "c"]);
    const removed: unknown[] = remove.mock.calls.flat(2);
    expect(removed.every((key) => typeof key === "string" && key.startsWith(`ws/${WS}/src/api-`))).toBe(true);
  });

  it("holds one deadline for the whole set", async () => {
    const fetchPhoto = vi.fn(() => new Promise<PhotoImportResult>(() => undefined));
    const started = Date.now();
    const chat = await storePackPhotos(WS, [attachment("slow")], { store: false, fetchPhoto, deadlineMs: 40 });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(chat).toEqual({ ok: false, status: 504, reason: "timeout", message: MCP_COPY.photoTimeout(1) });

    const api = await storePackPhotos(WS, [{ url: "https://shop.example/slow.png" }], { store: false, fetchPhoto, deadlineMs: 20 });
    expect(api).toMatchObject({ ok: false, status: 504, reason: "timeout" });
    expect(api.ok ? "" : api.message).toMatch(/^Photo 1: /);
  });

  it("keeps the public API's copy for links unless the assistant audience is asked for", async () => {
    const fetchPhoto = vi.fn(async () => ({ ok: false as const, reason: "unreachable" as const, message: "We could not download that photo. Try again, or add it with Choose a file." }));
    const api = await storePackPhotos(WS, [{ url: "https://shop.example/a.png" }], { store: false, fetchPhoto });
    expect(api.ok ? "" : api.message).toBe("Photo 1: We could not download that photo. Try again, or add it with Choose a file.");
    const assistant = await storePackPhotos(WS, [{ url: "https://shop.example/a.png" }], { store: false, fetchPhoto, audience: "assistant" });
    expect(assistant.ok ? "" : assistant.message).toBe(MCP_COPY.photoNotDownloaded(1));
  });

  it("never stores or logs download_url or file_id", async () => {
    const logged: string[] = [];
    for (const method of ["log", "info", "warn", "error"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        logged.push(args.map((arg) => (arg instanceof Error ? `${arg.name} ${arg.message}` : String(arg))).join(" "));
      });
    }
    const fetchPhoto = vi.fn(async () => pngPhoto("a"));
    const put = vi.fn(async (_ws: string, _photo: unknown, _key: string) => {
      throw new Error("storage down");
    });
    const photo = attachment("secret");
    const stored = await storePackPhotos(WS, [photo], { store: true, fetchPhoto, put });
    expect(stored).toMatchObject({ ok: false, status: 503, reason: "storage" });
    const written = JSON.stringify(put.mock.calls.map(([ws, value, key]) => [ws, Object.keys(value as object), key]));
    const everything = `${written} ${logged.join(" ")} ${JSON.stringify(stored)}`;
    expect(everything).not.toContain(photo.download_url);
    expect(everything).not.toContain(FILE_HOST);
    expect(everything).not.toContain(photo.file_id);
  });
});

describe("readPackPhotos", () => {
  it("reads sizes, hashes and angles without storing anything", async () => {
    const fetchPhoto = vi.fn(async (url: string) => pngPhoto(new URL(url).pathname.endsWith("b") ? "b" : "a", 500));
    const read = await readPackPhotos([{ ...attachment("a") }, { url: "https://shop.example/b", angle: "back" }, attachment("a")], { fetchPhoto });
    expect(read).toEqual({
      ok: true,
      photos: [
        { sha256: "a".repeat(64), width: 500, height: 500 },
        { sha256: "b".repeat(64), width: 500, height: 500, angle: "back" },
      ],
    });
  });
});

describe("the actions with chat attachments", () => {
  function contextFor(caller: ApiCaller, photos: PhotoDeps): ApiContext {
    return { caller, headers: new Headers({ "x-forwarded-for": "203.0.113.5" }), photos };
  }

  it("create_pack stores attached photos by their hash and starts the listing pack", async () => {
    setRateLimitStoreForTests(new MemoryRateLimitStore());
    vi.stubEnv("R2_ACCOUNT_ID", "acct");
    vi.stubEnv("R2_ACCESS_KEY_ID", "id");
    vi.stubEnv("R2_SECRET_ACCESS_KEY", "secret");
    const caller = oauthCaller();
    const fetchPhoto = vi.fn(async () => pngPhoto("a"));
    const put = vi.fn(async () => true);
    const remove = vi.fn(async () => [] as string[]);
    await createPack(contextFor(caller, { fetchPhoto, put, remove }), { channels: ["amazon.main"], images: [attachment("a")] }, "k-chat");
    const key = `ws/${WS}/src/api-${"a".repeat(64)}`;
    expect(fetchPhoto).toHaveBeenCalledWith(attachment("a").download_url);
    expect(caller.services.createJob).toHaveBeenCalledWith(
      WS,
      expect.objectContaining({ mode: "listing", uploads: [{ key, sha256: "a".repeat(64), kind: "image" }] }),
    );
    const input = JSON.stringify(vi.mocked(caller.services.createJob).mock.calls[0]);
    expect(input).not.toContain(FILE_HOST);
    expect(input).not.toContain("file-a");
  });

  it("create_pack answers a missing or placeholder attachment, and refuses photos and images together", async () => {
    setRateLimitStoreForTests(new MemoryRateLimitStore());
    const caller = oauthCaller();
    const fetchPhoto = vi.fn();
    for (const images of ["attached.jpg", [], [{ file_id: "file-a" }], null]) {
      const result = await createPack(contextFor(caller, { fetchPhoto }), { channels: ["amazon.main"], images }, "k-missing");
      expect(result).toMatchObject({ status: 400, body: { reason: NO_ATTACHMENT.reason, error: MCP_COPY.noAttachment } });
    }
    const both = await createPack(
      contextFor(caller, { fetchPhoto }),
      { channels: ["amazon.main"], images: [attachment("a")], photos: [{ url: "https://shop.example/a.png" }] },
      "k-both",
    );
    expect(both).toMatchObject({ status: 400, body: { reason: "invalid_request", issues: [MCP_COPY.photoSourcesBoth] } });
    expect(fetchPhoto).not.toHaveBeenCalled();
    expect(caller.services.createJob).not.toHaveBeenCalled();
  });

  it("check_main_image reads an attached image and answers a missing one", async () => {
    setRateLimitStoreForTests(new MemoryRateLimitStore());
    const caller = oauthCaller();
    const body = await mainImagePng(1600, 0.85);
    const fetchPhoto = vi.fn(async () => ({
      ok: true as const,
      photo: { body, contentType: "image/png" as const, sha256: "c".repeat(64), width: 1600, height: 1600 },
    }));
    const checked = await checkMainImage(contextFor(caller, { fetchPhoto }), { image: attachment("main") });
    expect(checked.status).toBe(200);
    expect(checked.body).toMatchObject({ pass: true, width: 1600, height: 1600 });
    expect(fetchPhoto).toHaveBeenCalledWith(attachment("main").download_url);

    const missing = await checkMainImage(contextFor(caller, { fetchPhoto }), { image: "the photo above" });
    expect(missing).toMatchObject({ status: 400, body: { reason: NO_ATTACHMENT.reason, error: MCP_COPY.noAttachment } });
  });
});
