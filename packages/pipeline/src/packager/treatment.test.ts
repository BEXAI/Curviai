import { createHash } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { encodeJpeg, encodePng } from "../raw";
import { paintRect, rawCanvas, rectMask } from "../testutil";
import { TREATMENT_NOTES, treatmentNotes, type PackAssetTreatment } from "../treatment";
import { buildPack, type PackAsset } from "./index";

const SIZE = 400;
const box = { left: 120, top: 120, width: 160, height: 160 };
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

async function socialAsset(ref: string, treatment?: PackAssetTreatment): Promise<PackAsset> {
  const raw = rawCanvas(SIZE, SIZE, 236, 230, 220);
  paintRect(raw, box, 40, 90, 160);
  return {
    specId: "meta.feed_1x1",
    buffer: await encodePng(raw),
    format: "png",
    mask: rectMask(SIZE, SIZE, box),
    badge: true,
    ref,
    ...(treatment ? { treatment } : {}),
  };
}

describe("buildPack with treatments", () => {
  it("never badges a kept photo or an already white file, and still badges made white files and scenes", async () => {
    const outDir = await mkdtemp(path.join(tmpdir(), "curvi-pack-treatment-"));
    const result = await buildPack(
      [
        await socialAsset("original", { kind: "original", padHex: "#1F2A44", scale: 0.5, sourceWidth: 800, sourceHeight: 800 }),
        await socialAsset("already-white", { kind: "original", alreadyWhite: true }),
        await socialAsset("made-white", { kind: "background", forcedWhite: true }),
        await socialAsset("scene"),
      ],
      ["meta"],
      { outDir },
    );
    const byRef = new Map(result.report.files.map((f) => [f.ref, f]));
    for (const ref of ["original", "already-white"]) {
      const file = byRef.get(ref);
      expect(file?.badge).toBe(false);
      // Skipped with no note.
      expect(file?.notes.some((n) => n.startsWith("badge"))).toBe(false);
    }
    expect(byRef.get("made-white")?.badge).toBe(true);
    expect(byRef.get("scene")?.badge).toBe(true);
    expect(byRef.get("original")?.notes).toEqual(
      expect.arrayContaining([TREATMENT_NOTES.keptAtSellerRequest, TREATMENT_NOTES.padded("#1F2A44"), TREATMENT_NOTES.resizedFrom(800, 800)]),
    );
    expect(byRef.get("already-white")?.notes).toContain(TREATMENT_NOTES.alreadyWhite);
    expect(byRef.get("made-white")?.notes).toContain(TREATMENT_NOTES.whiteRequired);
  });

  it("ships an unchanged file with its sha256 and checks it from the header only", async () => {
    const outDir = await mkdtemp(path.join(tmpdir(), "curvi-pack-unchanged-"));
    const raw = rawCanvas(1500, 1500, 120, 140, 160);
    const stored = await encodeJpeg(raw);
    let decoded = false;
    const result = await buildPack(
      [
        {
          specId: "etsy.listing",
          buffer: stored,
          format: "jpg",
          ref: "unchanged",
          badge: true,
          treatment: { kind: "original_unchanged", scale: 1, sourceWidth: 1500, sourceHeight: 1500 },
          loadPixels: async () => {
            decoded = true;
            throw new Error("an unchanged file is never decoded");
          },
        },
      ],
      ["etsy"],
      { outDir, writeFiles: true },
    );
    const file = result.report.files[0];
    expect(decoded).toBe(false);
    expect(file.pass).toBe(true);
    expect(file.checks.map((c) => c.name)).toEqual(["dimensions", "longestSide", "bytes", "format"]);
    expect(file.notes).toEqual(treatmentNotes({ kind: "original_unchanged", scale: 1, sourceWidth: 1500, sourceHeight: 1500 }));
    const delivered = await readFile(path.join(outDir, "files", "etsy", file.file));
    expect(sha(delivered)).toBe(sha(stored));
    expect((await sharp(delivered).metadata()).exif).toBeUndefined();
  });
});
