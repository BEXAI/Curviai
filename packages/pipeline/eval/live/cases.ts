/**
 * The live LLM golden set (docs/phases/PHASE_17.md workstream 4): a few
 * inputs per recipe stage, each sent with the payload the runner, preflight
 * or brand palette step builds for it. Ids are stable: the stored Claude
 * baseline and every recording are keyed by them, so renaming one means
 * recording the baseline again.
 */

import type { LlmContentBlock } from "@curvi/ai";
import type { ProductProfile, Shot } from "../../src/schemas";
import { analyzeInventory, pickerNumbering } from "../../src/inventory";
import { renderContactSheet } from "../../src/contact-sheet";
import { packCopyRequest } from "../../src/ad-copy";
import { aplusCopyRequest } from "../../src/aplus-copy";
import { isAplusModuleType } from "../../src/schemas";
import { logoVisionJpeg, paletteNamingPayload, readLogoPalette } from "../../src/brand/palette";
import { questionPlannerChoices } from "../../src/questions";
import { questionSet } from "../../src/seed/questions";
import { adCopyRecipe, type RecipeRow } from "../../src/seed/recipes";
import type { PlanOptions } from "../../src/planner/deterministic";
import type { GoldenCase } from "./harness";
import { BLUE, cutoutOf, GREEN, goldenPhotos, jpegBlock, photoOfCutout, RED, svgPhoto, type Rgb } from "./images";

/**
 * Seller text as the runner sends it: escaped, then wrapped in the untrusted
 * data tags the prompts name. A copy of trigger's wrapUserDescription (the
 * pipeline package cannot import the worker); harness.test.ts pins it.
 */
export function wrapUserDescription(description: string | undefined | null): string | null {
  if (!description || description.length === 0) {
    return null;
  }
  const escaped = description.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  return `<user_description>${escaped}</user_description>`;
}

/** A plain product analysis, the analyzer's output shape, for the stages
 * that read a profile (plan and copy). */
export const GOLDEN_PROFILE: ProductProfile = {
  productCount: 1,
  category: "home_kitchen",
  amazonProductTypeGuess: "DRINKING_CUP",
  shopifyTaxonomyGuess: "Home & Garden > Kitchen & Dining > Tableware > Drinkware > Mugs",
  name: "Stoneware coffee mug",
  formFactor: "mug with handle",
  materials: ["stoneware"],
  dominantColors: [{ name: "navy", hex: "#1F2F5A", coveragePct: 70 }],
  dimensions: { value: "12 oz", source: "user" },
  preserveText: [{ text: "CURVI", location: "front center" }],
  preserveLogos: ["CURVI wordmark"],
  surface: { reflective: false, transparent: false, textured: false },
  features: ["Holds 12 oz", "Dishwasher safe", "Comfortable handle"],
  benefits: ["Keeps coffee warm longer", "Easy to clean"],
  targetBuyer: "home coffee drinkers",
  useContexts: ["kitchen", "office desk"],
  photographedAngles: ["front", "45"],
  missingAnglesNeeded: ["back"],
  complianceFlags: ["none"],
  imageQuality: { usableForMain: true, issues: [] },
};

const GOLDEN_PLAN_OPTIONS: PlanOptions = {
  channels: ["amazon", "shopify.product"],
  tier: "growth",
  creditBudget: 20,
  hasBoxContents: false,
  hasComparisonFacts: false,
  hasVideoSource: false,
  primaryMediaId: "golden/front.jpg",
};

const COPY_SHOTS: Pick<Shot, "type" | "channels">[] = [
  { type: "aplus_features", channels: ["amazon.aplus.basic_header"] },
  { type: "aplus_pain_points", channels: ["amazon.aplus.basic_header"] },
  { type: "aplus_how_to", channels: ["amazon.aplus.basic_header"] },
  { type: "ad_variant", channels: ["meta.feed_1x1"] },
  { type: "ad_variant", channels: ["meta.feed_4x5"] },
];

/** The copy request the runner sends for a copy_generator row: the pack
 * request (A+ modules and ads) from the ad copy version on, else modules
 * only. */
export function copyPayload(row: Pick<RecipeRow, "key" | "version">, note: string | null): unknown {
  const wrapped = wrapUserDescription(note);
  if (row.key === adCopyRecipe.key && row.version >= adCopyRecipe.minVersion) {
    return packCopyRequest(GOLDEN_PROFILE, COPY_SHOTS, wrapped);
  }
  return aplusCopyRequest(GOLDEN_PROFILE, COPY_SHOTS.map((s) => s.type).filter(isAplusModuleType), wrapped);
}

/** Intake's payload for one photo. */
export function intakePayload(id: string, note: string | null): () => unknown {
  return () => ({ images: [{ mediaId: `golden/${id}.jpg` }], userDescription: wrapUserDescription(note) });
}

/** The picker's inputs for products of these colors on one photo: the
 * contact sheet and the photo, with the items in sheet order. */
export async function pickerInputs(
  colors: readonly Rgb[],
  labels: readonly string[],
): Promise<{ blocks: LlmContentBlock[]; items: Array<{ number: number; color: string; shape: string; label: string }> }> {
  const cutout = cutoutOf(colors);
  const inventory = analyzeInventory(cutout);
  const order = pickerNumbering(inventory.objects).map((index) => inventory.objects[index]);
  const sheet = await renderContactSheet(
    cutout,
    order.map((o) => o.pixelBox),
  );
  const photo = await jpegBlock(await photoOfCutout(colors));
  return {
    blocks: [{ type: "image", mediaType: "image/jpeg", base64: sheet.buffer.toString("base64") }, photo],
    items: order.map((o, i) => ({ number: i + 1, color: o.color.name, shape: o.shape, label: labels[o.index] ?? "item" })),
  };
}

export function pickerPayload(
  items: unknown,
  note: string | null,
  featureOnly: string | null,
): () => unknown {
  return () => ({
    userDescription: wrapUserDescription(note),
    sellerIntent: { featureOnly, exclude: [] },
    items,
  });
}

/** The judge's payload, as the runner builds it for one shot. */
export function judgePayload(args: {
  id: string;
  scene: string;
  fidelity: { pass: boolean; meanDeltaE: number; exactByteShare: number };
  sellerIntent?: { featured: string; exclude: string[] };
}): () => unknown {
  return () => ({
    shot: { id: args.id, type: "lifestyle", scene: args.scene, channel: "shopify.product" },
    ...(args.sellerIntent ? { sellerIntent: args.sellerIntent } : {}),
    deterministic: {
      pixel: { pass: true, checks: [{ name: "dimensions", pass: true }] },
      fidelity: args.fidelity,
    },
    attempt: 1,
  });
}

/** The question planner's payload, as the preflight builds it. */
export function questionPayload(args: {
  openKinds: string[];
  items: Array<{ number: number; label: string; color: string }>;
  products: string[];
  note: string | null;
}): () => unknown {
  return () => ({
    openKinds: args.openKinds,
    maxQuestions: questionSet.maxQuestions,
    items: args.items,
    products: args.products,
    sellerIntent: null,
    ...questionPlannerChoices(),
    userDescription: wrapUserDescription(args.note),
  });
}

/** The judge's two images: the shipped still, then the product reference. */
export async function judgeBlocks(shippedBody: string): Promise<LlmContentBlock[]> {
  const reference = await svgPhoto(`<rect x="156" y="156" width="200" height="200" fill="rgb(200,30,40)"/>`, "rgb(255,255,255)");
  const shipped = await svgPhoto(
    `<rect x="0" y="330" width="512" height="182" fill="rgb(160,120,80)"/>${shippedBody}`,
    "rgb(214,226,236)",
  );
  return [await jpegBlock(shipped), await jpegBlock(reference)];
}

export const JUDGE_RED_PRODUCT = `<rect x="156" y="156" width="200" height="200" fill="rgb(200,30,40)"/>`;

/** Every golden case, built once (the photos are drawn here). */
export async function goldenCases(): Promise<GoldenCase[]> {
  const photos = await goldenPhotos();
  const block = (name: keyof typeof photos) => jpegBlock(photos[name]);
  const cases: GoldenCase[] = [];

  // Intake: the moderation flags and sellableProduct must agree with Claude.
  const intake: Array<[string, keyof typeof photos, string | null, string]> = [
    ["intake_single_box", "labelBox", null, "one boxed product with a printed label"],
    ["intake_two_bottles_note", "twoBottles", "the blue one only", "two bottles, the note names one"],
    ["intake_blank_wall", "blankWall", null, "a plain wall with no product"],
    ["intake_screenshot", "screenshot", null, "a screenshot of a shop page"],
    ["intake_overlay", "overlay", "Green storage tin", "a product photo with a sale banner and border added"],
  ];
  for (const [id, photo, note, description] of intake) {
    cases.push({ id, stage: "intake", description, blocks: [await block(photo)], payload: intakePayload(id, note) });
  }

  // Analyze: preserveText and preserveLogos recall of Claude's entries.
  const analyze: Array<[string, keyof typeof photos, string | null, string]> = [
    ["analyze_label_box", "labelBox", "Navy storage box with our CURVI label", "box with the printed word CURVI"],
    ["analyze_logo_bottle", "logoBottle", null, "bottle with a round AQUA logo"],
    ["analyze_ring", "ring", "Gold ring", "a plain ring with no text"],
  ];
  for (const [id, photo, note, description] of analyze) {
    cases.push({ id, stage: "analyze", description, blocks: [await block(photo)], payload: intakePayload(id, note) });
  }

  // Plan: a valid plan, or a fallback to the deterministic plan.
  cases.push({
    id: "plan_mug_amazon_shopify",
    stage: "plan",
    description: "a mug for Amazon and Shopify",
    blocks: [],
    payload: () => ({ profile: GOLDEN_PROFILE, options: GOLDEN_PLAN_OPTIONS }),
  });
  cases.push({
    id: "plan_mug_amazon_only",
    stage: "plan",
    description: "a mug for Amazon on a small budget",
    blocks: [],
    payload: () => ({ profile: GOLDEN_PROFILE, options: { ...GOLDEN_PLAN_OPTIONS, channels: ["amazon"], creditBudget: 8 } }),
  });

  // Copy: schema only (the claims guard runs after it in the runner).
  cases.push({
    id: "copy_mug_modules_ads",
    stage: "copy",
    description: "A+ modules and ad lines for a mug",
    blocks: [],
    payload: (row) => copyPayload(row, "Our best mug for slow mornings"),
  });
  cases.push({
    id: "copy_mug_no_note",
    stage: "copy",
    description: "A+ modules and ad lines with no note",
    blocks: [],
    payload: (row) => copyPayload(row, null),
  });

  // QC judge: verdicts must agree with Claude.
  cases.push({
    id: "judge_faithful",
    stage: "qc",
    description: "the shipped still shows the reference product unchanged",
    blocks: await judgeBlocks(JUDGE_RED_PRODUCT),
    payload: judgePayload({
      id: "judge_faithful",
      scene: "kitchen counter in soft daylight",
      fidelity: { pass: true, meanDeltaE: 0.4, exactByteShare: 0.99 },
    }),
  });
  cases.push({
    id: "judge_color_shift",
    stage: "qc",
    description: "the shipped still shows the product in another color",
    blocks: await judgeBlocks(`<rect x="156" y="156" width="200" height="200" fill="rgb(40,170,70)"/>`),
    payload: judgePayload({
      id: "judge_color_shift",
      scene: "kitchen counter in soft daylight",
      fidelity: { pass: false, meanDeltaE: 38.5, exactByteShare: 0.02 },
    }),
  });
  cases.push({
    id: "judge_extra_item",
    stage: "qc",
    description: "the shipped still shows an excluded second product",
    blocks: await judgeBlocks(
      `<rect x="96" y="156" width="160" height="200" fill="rgb(200,30,40)"/><rect x="290" y="156" width="140" height="200" fill="rgb(30,60,200)"/>`,
    ),
    payload: judgePayload({
      id: "judge_extra_item",
      scene: "kitchen counter in soft daylight",
      fidelity: { pass: true, meanDeltaE: 0.6, exactByteShare: 0.97 },
      sellerIntent: { featured: "red box", exclude: ["blue box"] },
    }),
  });

  // Target picker: choices must agree with Claude on every photo.
  const twoBottles = await pickerInputs([RED, BLUE], ["red sports bottle", "blue sports bottle"]);
  cases.push({
    id: "pick_two_note_blue",
    stage: "pick",
    description: "two bottles, the note asks for the blue one",
    blocks: twoBottles.blocks,
    payload: pickerPayload(twoBottles.items, "the blue one only", "blue sports bottle"),
  });
  const threeCans = await pickerInputs([RED, BLUE, GREEN], ["red can", "blue can", "green can"]);
  cases.push({
    id: "pick_three_note_green",
    stage: "pick",
    description: "three cans, the note asks for the green one",
    blocks: threeCans.blocks,
    payload: pickerPayload(threeCans.items, "just the green can please", "green can"),
  });
  cases.push({
    id: "pick_two_no_hint",
    stage: "pick",
    description: "two bottles, the note names neither",
    blocks: twoBottles.blocks,
    payload: pickerPayload(twoBottles.items, "make it look premium", null),
  });

  // Brand palette namer: schema only.
  const reading = await readLogoPalette(photos.logo);
  const logo: LlmContentBlock = {
    type: "image",
    mediaType: "image/jpeg",
    base64: (await logoVisionJpeg(photos.logo)).toString("base64"),
  };
  cases.push({
    id: "brand_navy_orange",
    stage: "brand",
    description: "a two color logo with a near duplicate orange",
    blocks: [logo],
    payload: () => paletteNamingPayload(reading),
  });

  // Question planner: schema only (finalizeQuestions caps it after).
  const items = [
    { number: 1, label: "red sports bottle", color: "red" },
    { number: 2, label: "blue sports bottle", color: "blue" },
  ];
  cases.push({
    id: "question_two_bottles",
    stage: "question",
    description: "two bottles and no note: target is open",
    blocks: [],
    payload: questionPayload({
      openKinds: ["target", "channels", "mood", "use", "audience"],
      items,
      products: items.map((i) => i.label),
      note: null,
    }),
  });
  cases.push({
    id: "question_one_mug",
    stage: "question",
    description: "one mug, a note about the look",
    blocks: [],
    payload: questionPayload({
      openKinds: ["channels"],
      items: [],
      products: ["navy stoneware mug"],
      note: "cozy kitchen look please",
    }),
  });
  return cases;
}
