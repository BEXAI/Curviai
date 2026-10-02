import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  ADS_SHOT_TYPES,
  APLUS_MODULE_SHOT_TYPES,
  DETERMINISTIC_ONLY_SHOT_TYPES,
  IntakeResult,
  IntakeToolResult,
  LlmShot,
  LlmShotList,
  ProductProfile,
  QCVerdict,
  Shot,
  ShotList,
  strictToolSchema,
} from "./schemas";

const UNSUPPORTED = [
  "$schema",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "pattern",
  "maxItems",
];

function walk(node: unknown, visit: (obj: Record<string, unknown>) => void): void {
  if (Array.isArray(node)) {
    node.forEach((n) => walk(n, visit));
  } else if (node && typeof node === "object") {
    visit(node as Record<string, unknown>);
    Object.values(node as Record<string, unknown>).forEach((n) => walk(n, visit));
  }
}

describe("strictToolSchema", () => {
  for (const [name, schema] of Object.entries({ IntakeResult, ProductProfile, ShotList, QCVerdict })) {
    it(`${name} has only keywords Anthropic strict tool use accepts`, () => {
      const out = strictToolSchema(schema);
      walk(out, (obj) => {
        for (const key of UNSUPPORTED) {
          // A property literally named like a keyword is data, so only check
          // schema nodes (those with a type or a combinator).
          if ("type" in obj || "anyOf" in obj) {
            expect(obj, `${name} keeps ${key}`).not.toHaveProperty(key);
          }
        }
        if (typeof obj.minItems === "number") {
          expect(obj.minItems).toBeLessThanOrEqual(1);
        }
        if (obj.type === "object") {
          expect(obj.additionalProperties).toBe(false);
        }
      });
    });
  }

  it("sends the intake screenshot verdict as an optional boolean", () => {
    const out = strictToolSchema(IntakeResult) as {
      properties: { images: { items: { properties: Record<string, unknown>; required: string[] } } };
    };
    const item = out.properties.images.items;
    expect(item.properties.screenshot).toEqual({ type: "boolean" });
    // Optional, so answers from intake version 1 and older mocks still parse.
    expect(item.required).not.toContain("screenshot");
    expect(item.required).toContain("sellableProduct");
    const base = {
      sellableProduct: true,
      distinctProducts: 1,
      sharpEnough: true,
      flags: { nudity: false, weapons: false, drugs: false, prohibited: false, realPersonMainSubject: false },
    };
    expect(IntakeResult.safeParse({ images: [base] }).success).toBe(true);
    expect(IntakeResult.parse({ images: [{ ...base, screenshot: true }] }).images[0].screenshot).toBe(true);
  });

  it("sends intake version 3's products and seller intent as optional fields", () => {
    const out = strictToolSchema(IntakeResult) as {
      properties: {
        sellerIntent: { properties: Record<string, unknown>; required: string[] };
        images: { items: { properties: Record<string, { items?: { properties: Record<string, unknown> } }>; required: string[] } };
      };
      required: string[];
    };
    expect(out.required).toEqual(["images"]);
    expect(out.properties.sellerIntent.required).toEqual(["featureOnly", "exclude", "mustKeep", "styleNotes"]);
    const item = out.properties.images.items;
    expect(item.required).not.toContain("products");
    const product = item.properties.products.items!;
    expect(Object.keys(product.properties)).toEqual(["label", "box", "matchesIntent"]);
    expect(product.properties.matchesIntent).toMatchObject({ enum: ["yes", "no", "unclear"] });

    const base = {
      sellableProduct: true,
      distinctProducts: 2,
      sharpEnough: true,
      flags: { nudity: false, weapons: false, drugs: false, prohibited: false, realPersonMainSubject: false },
    };
    // A version 2 answer still parses.
    expect(IntakeResult.safeParse({ images: [base] }).success).toBe(true);
    const v3 = IntakeResult.parse({
      images: [
        {
          ...base,
          products: [
            { label: "red bottle", box: { x: 0.05, y: 0.1, width: 0.4, height: 0.8 }, matchesIntent: "no" },
            { label: "blue bottle", box: { x: 0.55, y: 0.1, width: 0.4, height: 0.8 }, matchesIntent: "yes" },
          ],
        },
      ],
      sellerIntent: { featureOnly: "blue bottle", exclude: ["red bottle"], mustKeep: [], styleNotes: null },
    });
    expect(v3.images[0].products?.[1].matchesIntent).toBe("yes");
    expect(v3.sellerIntent?.exclude).toEqual(["red bottle"]);
    // Boxes are normalized to the image, so a pixel box is refused.
    expect(
      IntakeResult.safeParse({
        images: [{ ...base, products: [{ label: "x", box: { x: 40, y: 10, width: 300, height: 400 }, matchesIntent: "yes" }] }],
      }).success,
    ).toBe(false);
  });

  it("requires intake version 5's addedOverlays from the model and defaults it to false on read", () => {
    const tool = strictToolSchema(IntakeToolResult) as {
      properties: { images: { items: { properties: Record<string, unknown>; required: string[] } } };
    };
    const item = tool.properties.images.items;
    expect(item.properties.addedOverlays).toEqual({ type: "boolean" });
    expect(item.required).toContain("addedOverlays");
    const base = {
      sellableProduct: true,
      distinctProducts: 1,
      sharpEnough: true,
      flags: { nudity: false, weapons: false, drugs: false, prohibited: false, realPersonMainSubject: false },
    };
    // A version 4 answer, which never asked, reads as a clean photo.
    expect(IntakeResult.parse({ images: [base] }).images[0].addedOverlays).toBe(false);
    expect(IntakeResult.parse({ images: [{ ...base, addedOverlays: true }] }).images[0].addedOverlays).toBe(true);
    expect(IntakeResult.safeParse({ images: [{ ...base, addedOverlays: "yes" }] }).success).toBe(false);
    // The tool schema refuses an answer without it.
    const sellerIntent = { featureOnly: null, exclude: [], mustKeep: [], styleNotes: null };
    const answer = { ...base, screenshot: false, products: [] };
    expect(IntakeToolResult.safeParse({ images: [answer], sellerIntent }).success).toBe(false);
    expect(IntakeToolResult.safeParse({ images: [{ ...answer, addedOverlays: false, restrictedCategory: null }], sellerIntent }).success).toBe(true);
  });

  it("requires intake version 8's restrictedCategory from the model, from the seeded list, and defaults it to null on read", () => {
    const tool = strictToolSchema(IntakeToolResult) as {
      properties: { images: { items: { properties: Record<string, unknown>; required: string[] } } };
    };
    const item = tool.properties.images.items;
    expect(item.required).toContain("restrictedCategory");
    expect(JSON.stringify(item.properties.restrictedCategory)).toContain('"tobacco_nicotine"');
    expect(JSON.stringify(item.properties.restrictedCategory)).toContain("null");
    const base = {
      sellableProduct: true,
      distinctProducts: 1,
      sharpEnough: true,
      flags: { nudity: false, weapons: false, drugs: false, prohibited: false, realPersonMainSubject: false },
    };
    // Answers from versions 1 to 7, which never asked, read as none.
    expect(IntakeResult.parse({ images: [base] }).images[0].restrictedCategory).toBeNull();
    expect(IntakeResult.parse({ images: [{ ...base, restrictedCategory: "self_defense_weapons" }] }).images[0].restrictedCategory).toBe(
      "self_defense_weapons",
    );
    expect(IntakeResult.safeParse({ images: [{ ...base, restrictedCategory: "vape" }] }).success).toBe(false);
    const sellerIntent = { featureOnly: null, exclude: [], mustKeep: [], styleNotes: null };
    const answer = { ...base, screenshot: false, products: [], addedOverlays: false };
    expect(IntakeToolResult.safeParse({ images: [answer], sellerIntent }).success).toBe(false);
    expect(IntakeToolResult.safeParse({ images: [{ ...answer, restrictedCategory: "explosives_fireworks" }], sellerIntent }).success).toBe(true);
  });

  it("keeps property names that match keywords and keeps enums", () => {
    const out = strictToolSchema(
      z.object({ pattern: z.string().regex(/^a/), kind: z.enum(["a", "b"]), tags: z.array(z.string()).min(3).max(5) }),
    ) as { properties: Record<string, Record<string, unknown>>; required: string[] };
    expect(Object.keys(out.properties)).toEqual(["pattern", "kind", "tags"]);
    expect(out.properties.pattern).toEqual({ type: "string" });
    expect(out.properties.kind.enum).toEqual(["a", "b"]);
    expect(out.properties.tags.minItems).toBe(1);
    expect(out.required).toEqual(["pattern", "kind", "tags"]);
  });
});

describe("LlmShot and original_photo", () => {
  // ShotList exactly as it stood before PHASE_15 added original_photo. The
  // plan recipe's tool schema must stay byte for byte this one.
  const PRE_PHASE_15_SHOT = z.object({
    id: z.string(), type: z.enum(["amazon_main","alt_angle_white","cutout_png","sweep_gray","sweep_brand","lifestyle","infographic","dimensions","in_the_box","comparison","aplus_banner","shopify_hero","collection_thumb","social_1x1","social_4x5","social_9x16","social_2x3","video_spin","video_hero_6s","video_lifestyle_15s","video_ugc_hook"]),
    sourceMediaId: z.string(), method: z.enum(["deterministic","composite_generate","edit_generate","template","video_generate","avatar"]),
    channels: z.array(z.string()), stylePreset: z.string(), scene: z.string().max(400).optional(),
    callouts: z.array(z.string().max(40)).max(5).optional(), credits: z.number(), priority: z.number().int()
  });
  const PRE_PHASE_15_SHOT_LIST = z.object({ shots: z.array(PRE_PHASE_15_SHOT).max(40), skipped: z.array(z.object({ type: z.string(), reason: z.string() })) });

  const original = {
    id: "o1",
    type: "original_photo",
    sourceMediaId: "ws/a/src/front.jpg",
    method: "deterministic",
    channels: ["amazon.secondary"],
    stylePreset: "none",
    credits: 0.5,
    priority: 1,
  };

  it("keeps the plan recipe's strict tool schema byte for byte", () => {
    expect(JSON.stringify(strictToolSchema(LlmShotList))).toBe(JSON.stringify(strictToolSchema(PRE_PHASE_15_SHOT_LIST)));
    expect(JSON.stringify(z.toJSONSchema(LlmShotList))).toBe(JSON.stringify(z.toJSONSchema(PRE_PHASE_15_SHOT_LIST)));
  });

  it("accepts original_photo on Shot and rejects it on LlmShot", () => {
    expect(Shot.safeParse(original).success).toBe(true);
    expect(ShotList.safeParse({ shots: [original], skipped: [] }).success).toBe(true);
    expect(LlmShot.safeParse(original).success).toBe(false);
    expect(LlmShotList.safeParse({ shots: [original], skipped: [] }).success).toBe(false);
    expect(LlmShot.safeParse({ ...original, type: "amazon_main" }).success).toBe(true);
  });

  it("leaves out exactly the deterministic only types, the A+ modules and the ads formats", () => {
    const llm: readonly string[] = LlmShot.shape.type.options;
    expect(Shot.shape.type.options.filter((t) => !llm.includes(t))).toEqual([
      ...DETERMINISTIC_ONLY_SHOT_TYPES,
      ...APLUS_MODULE_SHOT_TYPES,
      ...ADS_SHOT_TYPES,
    ]);
    for (const field of ["headline", "carouselId", "slideIndex", "slideCount", "variantKey", "cta"]) {
      expect(Object.keys(LlmShot.shape)).not.toContain(field);
    }
  });
});
