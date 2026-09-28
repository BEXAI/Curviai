/**
 * End to end check for the newer marketplaces the planner targets (Etsy,
 * eBay, Walmart, TikTok Shop, Pinterest): every image kind it plans for a
 * spec is rendered with the same pipeline helpers the live renderers use,
 * and the result must pass that spec's pixel checks from the registry (size,
 * long side, background, fill, bytes and format). Nothing here is generated:
 * the planner only sends deterministic and template images to these specs.
 */
import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { getSpec, type ChannelSpec } from "@curvi/specs";
import { makeAmazonMain, makeSweep } from "../deterministic/whiten";
import { decodeMask, decodeToRgba } from "../raw";
import { pixelChecks, type PixelCheckReport } from "../qc/pixelChecks";
import type { ProductProfile, Shot } from "../schemas";
import { stillStyle } from "../seed/templates";
import { renderTemplateStill, type TemplateStillType } from "../templates/still";
import { rectProduct } from "../testutil";
import { planShots } from "./deterministic";

const profile: ProductProfile = {
  productCount: 1,
  category: "home_kitchen",
  amazonProductTypeGuess: "KITCHEN",
  shopifyTaxonomyGuess: "Home & Garden > Kitchen",
  name: "Ceramic pour over mug",
  formFactor: "mug",
  materials: ["ceramic"],
  dominantColors: [{ name: "cream", hex: "#F2E8D8", coveragePct: 70 }],
  dimensions: { value: "10 x 10 x 12 cm", source: "user" },
  preserveText: [],
  preserveLogos: [],
  surface: { reflective: false, transparent: false, textured: false },
  features: ["pour over rim"],
  benefits: ["keeps coffee hot", "easy grip handle", "fits any dripper"],
  targetBuyer: "home coffee drinkers",
  useContexts: ["morning kitchen counter", "office desk"],
  photographedAngles: ["front", "45", "back"],
  missingAnglesNeeded: [],
  complianceFlags: ["none"],
  imageQuality: { usableForMain: true, issues: [] },
};

/** Shot types whose live renderer is not built yet; they go to needs review. */
const NOT_RENDERED_LIVE = new Set<Shot["type"]>(["in_the_box", "comparison"]);

async function product(): Promise<{ source: Buffer; mask: Buffer; productPng: Buffer }> {
  const p = await rectProduct(256, "rgb(30,110,170)");
  const rgba = await decodeToRgba(p.source);
  const mask = await decodeMask(p.mask);
  for (let i = 0; i < mask.data.length; i++) {
    rgba.data[i * 4 + 3] = mask.data[i];
  }
  const productPng = await sharp(rgba.data, { raw: { width: rgba.width, height: rgba.height, channels: 4 } })
    .png()
    .toBuffer();
  return { source: p.source, mask: p.mask, productPng };
}

/** Renders one planned shot for the spec and measures it. */
async function renderAndCheck(shot: Shot, spec: ChannelSpec): Promise<PixelCheckReport> {
  const { source, mask, productPng } = await product();
  switch (shot.type) {
    case "amazon_main":
    case "alt_angle_white": {
      const main = await makeAmazonMain(source, mask, spec);
      return pixelChecks(main.raw, main.mask, spec, {
        encoded: { bytes: main.jpeg.length, format: "jpg" },
        edgeMarginPx: 2,
      });
    }
    case "sweep_gray":
    case "sweep_brand": {
      const hex = shot.type === "sweep_gray" ? stillStyle.sweepGrayHex : stillStyle.fallbackBrandHex;
      const sweep = await makeSweep(source, mask, hex, { width: spec.width, height: spec.height });
      return pixelChecks(sweep.raw, sweep.mask, spec, {
        encoded: { bytes: sweep.jpeg.length, format: "jpg" },
        edgeMarginPx: 2,
      });
    }
    default: {
      const still = await renderTemplateStill({
        type: shot.type as TemplateStillType,
        spec,
        productPng,
        maskPng: mask,
        callouts: shot.callouts,
        backgroundHex: stillStyle.defaultBackgroundHex,
        textHex: stillStyle.textHex,
        accentHex: stillStyle.accentHex,
      });
      return pixelChecks(still.image, still.mask, spec, {
        encoded: { bytes: still.encoded.buffer.length, format: still.encoded.format },
        edgeMarginPx: 2,
      });
    }
  }
}

describe("files planned for the newer marketplaces pass their spec's pixel checks", () => {
  for (const specId of ["etsy.listing", "ebay.listing", "walmart.main", "tiktokshop.main", "pinterest.pin"]) {
    it(`renders every planned ${specId} image within the spec`, async () => {
      const spec = getSpec(specId);
      const plan = planShots(profile, {
        channels: [specId],
        tier: "growth",
        creditBudget: 100,
        hasBoxContents: true,
        hasComparisonFacts: true,
      });
      const shots = plan.shots.filter((s) => s.channels.includes(specId));
      expect(shots.length).toBeGreaterThan(0);
      // One render per image kind is enough: every alternate angle uses the
      // same helper as the front image.
      const byType = new Map<Shot["type"], Shot>();
      for (const shot of shots) {
        if (!NOT_RENDERED_LIVE.has(shot.type) && shot.type !== "cutout_png" && !byType.has(shot.type)) {
          byType.set(shot.type, shot);
        }
      }
      for (const shot of byType.values()) {
        const report = await renderAndCheck(shot, spec);
        expect(report.checks.filter((c) => !c.pass), `${shot.type} on ${specId}`).toEqual([]);
      }
      // The cutout keeps its alpha, so it only goes where PNG is accepted.
      if (shots.some((s) => s.type === "cutout_png")) {
        expect(spec.formats ?? ["png"]).toContain("png");
      }
    }, 60_000);
  }
});
