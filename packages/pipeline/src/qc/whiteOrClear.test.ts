import { describe, expect, it } from "vitest";
import { getSpec, type ChannelSpec } from "@curvi/specs";
import { encodeUnderLimit, makeAmazonMain } from "../deterministic/whiten";
import { decodeToRgba, encodePng, solidCanvas } from "../raw";
import { paintRect, rectMask, rectProduct } from "../testutil";
import {
  BACKGROUND_WHITE_OR_CLEAR_ENABLED,
  headerChecks,
  MASK_MISSING,
  needsWhiteOrClear,
  pixelChecks,
  QC_THRESHOLDS,
} from "./pixelChecks";

/** The QC edge margin the runner passes (trigger/src/shot-outputs.ts QC_EDGE_MARGIN_PX). */
const EDGE_MARGIN_PX = 2;
const WHITE_OR_CLEAR_SPECS = ["google.merchant.main", "tiktokshop.main"] as const;
const ON = { backgroundWhiteOrClear: true, edgeMarginPx: EDGE_MARGIN_PX };

function check(report: Awaited<ReturnType<typeof pixelChecks>>, name: string) {
  return report.checks.find((c) => c.name === name);
}

describe("backgroundWhiteOrClear", () => {
  it("covers exactly the white or transparent and white preferred rules, with a 0.999 share", () => {
    expect(QC_THRESHOLDS.whiteOrClearShare).toBe(0.999);
    expect(needsWhiteOrClear(getSpec("google.merchant.main"))).toBe(true);
    expect(needsWhiteOrClear(getSpec("tiktokshop.main"))).toBe(true);
    expect(needsWhiteOrClear(getSpec("amazon.main"))).toBe(false);
    expect(needsWhiteOrClear(getSpec("etsy.listing"))).toBe(false);
  });

  it.each(WHITE_OR_CLEAR_SPECS)("fails a gray background on %s", async (specId) => {
    const image = solidCanvas(1200, 1200, 250, 250, 250);
    const box = { left: 200, top: 200, width: 800, height: 800 };
    paintRect(image, box, 60, 60, 160);
    const report = await pixelChecks(image, rectMask(1200, 1200, box), getSpec(specId), ON);
    expect(check(report, "backgroundWhiteOrClear")).toMatchObject({ pass: false, measured: 0 });
    expect(report.pass).toBe(false);
  });

  it("counts fully transparent pixels as clear", async () => {
    const image = solidCanvas(1200, 1200, 0, 0, 0, 0);
    const box = { left: 200, top: 200, width: 800, height: 800 };
    paintRect(image, box, 60, 60, 160);
    const report = await pixelChecks(image, rectMask(1200, 1200, box), getSpec("google.merchant.main"), ON);
    expect(check(report, "backgroundWhiteOrClear")).toMatchObject({ pass: true, measured: 1 });
  });

  it("fails closed without a mask", async () => {
    const report = await pixelChecks(solidCanvas(1200, 1200, 255, 255, 255), null, getSpec("tiktokshop.main"), ON);
    expect(check(report, "backgroundWhiteOrClear")).toMatchObject({ pass: false, measured: MASK_MISSING });
  });

  /*
   * Why encodeForSpec escapes these specs to PNG (trigger/src/shot-outputs.ts
   * exactBackgroundRgb): the white render passes as rendered and as PNG, but
   * a plain quality 90 JPEG's ringing reaches past the 2 px edge margin. The
   * default stays off until a golden set run passes on the escape.
   */
  it.each(WHITE_OR_CLEAR_SPECS)("passes the white render for %s as rendered and as PNG, not as a plain JPEG", async (specId) => {
    const spec = getSpec(specId);
    const product = await rectProduct(512);
    const main = await makeAmazonMain(product.source, product.mask, spec);
    const share = async (bytes: Buffer) =>
      check(await pixelChecks(await decodeToRgba(bytes), main.mask, spec, ON), "backgroundWhiteOrClear")?.measured as number;

    expect(check(await pixelChecks(main.raw, main.mask, spec, ON), "backgroundWhiteOrClear")?.pass).toBe(true);
    expect(await share(await encodePng(main.raw))).toBeGreaterThanOrEqual(QC_THRESHOLDS.whiteOrClearShare);
    const jpegShare = await share((await encodeUnderLimit(main.raw, spec.maxBytes)).jpeg);
    expect(jpegShare).toBeLessThan(QC_THRESHOLDS.whiteOrClearShare);

    // The check runs by default only once the flag is on.
    const byDefault = await pixelChecks(main.raw, main.mask, spec, { edgeMarginPx: EDGE_MARGIN_PX });
    expect(check(byDefault, "backgroundWhiteOrClear") !== undefined).toBe(BACKGROUND_WHITE_OR_CLEAR_ENABLED);
  });
});

describe("megapixels", () => {
  const capped: ChannelSpec = { ...getSpec("shopify.product"), maxMegapixels: 0.25 };

  it("fails a canvas over spec.maxMegapixels and passes one within it", async () => {
    const over = await pixelChecks(solidCanvas(600, 500, 200, 200, 200), null, capped);
    expect(check(over, "megapixels")).toMatchObject({ pass: false, measured: 0.3 });
    const within = await pixelChecks(solidCanvas(500, 500, 200, 200, 200), null, capped);
    expect(check(within, "megapixels")?.pass).toBe(true);
  });

  it("does not run when the spec sets no cap", async () => {
    const report = await pixelChecks(solidCanvas(600, 500, 200, 200, 200), null, getSpec("etsy.listing"));
    expect(check(report, "megapixels")).toBeUndefined();
  });
});

describe("headerChecks", () => {
  it("checks size, megapixels, bytes and format from the header alone", () => {
    const checks = headerChecks(1500, 1500, getSpec("etsy.listing"), { bytes: 400_000, format: "jpg" });
    expect(checks.map((c) => c.name)).toEqual(["dimensions", "longestSide", "bytes", "format"]);
    expect(checks.every((c) => c.pass)).toBe(true);
    const shopify = headerChecks(6000, 5000, getSpec("shopify.product"), { bytes: 30_000_000, format: "tif" });
    const failed = shopify.filter((c) => !c.pass).map((c) => c.name);
    expect(failed).toEqual(["dimensions", "megapixels", "bytes", "format"]);
  });
});
