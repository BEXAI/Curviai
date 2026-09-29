import { describe, expect, it } from "vitest";
import { IntakeAnswer, IntakeResult, ProductProfile, ProductProfileAnswer, normalizeHex } from "./schemas";

const flags = { nudity: false, weapons: false, drugs: false, prohibited: false, realPersonMainSubject: false };

function product(i: number) {
  return { label: `lipstick ${i}`, box: { x: 0.05 * (i % 10), y: 0.1, width: 0.04, height: 0.3 }, matchesIntent: "unclear" };
}

function intakeWith(products: unknown[], sellerIntent?: unknown) {
  return {
    images: [
      {
        sellableProduct: true,
        distinctProducts: products.length,
        sharpEnough: true,
        screenshot: false,
        products,
        addedOverlays: false,
        flags,
      },
    ],
    ...(sellerIntent === undefined ? {} : { sellerIntent }),
  };
}

function profile(overrides: Record<string, unknown> = {}) {
  return {
    productCount: 1,
    category: "electronics",
    amazonProductTypeGuess: "HEADPHONES",
    shopifyTaxonomyGuess: "Electronics > Audio",
    name: "Wireless headphones",
    formFactor: "over ear",
    materials: ["plastic"],
    dominantColors: [{ name: "black", hex: "#111111", coveragePct: 80 }],
    dimensions: null,
    preserveText: [],
    preserveLogos: [],
    surface: { reflective: false, transparent: false, textured: false },
    features: ["bluetooth"],
    benefits: ["all day comfort"],
    targetBuyer: "commuters",
    useContexts: ["commute"],
    photographedAngles: ["front"],
    missingAnglesNeeded: [],
    complianceFlags: ["none"],
    imageQuality: { usableForMain: true, issues: [] },
    ...overrides,
  };
}

describe("IntakeAnswer (bounds strict tool use cannot send)", () => {
  it("keeps a flat lay of 14 products by cutting the list to 12 instead of failing the pack", () => {
    const raw = intakeWith(Array.from({ length: 14 }, (_, i) => product(i)));
    expect(IntakeResult.safeParse(raw).success).toBe(false);
    const parsed = IntakeAnswer.safeParse(raw);
    expect(parsed.success).toBe(true);
    expect(parsed.data?.images[0].products).toHaveLength(12);
    expect(parsed.data?.images[0].products?.[0].label).toBe("lipstick 0");
    // The raw answer the runner logs is untouched.
    expect(raw.images[0].products).toHaveLength(14);
  });

  it("cuts long labels and seller intent lists, and clamps boxes into the image", () => {
    const long = "x".repeat(300);
    const raw = intakeWith(
      [{ label: long, box: { x: -0.02, y: 0.1, width: 1.2, height: 0.5 }, matchesIntent: "yes" }],
      {
        featureOnly: long,
        exclude: Array.from({ length: 10 }, (_, i) => `thing ${i} ${long}`),
        mustKeep: [],
        styleNotes: "y".repeat(500),
      },
    );
    const parsed = IntakeAnswer.safeParse(raw);
    expect(parsed.success).toBe(true);
    const image = parsed.data?.images[0];
    expect(image?.products?.[0].label).toHaveLength(120);
    expect(image?.products?.[0].box).toEqual({ x: 0, y: 0.1, width: 1, height: 0.5 });
    expect(parsed.data?.sellerIntent?.featureOnly).toHaveLength(120);
    expect(parsed.data?.sellerIntent?.exclude).toHaveLength(8);
    expect(parsed.data?.sellerIntent?.exclude.every((e) => e.length <= 120)).toBe(true);
    expect(parsed.data?.sellerIntent?.styleNotes).toHaveLength(400);
  });

  it("drops a product box with no area rather than the whole answer", () => {
    const raw = intakeWith([product(1), { ...product(2), box: { x: 0.1, y: 0.1, width: 0, height: 0.2 } }]);
    const parsed = IntakeAnswer.safeParse(raw);
    expect(parsed.success).toBe(true);
    expect(parsed.data?.images[0].products).toHaveLength(1);
  });

  it("still refuses an answer with the wrong shape", () => {
    expect(IntakeAnswer.safeParse({ images: [] }).success).toBe(false);
    expect(IntakeAnswer.safeParse({ images: [{ sellableProduct: "yes" }] }).success).toBe(false);
    expect(IntakeAnswer.safeParse(null).success).toBe(false);
  });
});

describe("ProductProfileAnswer (bounds strict tool use cannot send)", () => {
  it("keeps a feature rich product by cutting lists to their maximum", () => {
    const many = (n: number, word: string) => Array.from({ length: n }, (_, i) => `${word} ${i}`);
    const raw = profile({
      name: "n".repeat(200),
      materials: many(10, "material"),
      features: many(9, "feature"),
      benefits: many(12, "benefit"),
      useContexts: many(7, "context"),
    });
    expect(ProductProfile.safeParse(raw).success).toBe(false);
    const parsed = ProductProfileAnswer.safeParse(raw);
    expect(parsed.success).toBe(true);
    expect(parsed.data?.name).toHaveLength(120);
    expect(parsed.data?.materials).toHaveLength(8);
    expect(parsed.data?.features).toEqual(many(8, "feature"));
    expect(parsed.data?.benefits).toHaveLength(8);
    expect(parsed.data?.useContexts).toHaveLength(6);
  });

  it("repairs short or bare hex colors and drops unreadable ones", () => {
    const raw = profile({
      dominantColors: [
        { name: "red", hex: "f00", coveragePct: 40 },
        { name: "blue", hex: "#0000ff", coveragePct: 30 },
        { name: "mystery", hex: "reddish", coveragePct: 10 },
        ...Array.from({ length: 6 }, (_, i) => ({ name: `gray ${i}`, hex: "#808080", coveragePct: 1 })),
      ],
    });
    const parsed = ProductProfileAnswer.safeParse(raw);
    expect(parsed.success).toBe(true);
    expect(parsed.data?.dominantColors.map((c) => c.hex)).toEqual([
      "#FF0000",
      "#0000FF",
      "#808080",
      "#808080",
      "#808080",
      "#808080",
    ]);
  });

  it("raises a product count below one to one", () => {
    const parsed = ProductProfileAnswer.safeParse(profile({ productCount: 0 }));
    expect(parsed.data?.productCount).toBe(1);
  });

  it("still refuses an answer outside the enums", () => {
    expect(ProductProfileAnswer.safeParse(profile({ category: "spaceships" })).success).toBe(false);
  });
});

describe("normalizeHex", () => {
  it("normalizes to #RRGGBB or null", () => {
    expect(normalizeHex(" #aBc ")).toBe("#AABBCC");
    expect(normalizeHex("12ab3F")).toBe("#12AB3F");
    expect(normalizeHex("#12345")).toBeNull();
    expect(normalizeHex(12)).toBeNull();
  });
});
