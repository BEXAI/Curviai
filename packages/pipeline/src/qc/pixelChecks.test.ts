import { describe, expect, it } from "vitest";
import { getSpec, listSpecs, type ChannelSpec } from "@curvi/specs";
import { rawCanvas, rectMask, paintRect } from "../testutil";
import type { RawImage } from "../raw";
import {
  MASK_MISSING,
  QC_THRESHOLDS,
  minLongSideFor,
  pixelChecks,
  qcKindForSpec,
  semanticChecks,
} from "./pixelChecks";
import { MockEmbeddingCosineCheck, MockOcrTextCheck } from "./testing";

const smallMainSpec: ChannelSpec = {
  id: "amazon.main",
  verified: true,
  width: 256,
  height: 256,
  minLongSide: 256,
  formats: ["jpg", "png"],
  maxBytes: 1_000_000,
  background: { type: "solid", rgb: [255, 255, 255], tolerance: 0 },
  fill: { min: 0.85, max: 0.9 },
  textAllowed: false,
};

const box = { left: 12, top: 12, width: 224, height: 224 };

describe("qcKindForSpec", () => {
  it("treats pure white solid no text specs as main", () => {
    expect(qcKindForSpec(getSpec("amazon.main"))).toBe("main");
    expect(qcKindForSpec(getSpec("walmart.main"))).toBe("main");
    expect(qcKindForSpec(getSpec("shopify.product"))).toBe("other");
    expect(qcKindForSpec(getSpec("meta.feed_1x1"))).toBe("other");
  });
});

describe("pixelChecks", () => {
  it("passes a clean white background main image", async () => {
    const img = rawCanvas(256, 256, 255, 255, 255);
    paintRect(img, box, 120, 40, 40);
    const mask = rectMask(256, 256, box);
    const report = await pixelChecks(img, mask, smallMainSpec, {
      encoded: { bytes: 50_000, format: "jpg" },
    });
    expect(report.backgroundWhiteShare).toBe(1);
    expect(report.fillRatio).toBeCloseTo(224 / 256, 5);
    expect(report.pass).toBe(true);
  });

  it("catches a 254 near white background (suppression risk)", async () => {
    const img = rawCanvas(256, 256, 254, 254, 254);
    paintRect(img, box, 120, 40, 40);
    const mask = rectMask(256, 256, box);
    const report = await pixelChecks(img, mask, smallMainSpec);
    expect(report.backgroundWhiteShare).toBe(0);
    const bgCheck = report.checks.find((c) => c.name === "backgroundWhiteShare");
    expect(bgCheck?.pass).toBe(false);
    expect(report.pass).toBe(false);
  });

  it("catches a single stray non white background pixel", async () => {
    const img = rawCanvas(256, 256, 255, 255, 255);
    paintRect(img, box, 120, 40, 40);
    img.data[0] = 254;
    const mask = rectMask(256, 256, box);
    const report = await pixelChecks(img, mask, smallMainSpec);
    expect(report.backgroundWhiteShare).toBeLessThan(1);
    expect(report.pass).toBe(false);
  });

  it("fails a fill ratio below the band", async () => {
    const img = rawCanvas(256, 256, 255, 255, 255);
    const smallBox = { left: 100, top: 100, width: 56, height: 56 };
    paintRect(img, smallBox, 120, 40, 40);
    const mask = rectMask(256, 256, smallBox);
    const report = await pixelChecks(img, mask, smallMainSpec);
    const fillCheck = report.checks.find((c) => c.name === "fillRatio");
    expect(fillCheck?.pass).toBe(false);
  });

  it("enforces the 1600 minimum long side for the real amazon main spec", async () => {
    const spec = getSpec("amazon.main");
    const img = rawCanvas(256, 256, 255, 255, 255);
    paintRect(img, box, 10, 10, 10);
    const report = await pixelChecks(img, rectMask(256, 256, box), spec);
    const longSide = report.checks.find((c) => c.name === "longestSide");
    expect(longSide?.pass).toBe(false);
    expect(String(longSide?.limit)).toContain("1600");
  });

  it("checks bytes and format against the spec", async () => {
    const img = rawCanvas(256, 256, 255, 255, 255);
    paintRect(img, box, 10, 10, 10);
    const mask = rectMask(256, 256, box);
    const report = await pixelChecks(img, mask, smallMainSpec, {
      encoded: { bytes: 2_000_000, format: "webp" },
    });
    expect(report.checks.find((c) => c.name === "bytes")?.pass).toBe(false);
    expect(report.checks.find((c) => c.name === "format")?.pass).toBe(false);
  });

  it("ignores edge transition pixels when an edge margin is given", async () => {
    const img = rawCanvas(256, 256, 255, 255, 255);
    paintRect(img, box, 120, 40, 40);
    // A strip of light gray right above the product edge, as jpeg ringing produces.
    paintRect(img, { left: 12, top: 10, width: 224, height: 2 }, 254, 254, 254);
    const mask = rectMask(256, 256, box);
    const strict = await pixelChecks(img, mask, smallMainSpec);
    expect(strict.backgroundWhiteShare).toBeLessThan(1);
    const withMargin = await pixelChecks(img, mask, smallMainSpec, { edgeMarginPx: 4 });
    expect(withMargin.backgroundWhiteShare).toBe(1);
  });
});

describe("pixelChecks without a mask (Update.md 2.7)", () => {
  it("fails a main image whose generation returned no mask", async () => {
    // A perfectly white, correctly sized main image: before the fix the
    // background and fill rules were skipped and this passed.
    const img = rawCanvas(256, 256, 255, 255, 255);
    paintRect(img, box, 120, 40, 40);
    const report = await pixelChecks(img, null, smallMainSpec, {
      encoded: { bytes: 50_000, format: "jpg" },
    });
    const bg = report.checks.find((c) => c.name === "backgroundWhiteShare");
    const fill = report.checks.find((c) => c.name === "fillRatio");
    expect(bg).toMatchObject({ pass: false, measured: MASK_MISSING });
    expect(fill).toMatchObject({ pass: false, measured: MASK_MISSING });
    expect(report.backgroundWhiteShare).toBeNull();
    expect(report.fillRatio).toBeNull();
    expect(report.pass).toBe(false);
  });

  it("fails the real amazon.main spec at full size without a mask", async () => {
    const spec = getSpec("amazon.main");
    const img: RawImage = { data: Buffer.alloc(0), width: 2000, height: 2000, channels: 4 };
    const report = await pixelChecks(img, null, spec);
    expect(report.checks.find((c) => c.name === "dimensions")?.pass).toBe(true);
    expect(report.pass).toBe(false);
  });

  it("fails a spec fill rule it cannot measure without a mask", async () => {
    const spec = getSpec("google.merchant.main");
    const img: RawImage = { data: Buffer.alloc(0), width: 1000, height: 1000, channels: 4 };
    const report = await pixelChecks(img, null, spec);
    expect(report.checks.find((c) => c.name === "fillRatio")).toMatchObject({ pass: false, measured: MASK_MISSING });
    expect(report.pass).toBe(false);
  });

  it("still passes a spec with no mask dependent rules when the mask is missing", async () => {
    const spec = getSpec("meta.feed_1x1");
    const img: RawImage = { data: Buffer.alloc(0), width: 1080, height: 1080, channels: 4 };
    const report = await pixelChecks(img, null, spec);
    expect(report.checks.map((c) => c.name)).toEqual(["dimensions", "longestSide"]);
    expect(report.pass).toBe(true);
  });
});

describe("pixelChecks exact sizes (Update.md 2.8)", () => {
  const blank = (width: number, height: number): RawImage => ({ data: Buffer.alloc(0), width, height, channels: 4 });

  it("fails a 1080x1080 file against meta.feed_4x5", async () => {
    const report = await pixelChecks(blank(1080, 1080), null, getSpec("meta.feed_4x5"));
    const dims = report.checks.find((c) => c.name === "dimensions");
    expect(dims?.pass).toBe(false);
    expect(dims?.limit).toBe("exactly 1080x1350");
    expect(report.pass).toBe(false);
  });

  it("passes the exact 1080x1350 size for meta.feed_4x5", async () => {
    const report = await pixelChecks(blank(1080, 1350), null, getSpec("meta.feed_4x5"));
    expect(report.pass).toBe(true);
  });

  it("fails a smaller file of the right shape for an exact spec", async () => {
    const report = await pixelChecks(blank(800, 1000), null, getSpec("meta.feed_4x5"));
    expect(report.checks.find((c) => c.name === "dimensions")?.pass).toBe(false);
    expect(report.checks.find((c) => c.name === "longestSide")?.pass).toBe(false);
  });

  it("still accepts a 1600x1600 amazon.main image", async () => {
    const report = await pixelChecks(blank(1600, 1600), null, getSpec("amazon.main"));
    expect(report.checks.find((c) => c.name === "dimensions")?.pass).toBe(true);
    expect(report.checks.find((c) => c.name === "longestSide")?.pass).toBe(true);
  });

  it("passes every registry image spec at its own render size", async () => {
    for (const spec of listSpecs()) {
      if (spec.width === undefined || spec.height === undefined) {
        continue;
      }
      const report = await pixelChecks(blank(spec.width, spec.height), null, spec);
      const failed = report.checks
        .filter((c) => (c.name === "dimensions" || c.name === "longestSide") && !c.pass)
        .map((c) => `${spec.id} ${c.name} ${c.measured} vs ${c.limit}`);
      expect(failed).toEqual([]);
    }
  });

  it("derives the minimum long side from the spec, the main fallback or the exact size", () => {
    expect(minLongSideFor(getSpec("amazon.main"))).toBe(1600);
    expect(minLongSideFor(getSpec("meta.feed_4x5"))).toBe(1350);
    expect(minLongSideFor(getSpec("walmart.main"))).toBe(QC_THRESHOLDS.main.minLongSide);
    expect(minLongSideFor(getSpec("ebay.listing"))).toBe(500);
    expect(minLongSideFor(smallMainSpec)).toBe(256);
  });
});

describe("QC threshold table", () => {
  it("matches section 5.6", () => {
    expect(QC_THRESHOLDS.main.backgroundWhiteShareAfterForcing).toBe(1.0);
    expect(QC_THRESHOLDS.main.fillMin).toBe(0.85);
    expect(QC_THRESHOLDS.main.fillMax).toBe(0.9);
    expect(QC_THRESHOLDS.main.minLongSide).toBe(1600);
    expect(QC_THRESHOLDS.main.maxMeanDeltaE).toBe(3.0);
    expect(QC_THRESHOLDS.other.maxMeanDeltaE).toBe(5.0);
    expect(QC_THRESHOLDS.main.minLabelOcrMatch).toBe(0.95);
    expect(QC_THRESHOLDS.other.minLabelOcrMatch).toBe(0.92);
    expect(QC_THRESHOLDS.main.minEmbeddingCosine).toBe(0.92);
    expect(QC_THRESHOLDS.other.minEmbeddingCosine).toBe(0.88);
  });
});

describe("semanticChecks (pluggable OCR and embedding)", () => {
  it("passes with explicitly provided mock engines and runs the stray text check on main", async () => {
    const img = rawCanvas(64, 64, 255, 255, 255);
    const mask = rectMask(64, 64, { left: 8, top: 8, width: 48, height: 48 });
    const result = await semanticChecks(
      img,
      img,
      mask,
      "main",
      new MockOcrTextCheck(),
      new MockEmbeddingCosineCheck(),
    );
    expect(result.pass).toBe(true);
    expect(result.checks.map((c) => c.name.split(" ")[0])).toEqual([
      "ocrNonProductText",
      "labelOcrMatch",
      "embeddingCosine",
    ]);
  });

  it("regression: cannot be called without engines, so omitting them can no longer silently pass the gates", () => {
    const img = rawCanvas(8, 8, 0, 0, 0);
    const mask = rectMask(8, 8, { left: 0, top: 0, width: 8, height: 8 });
    // Type level enforcement, validated by pnpm typecheck. The old signature
    // defaulted both engines to perfect score mocks; the call below must not
    // compile anymore. The arrow is never invoked.
    const illegal = () =>
      // @ts-expect-error semanticChecks requires explicit ocr and embedding engines
      semanticChecks(img, img, mask, "main");
    const alsoIllegal = () =>
      // @ts-expect-error semanticChecks requires an explicit embedding engine
      semanticChecks(img, img, mask, "main", new MockOcrTextCheck());
    expect(typeof illegal).toBe("function");
    expect(typeof alsoIllegal).toBe("function");
    expect(semanticChecks.length).toBe(6);
  });

  it("fails when a custom embedding check reports low similarity", async () => {
    const img = rawCanvas(64, 64, 255, 255, 255);
    const mask = rectMask(64, 64, { left: 8, top: 8, width: 48, height: 48 });
    const lowCosine = { name: "low", cosine: async () => 0.5 };
    const result = await semanticChecks(img, img, mask, "other", new MockOcrTextCheck(), lowCosine);
    expect(result.pass).toBe(false);
  });

  it("mock checks report perfect scores", async () => {
    const ocr = new MockOcrTextCheck();
    const embedding = new MockEmbeddingCosineCheck();
    const img = rawCanvas(8, 8, 0, 0, 0);
    const mask = rectMask(8, 8, { left: 0, top: 0, width: 8, height: 8 });
    expect(await ocr.nonProductText(img, mask)).toBe("");
    expect(await ocr.labelMatch(img, img, mask)).toBe(1);
    expect(await embedding.cosine(img, img, mask)).toBe(1);
  });
});

describe("backgroundMatchesChoice (PHASE_15 P1)", () => {
  const spec = getSpec("meta.feed_1x1");
  const sage: [number, number, number] = [0xdd, 0xe4, 0xd8];
  const find = (report: Awaited<ReturnType<typeof pixelChecks>>) =>
    report.checks.find((c) => c.name === "backgroundMatchesChoice");

  it("passes a background within the seeded CIEDE2000 limit of the chosen color", async () => {
    const img = rawCanvas(1080, 1080, ...sage);
    const mask = rectMask(1080, 1080, { left: 300, top: 300, width: 400, height: 400 });
    paintRect(img, { left: 300, top: 300, width: 400, height: 400 }, 200, 20, 30);
    const report = await pixelChecks(img, mask, spec, { expectedBackground: sage });
    expect(find(report)).toMatchObject({ pass: true, measured: 0 });
    expect(QC_THRESHOLDS.backdropMaxDeltaE).toBe(2);
  });

  it("fails a background that drifted from the chosen color", async () => {
    const img = rawCanvas(1080, 1080, 0xc8, 0xe4, 0xd8);
    const mask = rectMask(1080, 1080, { left: 300, top: 300, width: 400, height: 400 });
    const report = await pixelChecks(img, mask, spec, { expectedBackground: sage });
    const check = find(report)!;
    expect(check.pass).toBe(false);
    expect(check.measured as number).toBeGreaterThan(QC_THRESHOLDS.backdropMaxDeltaE);
    expect(report.pass).toBe(false);
  });

  it("fails closed without a mask, and does not run unless asked", async () => {
    const img = rawCanvas(1080, 1080, ...sage);
    expect(find(await pixelChecks(img, null, spec, { expectedBackground: sage }))).toMatchObject({
      pass: false,
      measured: MASK_MISSING,
    });
    expect(find(await pixelChecks(img, null, spec))).toBeUndefined();
  });
});
