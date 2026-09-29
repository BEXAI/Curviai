import { describe, expect, it } from "vitest";
import { z } from "zod";
import { IntakeResult, ProductProfile, QCVerdict, ShotList, strictToolSchema } from "./schemas";

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
