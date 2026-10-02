/**
 * Workstream 6 of docs/phases/PHASE_16.md, the pure parts: the "Make this
 * pack again" prefill, the gallery's filters and items, picking versions,
 * the variations control on the form and its estimate line.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_OUTPUT_OPTIONS,
  normalizeOutputOptions,
  outputOptionsKey,
  resolveOutputOptions,
} from "@curvi/pipeline/output-options";
import type { SellerQuestion } from "@curvi/pipeline/questions";
import { creditCosts, stillStyle, variationOptions } from "@curvi/pipeline/seed";
import {
  NO_FILTERS,
  filterGallery,
  galleryFacets,
  galleryItemsFromJob,
  galleryItemsOf,
  galleryQuery,
  itemAspect,
  parseGalleryFilters,
  shotTypeLabel,
  type GalleryItem,
} from "@/lib/library";
import {
  initialOutputForm,
  outputFormReducer,
  outputOptionsBody,
  rememberedFormState,
  variationSelectOptions,
  variationsFromValue,
  variationsHelper,
  VARIATIONS_LABEL,
} from "@/lib/output-options-form";
import { estimatePackCredits } from "@/lib/pack-estimate";
import { prefilledPicks, reuseAnswers, reuseHref, reuseNotice, reuseOutputOptions, reusePrefillOf, REUSE_LABEL } from "@/lib/reuse";
import { outputEstimateInputs } from "@/lib/services/output-options";
import type { JobView } from "@/lib/services/types";
import { FAVORITE_COPY, overLimitSpec, shotVersionsOf, VERSION_COPY } from "@/lib/variation-picks";

/** CLAUDE.md rule 9: no emoji, arrows, en or em dashes, or " - ". */
function followsRule9(text: string): boolean {
  return !/[–—←-⇿\u{1F300}-\u{1FAFF}]/u.test(text) && !text.includes(" - ");
}

const resolved = (input: Parameters<typeof normalizeOutputOptions>[0]) =>
  resolveOutputOptions(normalizeOutputOptions(input), {
    colorHex: stillStyle.whiteHex,
    brandSweepHex: stillStyle.whiteHex,
    keepMediaIds: [],
  });

describe("Make this pack again", () => {
  const job = {
    id: "5a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d",
    productId: "3f2e1d0c-9b8a-4765-8432-10fedcba9876",
    mode: "listing" as const,
    channels: ["amazon.main", "pinterest.pin"],
    outputOptions: resolved({ bundle: "main", variations: 2, scenePreset: "outdoor", color: { kind: "brand", index: 1 } }),
    sellerAnswers: { version: 1, mood: { value: "bright", label: "Bright" }, use: { value: "gift", label: "Gift" } },
    sellerNote: "The red one",
    createdAt: new Date("2026-09-20T10:00:00Z"),
  };

  it("restores every field of the pack", () => {
    const prefill = reusePrefillOf(job);
    expect(prefill).toMatchObject({
      jobId: job.id,
      productId: job.productId,
      mode: "listing",
      channels: job.channels,
      answers: { mood: "bright", use: "gift" },
      note: "The red one",
      createdAt: "2026-09-20T10:00:00.000Z",
    });
    // The choices, not the snapshot: they normalize back to the same pack.
    expect(outputOptionsKey(prefill.outputOptions as never)).toBe(outputOptionsKey(job.outputOptions));
    expect(prefill.outputOptions).not.toHaveProperty("look");
  });

  it("fills the form's options with the bundle and the versions", () => {
    const state = rememberedFormState(reuseOutputOptions(job.outputOptions), { brandColorCount: 3 });
    expect(state?.choices.bundle).toBe("main");
    expect(state?.choices.variations).toBe(2);
    expect(state?.more.scenePreset).toBe("outdoor");
    expect(state?.choices.color).toEqual({ kind: "brand", index: 1 });
  });

  it("reads nothing from a missing or broken record", () => {
    expect(reuseOutputOptions(null)).toBeNull();
    expect(reuseOutputOptions({ v: 2 })).toBeNull();
    expect(reuseAnswers({ version: 9 })).toEqual({});
    expect(reusePrefillOf({ ...job, channels: null, mode: null, sellerNote: null }).channels).toEqual([]);
  });

  it("taps the earlier answers where the new questions offer them, never over the seller's own", () => {
    const questions: SellerQuestion[] = [
      { id: "q1", kind: "mood", options: [{ value: "bright", label: "Bright" }, { value: "calm", label: "Calm" }] },
      { id: "q2", kind: "use", options: [{ value: "daily", label: "Daily" }] },
      { id: "q3", kind: "target", options: [{ value: "item:0", label: "Mug" }] },
    ] as SellerQuestion[];
    const answers = { mood: "bright", use: "gift", target: "item:0" };
    expect(prefilledPicks(questions, answers, {})).toEqual({ q1: "bright" });
    expect(prefilledPicks(questions, answers, { q1: "calm" })).toEqual({ q1: "calm" });
  });

  it("links and speaks plainly", () => {
    expect(reuseHref(job.id)).toBe(`/app/new?from=${job.id}`);
    for (const text of [REUSE_LABEL, reuseNotice("2026-09-20T10:00:00Z"), reuseNotice("nonsense")]) {
      expect(followsRule9(text)).toBe(true);
    }
    expect(reuseNotice("2026-09-20T10:00:00Z")).toContain("September 20, 2026");
  });
});

function item(overrides: Partial<GalleryItem>): GalleryItem {
  return {
    assetId: "a1",
    jobId: "j1",
    shotId: "s01_amazon_main",
    shotType: "amazon_main",
    productTitle: "Kettle",
    channels: ["amazon.main"],
    width: 2000,
    height: 2000,
    imageUrl: "https://example.test/a.jpg",
    downloadUrl: null,
    favorite: false,
    createdAt: "2026-09-20T10:00:00.000Z",
    ...overrides,
  };
}

describe("the gallery", () => {
  const items = [
    item({}),
    item({ assetId: "a2", shotType: "lifestyle", channels: ["amazon.secondary", "shopify.product"], width: 1080, height: 1350, favorite: true }),
    item({ assetId: "a3", shotType: "social_9x16", channels: ["meta.story_9x16"], width: 1080, height: 1920 }),
  ];

  it("filters by channel family, shot type and favorites", () => {
    expect(filterGallery(items, NO_FILTERS)).toHaveLength(3);
    expect(filterGallery(items, { ...NO_FILTERS, channel: "shopify" }).map((i) => i.assetId)).toEqual(["a2"]);
    expect(filterGallery(items, { ...NO_FILTERS, shotType: "social_9x16" }).map((i) => i.assetId)).toEqual(["a3"]);
    expect(filterGallery(items, { ...NO_FILTERS, favorites: true }).map((i) => i.assetId)).toEqual(["a2"]);
    expect(filterGallery(items, { channel: "amazon", shotType: "lifestyle", favorites: true }).map((i) => i.assetId)).toEqual(["a2"]);
  });

  it("offers the filters the images hold, with plain labels", () => {
    const facets = galleryFacets(items);
    expect(facets.channels).toEqual([
      { value: "amazon", label: "Amazon" },
      { value: "meta", label: "Meta" },
      { value: "shopify", label: "Shopify" },
    ]);
    expect(facets.shotTypes.map((t) => t.label)).toEqual(["Lifestyle scene", "Main image", "Story"]);
    for (const label of [...facets.shotTypes.map((t) => t.label), shotTypeLabel("aplus_how_to"), shotTypeLabel("new_kind")]) {
      expect(followsRule9(label)).toBe(true);
    }
  });

  it("shows each image at its true aspect ratio", () => {
    expect(itemAspect(items[2])).toBe("1080 / 1920");
    expect(itemAspect(item({ width: null, height: null }))).toBe("1 / 1");
  });

  it("reads filters from the query string and drops anything out of shape", () => {
    expect(parseGalleryFilters({ channel: "amazon", type: "lifestyle", favorites: "1" })).toEqual({
      channel: "amazon",
      shotType: "lifestyle",
      favorites: true,
    });
    expect(parseGalleryFilters({ channel: "../etc", type: "not_a_type", favorites: "yes" })).toEqual(NO_FILTERS);
    expect(galleryQuery({ channel: "meta", shotType: null, favorites: true })).toBe("?channel=meta&favorites=1");
    expect(galleryQuery(NO_FILTERS)).toBe("");
  });

  it("builds one item per delivered asset from its picked files only, newest first", () => {
    const at = (n: number) => new Date(Date.UTC(2026, 8, 20, 10, n));
    const built = galleryItemsOf({
      assets: [
        { id: "a1", jobId: "j1", shotType: "lifestyle", qc: { shotId: "s05_lifestyle" }, approved: true, createdAt: at(1) },
        { id: "a2", jobId: "j1", shotType: "lifestyle", qc: { shotId: "s05_lifestyle.v2" }, approved: true, createdAt: at(2) },
        { id: "a3", jobId: "j1", shotType: "amazon_main", qc: { shotId: "s01" }, approved: false, createdAt: at(3) },
        { id: "a4", jobId: "j1", shotType: "cutout_png", qc: { shotId: "s04" }, approved: true, createdAt: at(4) },
      ],
      variants: [
        { id: "v1", assetId: "a1", channelSpecId: "amazon.secondary", r2Key: "k1", width: 2000, height: 2000, picked: true, createdAt: at(1) },
        { id: "v2", assetId: "a1", channelSpecId: "shopify.product", r2Key: "k2", width: 2048, height: 2048, picked: true, createdAt: at(1) },
        { id: "v3", assetId: "a2", channelSpecId: "amazon.secondary", r2Key: "k3", width: 2000, height: 2000, picked: false, createdAt: at(2) },
        { id: "v4", assetId: "a3", channelSpecId: "amazon.main", r2Key: "k4", width: 2000, height: 2000, picked: true, createdAt: at(3) },
        { id: "v5", assetId: "a4", channelSpecId: "shopify.product", r2Key: "k5", width: 900, height: 1200, picked: true, createdAt: at(4) },
      ],
      productTitleOfJob: new Map([["j1", "Kettle"]]),
      favoriteAssetIds: new Set(["a1"]),
    });
    expect(built.map((i) => i.assetId)).toEqual(["a4", "a1"]);
    expect(built[1]).toMatchObject({ channels: ["amazon.secondary", "shopify.product"], r2Key: "k1", variantId: "v1", favorite: true });
  });

  it("leaves unpicked versions out of the job page's gallery", () => {
    const job = {
      id: "j1",
      productTitle: "Kettle",
      createdAt: "2026-09-20T10:00:00.000Z",
      shots: [
        { shotId: "s05", shotType: "lifestyle", status: "done", imageUrl: "u1", assetId: "a1", channels: ["amazon.secondary"], version: { number: 1, sceneShotId: "s05", picked: true } },
        { shotId: "s05.v2", shotType: "lifestyle", status: "done", imageUrl: "u2", assetId: "a2", channels: ["amazon.secondary"], version: { number: 2, sceneShotId: "s05", picked: false } },
        { shotId: "s06", shotType: "infographic", status: "needs_review", imageUrl: "u3", assetId: "a3", channels: [] },
      ],
    } as unknown as Pick<JobView, "id" | "productTitle" | "createdAt" | "shots">;
    expect(galleryItemsFromJob(job).map((i) => i.assetId)).toEqual(["a1"]);
  });
});

describe("picking versions", () => {
  it("groups the versions of each scene", () => {
    const picked = new Map([["s05.v3", true]]);
    const versions = shotVersionsOf(["s01", "s05", "s05.v2", "s05.v3", "s06"], (id) => picked.get(id));
    expect(versions.get("s05")).toEqual({ number: 1, sceneShotId: "s05", picked: true });
    expect(versions.get("s05.v2")).toEqual({ number: 2, sceneShotId: "s05", picked: false });
    expect(versions.get("s05.v3")).toEqual({ number: 3, sceneShotId: "s05", picked: true });
    expect(versions.has("s01")).toBe(false);
    expect(versions.has("s06")).toBe(false);
  });

  it("refuses a pick that would pass a channel's file limit", () => {
    expect(overLimitSpec(["amazon.secondary", "shopify.product"], new Map([["amazon.secondary", 7]]))).toBeNull();
    expect(overLimitSpec(["amazon.secondary", "shopify.product"], new Map([["amazon.secondary", 8]]))).toBe("amazon.secondary");
    expect(overLimitSpec(["amazon.main"], new Map([["amazon.main", 1]]))).toBe("amazon.main");
  });

  it("speaks plainly", () => {
    const texts: string[] = [
      ...(Object.values(VERSION_COPY) as unknown[]).filter((v): v is string => typeof v === "string"),
      VERSION_COPY.label(2),
      VERSION_COPY.saved(true),
      VERSION_COPY.saved(false),
      VERSION_COPY.channelFull("amazon.secondary"),
      ...Object.values(FAVORITE_COPY),
      VARIATIONS_LABEL,
      variationsHelper(),
    ];
    for (const text of texts) {
      expect(followsRule9(text), text).toBe(true);
    }
  });
});

describe("Versions of each scene on the form", () => {
  it("offers the seed range and prices extras from the seed", () => {
    expect(variationSelectOptions().map((o) => o.value)).toEqual(
      Array.from({ length: variationOptions.max - variationOptions.min + 1 }, (_, i) => String(variationOptions.min + i)),
    );
    expect(variationsFromValue("3")).toBe(3);
    expect(variationsFromValue("9")).toBeNull();
    expect(variationsHelper()).toContain(String(creditCosts.generativeStill));
  });

  it("sends the count only past the default and with scenes on", () => {
    const start = initialOutputForm();
    expect(outputOptionsBody(start.lookBase, start.choices, start.more)).not.toHaveProperty("variations");
    const three = outputFormReducer(start, { type: "variations", count: 3 });
    expect(outputOptionsBody(three.lookBase, three.choices, three.more).variations).toBe(3);
    const off = outputFormReducer(three, { type: "scenes", count: "off" });
    expect(outputOptionsBody(off.lookBase, off.choices, off.more)).not.toHaveProperty("variations");
    const back = outputFormReducer(three, { type: "variations", count: 1 });
    expect(back.choices).not.toHaveProperty("variations");
  });

  it("keeps the count across a look card, like the bundle", () => {
    const three = outputFormReducer(initialOutputForm(), { type: "variations", count: 3 });
    const keep = outputFormReducer(three, { type: "look", look: "keep_photo" });
    expect(keep.choices.variations).toBe(3);
  });

  it("adds a line for the extra versions to the estimate, at the seed price", () => {
    const channels = ["amazon.main", "amazon.secondary", "shopify.product", "meta.feed_1x1"];
    const base = estimatePackCredits(channels, "listing", "growth", {
      ...outputEstimateInputs(resolved({}), []),
    });
    const three = estimatePackCredits(channels, "listing", "growth", {
      ...outputEstimateInputs(resolved({ variations: 3 }), []),
    });
    const scenes = base.lines.find((l) => l.label.startsWith("Lifestyle scene"));
    const extra = three.lines.find((l) => l.label.startsWith("Extra version"));
    expect(scenes).toBeDefined();
    expect(extra).toBeDefined();
    expect(three.lines.find((l) => l.label.startsWith("Lifestyle scene"))).toEqual(scenes);
    const sceneCount = Number(/(\d+)$/.exec(scenes!.label)?.[1] ?? 1);
    expect(extra!.credits).toBe(sceneCount * 2 * creditCosts.generativeStill);
    expect(three.total - base.total).toBe(Math.ceil(extra!.credits));
    expect(followsRule9(extra!.label)).toBe(true);
    // Today's pack reads exactly as before.
    expect(estimatePackCredits(channels, "listing", "growth", outputEstimateInputs(resolved({ variations: 1 }), []))).toEqual(base);
    expect(outputOptionsKey(DEFAULT_OUTPUT_OPTIONS)).toBe(outputOptionsKey({ variations: 1 }));
  });
});
