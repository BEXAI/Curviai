import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { INGEST_NOTICES, ingestUpload } from "./ingest";
import { MemoryTrustStorage, type TrustStorage } from "./storage";

// sharp is a dependency of @curvi/pipeline, not of the web app; the tests
// borrow it from there to build fixtures and inspect results.
const sharp = createRequire(new URL("../../../../../packages/pipeline/package.json", import.meta.url))(
  "sharp",
) as any;

const KEY = "ws/11111111-1111-4111-8111-111111111111/src/upload";

async function photoWithExif(): Promise<Buffer> {
  return sharp({ create: { width: 30, height: 20, channels: 3, background: "#c33" } })
    .jpeg()
    .withMetadata({ orientation: 6, exif: { IFD0: { Make: "SecretCam" } } })
    .toBuffer();
}

function box(type: string, payload: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(payload.length + 8, 0);
  head.write(type, 4, "latin1");
  return Buffer.concat([head, payload]);
}

function movie(seconds: number): Buffer {
  const mvhd = Buffer.alloc(100);
  mvhd.writeUInt32BE(1000, 12);
  mvhd.writeUInt32BE(seconds * 1000, 16);
  return Buffer.concat([
    box("ftyp", Buffer.from("isom\0\0\0\0isom", "latin1")),
    box("mdat", Buffer.alloc(2000)),
    box("moov", box("mvhd", mvhd)),
  ]);
}

describe("ingestUpload: photos", () => {
  it("rewrites the object without metadata, upright, and hashes what it stored", async () => {
    const storage = new MemoryTrustStorage();
    storage.seed(KEY, await photoWithExif());
    const outcome = await ingestUpload(storage, KEY, "image");
    expect(outcome).toMatchObject({ ok: true, rewritten: true, width: 20, height: 30 });
    const stored = storage.objects.get(KEY);
    expect(stored?.contentType).toBe("image/jpeg");
    expect(stored?.body.includes(Buffer.from("SecretCam"))).toBe(false);
    expect((await sharp(stored!.body).metadata()).exif).toBeUndefined();
    const expected = createHash("sha256").update(stored!.body).digest("hex");
    expect(outcome.ok && outcome.sha256).toBe(expected);
  });

  it("refuses a file that only claims to be a photo, and deletes it", async () => {
    const storage = new MemoryTrustStorage();
    storage.seed(KEY, Buffer.from("<html><body>not a photo</body></html>"));
    const outcome = await ingestUpload(storage, KEY, "image");
    expect(outcome).toMatchObject({ ok: false, retryable: false });
    expect(storage.objects.has(KEY)).toBe(false);
  });

  it("refuses a photo over 25 MB before downloading it", async () => {
    let downloaded = false;
    const storage: TrustStorage = {
      ...new MemoryTrustStorage(),
      head: async () => ({ bytes: 26 * 1024 * 1024 }),
      get: async () => {
        downloaded = true;
        return Buffer.alloc(0);
      },
      getRange: async () => new Uint8Array(),
      put: async () => {},
      list: async () => [],
      deleteMany: async () => [],
    };
    expect(await ingestUpload(storage, KEY, "image")).toEqual({
      ok: false,
      retryable: false,
      notice: INGEST_NOTICES.imageTooLarge,
    });
    expect(downloaded).toBe(false);
  });

  it("reports a missing upload", async () => {
    expect(await ingestUpload(new MemoryTrustStorage(), KEY, "image")).toMatchObject({
      ok: false,
      notice: INGEST_NOTICES.missing,
    });
  });

  it("treats a storage error as retryable and deletes nothing", async () => {
    const storage = new MemoryTrustStorage();
    storage.seed(KEY, await photoWithExif());
    storage.get = async () => {
      throw new Error("R2 is down");
    };
    expect(await ingestUpload(storage, KEY, "image")).toEqual({
      ok: false,
      retryable: true,
      notice: INGEST_NOTICES.unavailable,
    });
    expect(storage.objects.has(KEY)).toBe(true);
  });
});

describe("ingestUpload: videos", () => {
  it("accepts a video up to 60 seconds, keeping the object as is", async () => {
    const storage = new MemoryTrustStorage();
    storage.seed(KEY, movie(60));
    expect(await ingestUpload(storage, KEY, "video")).toMatchObject({ ok: true, sha256: null, rewritten: false });
    expect(storage.objects.has(KEY)).toBe(true);
  });

  it("refuses a video over 60 seconds and deletes it", async () => {
    const storage = new MemoryTrustStorage();
    storage.seed(KEY, movie(61));
    expect(await ingestUpload(storage, KEY, "video")).toMatchObject({ ok: false, notice: INGEST_NOTICES.videoTooLong });
    expect(storage.objects.has(KEY)).toBe(false);
  });

  it("refuses a photo sent as a video", async () => {
    const storage = new MemoryTrustStorage();
    storage.seed(KEY, await photoWithExif());
    expect(await ingestUpload(storage, KEY, "video")).toMatchObject({ ok: false, notice: INGEST_NOTICES.notVideo });
  });

  it("refuses a video whose length cannot be read", async () => {
    const storage = new MemoryTrustStorage();
    storage.seed(KEY, box("ftyp", Buffer.from("isom\0\0\0\0isom", "latin1")));
    expect(await ingestUpload(storage, KEY, "video")).toMatchObject({ ok: false, notice: INGEST_NOTICES.videoUnreadable });
  });
});
