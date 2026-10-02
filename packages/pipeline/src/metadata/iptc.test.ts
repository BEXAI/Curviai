import { afterAll, describe, expect, it } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import {
  endExiftool,
  readDigitalSourceType,
  readDigitalSourceTypeValue,
  writeDigitalSourceType,
  type DigitalSourceKind,
} from "./iptc";

type Format = "jpeg" | "png" | "webp";

const EXTENSIONS: Record<Format, string> = { jpeg: "jpg", png: "png", webp: "webp" };

/** A small encoded file of each format the packager can deliver. */
async function encoded(format: Format): Promise<Buffer> {
  const base = sharp({
    create: { width: 64, height: 64, channels: 3, background: { r: 200, g: 200, b: 200 } },
  });
  if (format === "png") {
    return base.png().toBuffer();
  }
  if (format === "webp") {
    return base.webp({ quality: 90 }).toBuffer();
  }
  return base.jpeg({ quality: 90 }).toBuffer();
}

async function tempFile(format: Format, name: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "curvi-iptc-"));
  const file = path.join(dir, `${name}.${EXTENSIONS[format]}`);
  await writeFile(file, await encoded(format));
  return file;
}

afterAll(async () => {
  await endExiftool();
});

// The packager tags delivered files in place whatever their format
// (packager/index.ts), and channel specs ship JPEG, PNG and WebP, so the
// label Google Merchant Center asks for must survive in all three
// (P18-09 part 2).
describe.each<Format>(["jpeg", "png", "webp"])("digital source type roundtrip, %s", (format) => {
  it.each<[Exclude<DigitalSourceKind, "none">, string]>([
    ["composite", "http://cv.iptc.org/newscodes/digitalsourcetype/compositeSynthetic"],
    ["trained", "http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia"],
  ])("writes and reads %s", async (kind, uri) => {
    const file = await tempFile(format, kind);
    await writeDigitalSourceType(file, kind);
    expect(await readDigitalSourceType(file)).toBe(kind);
    expect(await readDigitalSourceTypeValue(file)).toBe(uri);
  });

  it("reports none for an untagged file", async () => {
    const file = await tempFile(format, "plain");
    expect(await readDigitalSourceType(file)).toBe("none");
    expect(await readDigitalSourceTypeValue(file)).toBeNull();
  });

  it("removes the tag for kind none", async () => {
    const file = await tempFile(format, "cleared");
    await writeDigitalSourceType(file, "trained");
    expect(await readDigitalSourceType(file)).toBe("trained");
    await writeDigitalSourceType(file, "none");
    expect(await readDigitalSourceType(file)).toBe("none");
  });

  it("keeps the file decodable at its size and format", async () => {
    const file = await tempFile(format, "decodable");
    await writeDigitalSourceType(file, "composite");
    const meta = await sharp(await readFile(file)).metadata();
    expect(meta.format).toBe(format);
    expect(meta.width).toBe(64);
    expect(meta.height).toBe(64);
  });
});
