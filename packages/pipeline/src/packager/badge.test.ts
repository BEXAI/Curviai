import { describe, expect, it } from "vitest";
import { getSpec, listSpecs } from "@curvi/specs";
import { fidelityReport } from "../qc/fidelity";
import { decodeToRgba, encodeJpeg, encodePng } from "../raw";
import { socialBadgeByTier } from "../seed/credits";
import { paintRect, rawCanvas, rectMask } from "../testutil";
import { applyBadge, badgeEligible, badgePlacement } from "./badge";
import { buildPack, type PackAsset } from "./index";

const SIZE = 400;
const productBox = { left: 120, top: 120, width: 160, height: 160 };

async function socialAsset(format: "png" | "jpg", box = productBox): Promise<PackAsset & { mask: NonNullable<PackAsset["mask"]> }> {
  const raw = rawCanvas(SIZE, SIZE, 236, 230, 220);
  paintRect(raw, box, 40, 90, 160);
  return {
    specId: "meta.feed_1x1",
    buffer: format === "png" ? await encodePng(raw) : await encodeJpeg(raw),
    format,
    mask: rectMask(SIZE, SIZE, box),
    badge: true,
  };
}

function differs(a: Buffer, b: Buffer, x: number, y: number, width: number): boolean {
  const o = (y * width + x) * 4;
  return a[o] !== b[o] || a[o + 1] !== b[o + 1] || a[o + 2] !== b[o + 2];
}

describe("which specs may carry the badge", () => {
  it("allows only badgeAllowed social specs, never a marketplace spec", () => {
    for (const spec of listSpecs()) {
      if (badgeEligible(spec.id)) {
        expect(spec.badgeAllowed, spec.id).toBe(true);
        expect(spec.id).not.toMatch(/^(amazon|shopify|google|etsy|ebay|walmart|tiktokshop)\./);
      }
    }
    expect(badgeEligible("meta.feed_1x1")).toBe(true);
    expect(badgeEligible("amazon.main")).toBe(false);
    expect(badgeEligible("shopify.product")).toBe(false);
  });

  it("puts it on free packs only, by the tier seed", () => {
    expect(socialBadgeByTier.free).toBe(true);
    expect(socialBadgeByTier.starter).toBe(false);
  });
});

describe("badgePlacement", () => {
  const empty = rectMask(SIZE, SIZE, { left: 0, top: 0, width: 0, height: 0 });
  const size = { width: 100, height: 24 };

  it("prefers the bottom right corner", () => {
    expect(badgePlacement({ width: SIZE, height: SIZE }, size, { margin: 10, clearance: 4 }, empty)).toEqual({
      left: 290,
      top: 366,
      ...size,
    });
  });

  it("keeps out of the spec safe zone", () => {
    const box = badgePlacement(
      { width: SIZE, height: SIZE },
      size,
      { margin: 10, clearance: 4, safeZone: { top: 50, bottom: 80 } },
      empty,
    );
    expect(box?.top).toBe(SIZE - 80 - 10 - 24);
  });

  it("moves to another corner when the product reaches the bottom right", () => {
    const mask = rectMask(SIZE, SIZE, { left: 200, top: 200, width: 200, height: 200 });
    const box = badgePlacement({ width: SIZE, height: SIZE }, size, { margin: 10, clearance: 4 }, mask);
    expect(box).toEqual({ left: 10, top: 366, ...size });
  });

  it("gives up when the product fills the frame", () => {
    const mask = rectMask(SIZE, SIZE, { left: 0, top: 0, width: SIZE, height: SIZE });
    expect(badgePlacement({ width: SIZE, height: SIZE }, size, { margin: 10, clearance: 4 }, mask)).toBeNull();
  });
});

describe("applyBadge", () => {
  it("draws the badge in a corner and leaves every product pixel exactly as it was (png)", async () => {
    const asset = await socialAsset("png");
    const before = await decodeToRgba(asset.buffer);
    const outcome = await applyBadge(asset.buffer, "png", asset.specId, asset.mask);
    expect(outcome.applied).toBe(true);
    if (!outcome.applied) return;
    const after = await decodeToRgba(outcome.buffer);
    expect(after.width).toBe(SIZE);
    // Something changed inside the badge box.
    let changed = 0;
    for (let y = outcome.box.top; y < outcome.box.top + outcome.box.height; y++) {
      for (let x = outcome.box.left; x < outcome.box.left + outcome.box.width; x++) {
        if (differs(before.data, after.data, x, y, SIZE)) changed++;
      }
    }
    expect(changed).toBeGreaterThan(0);
    // Rule 3: nothing inside the mask changed.
    const report = await fidelityReport(before, after, asset.mask, { kind: "other" });
    expect(report.exactByteShare).toBe(1);
    expect(report.issues).toEqual([]);
  });

  it("keeps the product within fidelity limits on a jpg re-encode", async () => {
    const asset = await socialAsset("jpg");
    const before = await decodeToRgba(asset.buffer);
    const outcome = await applyBadge(asset.buffer, "jpg", asset.specId, asset.mask);
    expect(outcome.applied).toBe(true);
    if (!outcome.applied) return;
    const report = await fidelityReport(before, await decodeToRgba(outcome.buffer), asset.mask, { kind: "other" });
    expect(report.pass).toBe(true);
  });

  it("refuses a marketplace spec and a file with no mask", async () => {
    const asset = await socialAsset("png");
    expect(await applyBadge(asset.buffer, "png", "amazon.secondary", asset.mask)).toMatchObject({ applied: false });
    expect(await applyBadge(asset.buffer, "png", asset.specId, null)).toMatchObject({
      applied: false,
      reason: expect.stringContaining("mask"),
    });
  });

  it("honors the story safe zone", async () => {
    const spec = getSpec("meta.story_9x16");
    const width = 270;
    const height = 480;
    const raw = rawCanvas(width, height, 240, 240, 240);
    const box = { left: 100, top: 200, width: 70, height: 80 };
    paintRect(raw, box, 10, 10, 10);
    const outcome = await applyBadge(await encodePng(raw), "png", spec.id, rectMask(width, height, box));
    expect(outcome.applied).toBe(true);
    if (!outcome.applied) return;
    // The spec safe zone is given at the spec height (1920), so it scales to this canvas.
    const bottomZone = Math.ceil(((spec.safeZone?.bottom ?? 0) * height) / (spec.height ?? height));
    expect(bottomZone).toBeGreaterThan(0);
    expect(outcome.box.top + outcome.box.height).toBeLessThanOrEqual(height - bottomZone);
  });
});

describe("buildPack with a badge", () => {
  it("draws it on a social file and reports it", async () => {
    const asset = await socialAsset("png");
    const result = await buildPack([asset], ["meta"]);
    const entry = result.report.files[0];
    expect(entry.badge).toBe(true);
    expect(entry.notes.join(" ")).toMatch(/badge applied/);
  });

  it("leaves it off, with a note, when the product covers every corner", async () => {
    const asset = await socialAsset("png", { left: 0, top: 0, width: SIZE, height: SIZE });
    const result = await buildPack([asset], ["meta"]);
    const entry = result.report.files[0];
    expect(entry.badge).toBe(false);
    expect(entry.notes.join(" ")).toMatch(/badge left off: no corner is clear/);
  });

  it("finds the mask through the pixel loader", async () => {
    const asset = await socialAsset("png");
    const { mask, ...rest } = asset;
    const result = await buildPack(
      [{ ...rest, loadPixels: async (bytes) => ({ raw: await decodeToRgba(bytes), mask }) }],
      ["meta"],
    );
    expect(result.report.files[0].badge).toBe(true);
  });
});
