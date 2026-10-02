import { afterAll, describe, expect, it } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { endExiftool, readDigitalSourceType } from "../metadata/iptc";
import { buildPack, type PackAsset } from "./index";

/**
 * Delivered files carry the IPTC label Google Merchant Center asks for on
 * images made with generative AI, in every format a channel ships (P18-09
 * part 2). The round trips in metadata/iptc.test.ts cover the tag itself;
 * this covers the packager writing it before the loose file is written (the
 * channel zip holds the same buffer).
 */

type Format = "jpg" | "png" | "webp";

async function sceneBuffer(format: Format): Promise<Buffer> {
  const base = sharp({
    create: { width: 96, height: 96, channels: 3, background: { r: 210, g: 190, b: 160 } },
  });
  if (format === "png") {
    return base.png().toBuffer();
  }
  if (format === "webp") {
    return base.webp({ quality: 90 }).toBuffer();
  }
  return base.jpeg({ quality: 90 }).toBuffer();
}

afterAll(async () => {
  await endExiftool();
});

describe("buildPack IPTC labeling", () => {
  it.each<Format>(["jpg", "png", "webp"])("tags a composited scene delivered as %s", async (format) => {
    const outDir = await mkdtemp(path.join(tmpdir(), "curvi-pack-iptc-"));
    const asset: PackAsset = {
      specId: "shopify.product",
      buffer: await sceneBuffer(format),
      format,
      seoSlug: "amber-candle",
      n: 1,
      digitalSource: "composite",
    };
    const result = await buildPack([asset], ["shopify"], { outDir, writeFiles: true });

    const report = result.report.files[0];
    expect(report?.digitalSource).toBe("composite");
    const loose = path.join(outDir, "files", "shopify", report?.file ?? "");
    expect(path.extname(loose)).toBe(`.${format}`);
    expect(await readDigitalSourceType(loose)).toBe("composite");
    const meta = await sharp(await readFile(loose)).metadata();
    expect(meta.format).toBe(format === "jpg" ? "jpeg" : format);
  });

  it("leaves a deterministic edit of the seller's photo without an AI label", async () => {
    const outDir = await mkdtemp(path.join(tmpdir(), "curvi-pack-iptc-"));
    const asset: PackAsset = {
      specId: "shopify.product",
      buffer: await sceneBuffer("png"),
      format: "png",
      seoSlug: "amber-candle",
      n: 1,
      digitalSource: "none",
    };
    const result = await buildPack([asset], ["shopify"], { outDir, writeFiles: true });
    const loose = path.join(outDir, "files", "shopify", result.report.files[0]?.file ?? "");
    expect(await readDigitalSourceType(loose)).toBe("none");
  });
});
