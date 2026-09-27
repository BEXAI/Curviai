import { describe, expect, it } from "vitest";
import { getSpec, type ChannelSpec } from "@curvi/specs";
import { rawCanvas, rectMask, paintRect } from "../testutil";
import { QC_THRESHOLDS, pixelChecks, qcKindForSpec, semanticChecks } from "./pixelChecks";
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
