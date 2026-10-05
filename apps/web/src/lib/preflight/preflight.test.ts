import { describe, expect, it } from "vitest";
import type { UploadPreflightRun } from "@curvi/trigger/preflight";
import { photoBlockReason, photoTargetBox, type PhotoItem } from "@/components/app/new-pack-form";
import {
  addedTextPhotoLine,
  addedTextSpecIds,
  CHOOSE_PRODUCT_BLOCK,
  CHOOSER_OVERLAP_HINT,
  CUTOUT_UNAVAILABLE_NOTICE,
  joinNames,
  keptPhotoHeadsUp,
  OTHER_ITEMS_KEPT_COPY,
  PREFLIGHT_UNAVAILABLE_NOTICE,
  preflightBlockReason,
  readyLine,
  sizeShortfallLine,
  sizeShortfalls,
} from "./copy";
import { demoPreflight } from "./demo";
import { sizeNeeds, storedPreflightOf } from "./result";
import { preflightProductBoxOf, preflightQuestionsOf } from "./service";
import type { PreflightView } from "./types";

// docs/phases/PHASE_14.md workstream 4 and item 3.2: what the form says
// about a checked photo, and when it lets a pack start.

const flags = { nudity: false, weapons: false, drugs: false, prohibited: false, realPersonMainSubject: false };
const watchBox = { x: 0.1, y: 0.2, width: 0.3, height: 0.25 };
const shoeBox = { x: 0.5, y: 0.5, width: 0.4, height: 0.3 };

function run(overrides: Partial<UploadPreflightRun> = {}, image: Record<string, unknown> = {}): UploadPreflightRun {
  return {
    missing: false,
    photo: { width: 3000, height: 4000 },
    intake: {
      image: { sellableProduct: true, distinctProducts: 1, sharpEnough: true, screenshot: false, flags, ...image },
      noteKey: "n",
      recipe: { key: "intake_normalizer", version: 3 },
      at: new Date().toISOString(),
    },
    moderation: [],
    cutout: "done",
    items: [],
    rule: null,
    thumbnails: [],
    questions: [],
    costMicros: 1000,
    ...overrides,
  } as UploadPreflightRun;
}

const twoItems: UploadPreflightRun["items"] = [
  { number: 1, label: "silver watch", box: watchBox, areaShare: 0.1, colorName: "gray", featured: false },
  { number: 2, label: "white sneakers", box: shoeBox, areaShare: 0.12, colorName: "white", featured: false },
];

function view(stored: ReturnType<typeof storedPreflightOf>): PreflightView {
  return { ...stored, key: "k", items: stored.items.map(({ thumbKey, ...item }) => ({ ...item, thumbUrl: thumbKey })) };
}

describe("storedPreflightOf", () => {
  it("reads a single product as ready, with its size", () => {
    const stored = storedPreflightOf(
      run({}, { products: [{ label: "silver watch", box: watchBox, matchesIntent: "yes" }] }),
    );
    expect(stored).toMatchObject({ status: "ready", found: "silver watch", problem: null, productLongSide: 1000 });
    expect(stored.sizes.find((s) => s.specId === "amazon.main")).toMatchObject({ measure: "product" });
  });

  it("stores the question step's questions with the verdict, never on a blocked photo (PHASE_16)", () => {
    const questions: UploadPreflightRun["questions"] = [
      { id: "mood", kind: "mood", options: [{ value: "gym", label: "Gym" }, { value: "studio", label: "Studio" }] },
    ];
    expect(storedPreflightOf(run({ items: twoItems, questions })).questions).toEqual(questions);
    expect(storedPreflightOf(run({})).questions).toBeUndefined();
    expect(storedPreflightOf(run({ moderation: ["weapons"], questions })).questions).toBeUndefined();
    const row = (status: string, result: unknown) =>
      ({ status, result }) as unknown as Parameters<typeof preflightQuestionsOf>[0];
    expect(preflightQuestionsOf(row("choose", { questions: [...questions, { id: "x", kind: "nope", options: [] }] }))).toEqual(
      questions,
    );
    expect(preflightQuestionsOf(row("blocked", { questions }))).toEqual([]);
    expect(preflightQuestionsOf(undefined)).toEqual([]);
  });

  it("keeps the inventory's product box for the crop fit (PHASE_15 P1)", () => {
    const box = { x: 0.1, y: 0.2, width: 0.3, height: 0.4 };
    expect(storedPreflightOf(run({ productBox: box })).productBox).toEqual(box);
    expect(storedPreflightOf(run({})).productBox).toBeUndefined();
    const row = { result: { productBox: box } } as unknown as Parameters<typeof preflightProductBoxOf>[0];
    expect(preflightProductBoxOf(row)).toEqual(box);
    const outside = { result: { productBox: { x: 0.9, y: 0, width: 0.5, height: 0.5 } } } as unknown as Parameters<
      typeof preflightProductBoxOf
    >[0];
    expect(preflightProductBoxOf(outside)).toBeUndefined();
    expect(preflightProductBoxOf(undefined)).toBeUndefined();
  });

  it("blocks prohibited goods and photos with no product, each with its own fix, and never screenshots", () => {
    const prohibited = storedPreflightOf(run({ moderation: ["weapons"] }));
    expect(prohibited.status).toBe("blocked");
    expect(prohibited.problem?.title).toContain("weapons");
    const screenshot = storedPreflightOf(run({}, { screenshot: true }));
    expect(screenshot.status).not.toBe("blocked");
    const none = storedPreflightOf(run({}, { sellableProduct: false }));
    expect(none.problem?.code).toBe("no_product");
    expect(none.problem?.tips?.length).toBeGreaterThanOrEqual(2);
  });

  it("asks which product when the photo holds several, preselecting the note's pick", () => {
    const ask = storedPreflightOf(run({ items: twoItems, rule: "ambiguous" }), ["k1", "k2"]);
    expect(ask.status).toBe("choose");
    expect(ask.preselect).toBeNull();
    expect(ask.items.map((i) => i.thumbKey)).toEqual(["k1", "k2"]);
    expect(ask.items[0].longSide).toBe(1000);
    const picked = storedPreflightOf(
      run({ items: twoItems.map((i) => ({ ...i, featured: i.number === 2 })), rule: "note" }),
    );
    expect(picked).toMatchObject({ status: "choose", preselect: 2, found: "white sneakers", productLongSide: 1200 });
  });

  it("never offers a tap that would split a product in two parts", () => {
    const parts = storedPreflightOf(run({ items: twoItems.map((i) => ({ ...i, featured: true })), rule: "single_product" }));
    expect(parts.status).toBe("ready");
    expect(parts.items).toEqual([]);
  });

  it("says when the cutout or the whole check could not run, without blocking", () => {
    expect(storedPreflightOf(run({ cutout: "unavailable" })).notice).toBe(CUTOUT_UNAVAILABLE_NOTICE);
    const down = storedPreflightOf(run({ intake: null }));
    expect(down).toMatchObject({ status: "unavailable", notice: PREFLIGHT_UNAVAILABLE_NOTICE });
    expect(storedPreflightOf(run({ missing: true })).status).toBe("unavailable");
  });

  it("claims nothing was found when the check could not run", () => {
    const down = view(storedPreflightOf(run({ intake: null })));
    expect(readyLine(down, ["amazon.main", "shopify.product"])).toBeNull();
    expect(readyLine(view(storedPreflightOf(run({ missing: true }))), ["amazon.main"])).toBeNull();
  });

  it("marks a photo whose cutout was made, so a paused pack may still use it", () => {
    expect(storedPreflightOf(run({})).cutoutCached).toBe(true);
    expect(storedPreflightOf(run({ cutout: "unavailable" })).cutoutCached).toBeUndefined();
    expect(storedPreflightOf(run({ intake: null })).cutoutCached).toBeUndefined();
  });
});

describe("the form's copy", () => {
  const ready = view(
    storedPreflightOf(run({}, { products: [{ label: "silver watch", box: watchBox, matchesIntent: "yes" }] })),
  );

  it("names what was found and the channels it is ready for", () => {
    expect(readyLine(ready, ["amazon.main", "shopify.product", "meta.feed_1x1"])).toBe(
      "Found: silver watch. Ready for Amazon, Shopify and Meta.",
    );
    expect(joinNames(["Amazon"])).toBe("Amazon");
    expect(preflightBlockReason(ready, ["amazon.main"], null)).toBeNull();
  });

  it("gives the size numbers for a photo too small for a channel", () => {
    const small: PreflightView = { ...ready, photo: { width: 413, height: 486 }, productLongSide: 400 };
    const short = sizeShortfalls(small, ["amazon.main", "meta.feed_1x1"]);
    expect(short.map((s) => s.specId)).toContain("amazon.main");
    const line = sizeShortfallLine(short[0], small.photo!);
    expect(line).toContain("413 by 486 pixels");
    expect(line).toContain("about 400 pixels");
    expect(line).toMatch(/Amazon main needs about \d+/);
    expect(line).toContain("We will enlarge it");
    // A small photo warns but never blocks: the product is enlarged.
    expect(preflightBlockReason(small, ["amazon.main"], null)).toBeNull();
    expect(readyLine(small, ["amazon.main"])).toContain("Ready for Amazon");
  });

  it("copy is plain: no arrows, no dashes as punctuation", () => {
    const lines = [
      readyLine(ready, ["amazon.main"]),
      ...["prohibited", "screenshot", "no_product"].map((code) => {
        const stored = storedPreflightOf(
          code === "prohibited" ? run({ moderation: ["drugs"] }) : run({}, code === "screenshot" ? { screenshot: true } : { sellableProduct: false }),
        );
        return `${stored.problem?.title} ${stored.problem?.fix} ${(stored.problem?.tips ?? []).join(" ")}`;
      }),
      CUTOUT_UNAVAILABLE_NOTICE,
      PREFLIGHT_UNAVAILABLE_NOTICE,
      CHOOSER_OVERLAP_HINT,
      CHOOSE_PRODUCT_BLOCK,
    ];
    for (const line of lines) {
      expect(line).not.toMatch(/->|→|—|–| - /);
    }
  });
});

describe("the form's gate", () => {
  const choose = view(storedPreflightOf(run({ items: twoItems, rule: "ambiguous" })));
  const photo = (overrides: Partial<PhotoItem> = {}): PhotoItem => ({
    id: 1,
    name: "cafe.jpg",
    phase: "uploaded",
    kind: "image",
    angle: "front",
    key: "k",
    preflightPhase: "done",
    preflight: choose,
    ...overrides,
  });

  it("holds the pack until the seller taps a product, then sends that box", () => {
    expect(photoBlockReason(photo(), ["amazon.main"])).toBe("Tap the product this pack is for. It can touch or overlap the others.");
    expect(photoTargetBox(photo())).toBeUndefined();
    expect(photoBlockReason(photo({ chosen: 2 }), ["amazon.main"])).toBeNull();
    expect(photoTargetBox(photo({ chosen: 2 }))).toEqual(shoeBox);
  });

  it("takes the note's preselected pick without a tap", () => {
    const preselected = { ...choose, preselect: 1 };
    expect(photoBlockReason(photo({ preflight: preselected }), ["amazon.main"])).toBeNull();
    expect(photoTargetBox(photo({ preflight: preselected }))).toEqual(watchBox);
  });

  it("never asks about an in the box photo", () => {
    expect(photoBlockReason(photo({ angle: "in_the_box" }), ["amazon.main"])).toBeNull();
    expect(photoTargetBox(photo({ angle: "in_the_box", chosen: 1 }))).toBeUndefined();
  });

  it("blocks Create pack for a blocking problem, and never for a check that could not run", () => {
    const blocked = view(storedPreflightOf(run({ moderation: ["weapons"] })));
    expect(photoBlockReason(photo({ preflight: blocked }), ["amazon.main"])).toContain("weapons");
    expect(photoBlockReason(photo({ preflightPhase: "failed", preflight: null }), ["amazon.main"])).toBeNull();
    expect(photoBlockReason(photo({ phase: "uploading" }), ["amazon.main"])).toBeNull();
  });
});

describe("the output context (PHASE_15 item 31)", () => {
  const several = view(storedPreflightOf(run({ items: twoItems, rule: "ambiguous" }), ["k1", "k2"]));
  const small: PreflightView = {
    ...view(storedPreflightOf(run({}, { products: [{ label: "silver watch", box: watchBox, matchesIntent: "yes" }] }))),
    photo: { width: 413, height: 486 },
    productLongSide: 400,
  };
  const keptNoCutout = { kept: true, feedsCutout: false };
  const keptWithCutout = { kept: true, feedsCutout: true };
  const removed = { kept: false, feedsCutout: true };

  it("does not ask for a tap on a kept photo that feeds no cutout, and says its items stay", () => {
    expect(preflightBlockReason(several, ["amazon.secondary"], null, { output: keptNoCutout })).toBeNull();
    expect(keptPhotoHeadsUp(several, ["amazon.secondary"], null, keptNoCutout)).toContain(OTHER_ITEMS_KEPT_COPY);
  });

  it("still asks for a tap when the kept photo feeds a cutout, like a white main image", () => {
    expect(preflightBlockReason(several, ["amazon.main"], null, { output: keptWithCutout })).toBe(
      "Tap the product this pack is for. It can touch or overlap the others.",
    );
    expect(keptPhotoHeadsUp(several, ["amazon.main"], 1, keptWithCutout)).not.toContain(OTHER_ITEMS_KEPT_COPY);
  });

  it("never blocks a kept photo on size, and gives a heads up instead", () => {
    const selected = ["amazon.main", "meta.feed_1x1"];
    expect(preflightBlockReason(small, selected, null, { output: keptWithCutout })).toBeNull();
    const headsUp = keptPhotoHeadsUp(small, selected, null, keptWithCutout);
    expect(headsUp.some((line) => line.includes("may be too small for Amazon main"))).toBe(true);
    // A photo that feeds no cutout is never measured by its product.
    const photoOnly = sizeShortfalls(small, selected, null, keptNoCutout);
    expect(photoOnly.every((s) => s.measure === "photo")).toBe(true);
  });

  it("keeps today's rules for a removed photo, where size warns but never blocks", () => {
    expect(preflightBlockReason(several, ["amazon.main"], null, { output: removed })).toBe(
      "Tap the product this pack is for. It can touch or overlap the others.",
    );
    expect(preflightBlockReason(small, ["amazon.main"], null, { output: removed })).toBeNull();
    expect(keptPhotoHeadsUp(small, ["amazon.main"], null, removed)).toEqual([]);
    expect(keptPhotoHeadsUp(small, ["amazon.main"], null, undefined)).toEqual([]);
  });

  describe("added text on the photo (PHASE_15 P1)", () => {
    const single = { products: [{ label: "silver watch", box: watchBox, matchesIntent: "yes" }] };
    const flagged = view(storedPreflightOf(run({}, { ...single, addedOverlays: true })));
    const clean = view(storedPreflightOf(run({}, { ...single, addedOverlays: false })));

    it("stores the flag only when intake set it", () => {
      expect(flagged.addedOverlays).toBe(true);
      expect(clean).not.toHaveProperty("addedOverlays");
      expect(view(storedPreflightOf(run({}, single)))).not.toHaveProperty("addedOverlays");
    });

    it("names the picked channels that refuse added text, and only those that take a kept photo", () => {
      expect(
        addedTextSpecIds(["amazon.main", "amazon.secondary", "ebay.listing", "google.merchant.main", "google.merchant.lifestyle"]),
      ).toEqual(["ebay.listing", "google.merchant.lifestyle"]);
      expect(addedTextPhotoLine([])).toBeNull();
      expect(addedTextPhotoLine(["ebay.listing"])).toBe(
        "This photo looks like it has added text, a border or a watermark, which eBay does not allow, so it will be left out there. Upload a clean photo to include it, or leave this channel out. Your product's own logo and labels are fine.",
      );
    });

    it("says so under a kept flagged photo on eBay or Google, and nowhere else", () => {
      const line = addedTextPhotoLine(["ebay.listing", "google.merchant.lifestyle"])!;
      expect(line).toContain("which eBay and Google do not allow");
      expect(line).toContain("leave these channels out");
      const picked = ["amazon.secondary", "ebay.listing", "google.merchant.lifestyle"];
      expect(keptPhotoHeadsUp(flagged, picked, null, keptNoCutout)).toContain(line);
      expect(keptPhotoHeadsUp(clean, picked, null, keptNoCutout)).not.toContain(line);
      expect(keptPhotoHeadsUp(flagged, ["amazon.secondary"], null, keptNoCutout)).toEqual([]);
      expect(keptPhotoHeadsUp(flagged, picked, null, removed)).toEqual([]);
      expect(line).not.toMatch(/[–—→←]| - |->|=>|[\u{1F300}-\u{1FAFF}]/u);
    });
  });

  it("keeps the new lines plain (rule 9)", () => {
    const lines = [
      ...keptPhotoHeadsUp(several, ["amazon.secondary"], null, keptNoCutout),
      ...keptPhotoHeadsUp(small, ["amazon.main", "meta.feed_1x1"], null, keptWithCutout),
    ];
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      expect(line).not.toMatch(/[–—→←]| - |->|=>|[\u{1F300}-\u{1FAFF}]/u);
    }
  });
});

describe("demo mode", () => {
  it("answers a simulated ready result", () => {
    const ready = demoPreflight("ws/demo/src/photo");
    expect(ready).toMatchObject({ status: "ready", demo: true, found: "your product" });
    expect(ready.sizes).toEqual(sizeNeeds());
    expect(readyLine(ready, ["amazon.main"])).toBe("Found: your product. Ready for Amazon.");
    // The cutout preview (P1) shows in demo mode too, for one product only.
    expect(ready.previewUrl).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(demoPreflight("ws/demo/src/e2e-several").previewUrl).toBeNull();
    expect(demoPreflight("ws/demo/src/e2e-noproduct").previewUrl).toBeNull();
  });

  it("simulates the chooser and a photo with no product for the demo's own photos", () => {
    const several = demoPreflight("ws/demo/src/e2e-several");
    expect(several.status).toBe("choose");
    expect(several.items).toHaveLength(2);
    expect(several.items.every((item) => item.thumbUrl?.startsWith("data:image/svg+xml"))).toBe(true);
    expect(demoPreflight("ws/demo/src/e2e-several", "just the watch").preselect).toBe(1);
    const none = demoPreflight("ws/demo/src/e2e-noproduct");
    expect(none.status).toBe("blocked");
    expect(none.problem?.code).toBe("no_product");
    // Screenshots are accepted (founder decision 2026-09-29), in demo mode too.
    expect(demoPreflight("ws/demo/src/e2e-screenshot").status).toBe("ready");
  });
});
