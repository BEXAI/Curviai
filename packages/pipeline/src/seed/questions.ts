/**
 * The question step before generating (docs/phases/PHASE_16.md workstream
 * 4): the question set, as seed data (CLAUDE.md rule 2). The question_planner
 * recipe decides which of these to ask and, for use and audience, writes the
 * option labels; everything a question can say or map to otherwise lives
 * here, so a new mood or channel choice is a seed change, not a code change.
 *
 * Every string here is user facing copy (rule 9): plain words, no emoji, no
 * arrows, no dashes as punctuation.
 */

import type { PresetKey } from "./templates";

/** The kinds of question the step can ask, in the order they are shown. */
export const QUESTION_KINDS = ["target", "channels", "mood", "use", "audience"] as const;
export type QuestionKind = (typeof QUESTION_KINDS)[number];

export interface ChannelChoice {
  value: string;
  label: string;
  /** Registry spec ids an answer ticks (the form keeps only pickable ones). */
  specs: readonly string[];
  /** Note words that already answer "Where will you sell?". */
  keywords: readonly string[];
}

export interface MoodChoice {
  value: string;
  label: string;
  /** The scene style preset the answer sets on scene shots. */
  preset: PresetKey;
  /** The first lifestyle scene the answer plans. */
  scene: string;
  /** Note words that already answer "Scene mood?". */
  keywords: readonly string[];
}

export const questionSet = {
  /** At most this many questions reach the seller. */
  maxQuestions: 4,
  /** Channels, mood, use and audience offer at most this many options
   * (target offers every product the chooser would, plus the whole set). */
  maxOptions: 4,
  /** A question needs at least this many options to be worth asking. */
  minOptions: 2,
  /** The longest option label the planner may write. */
  optionLabelMax: 40,
  /** What each question asks, by kind. */
  prompts: {
    target: "Which product is this pack for?",
    channels: "Where will you sell?",
    mood: "Scene mood?",
    use: "Where is it used?",
    audience: "Who is it for?",
  } satisfies Record<QuestionKind, string>,
  /** The option that keeps every product, or every channel offered. */
  allOption: { value: "all", twoLabel: "Both", manyLabel: "All of them" },
  /** The link that hides the step. */
  skipLabel: "Skip, use my note",
  /** The line above the questions. */
  intro: "A few quick questions, so the pack fits. Tap an answer or skip them.",
} as const;

/** "Where will you sell?" options, as marketplace families of the registry. */
export const channelChoices: readonly ChannelChoice[] = [
  { value: "amazon", label: "Amazon", specs: ["amazon.main", "amazon.secondary"], keywords: ["amazon"] },
  { value: "shopify", label: "Shopify", specs: ["shopify.product"], keywords: ["shopify"] },
  { value: "etsy", label: "Etsy", specs: ["etsy.listing"], keywords: ["etsy"] },
  { value: "ebay", label: "eBay", specs: ["ebay.listing"], keywords: ["ebay"] },
  { value: "walmart", label: "Walmart", specs: ["walmart.main"], keywords: ["walmart"] },
  { value: "tiktokshop", label: "TikTok Shop", specs: ["tiktokshop.main"], keywords: ["tiktok"] },
];

/** The channel choices offered when the planner does not pick them. */
export const defaultChannelChoices = ["amazon", "shopify"] as const;

/** "Scene mood?" options. Each sets the scene preset and the first scene. */
export const moodChoices: readonly MoodChoice[] = [
  {
    value: "bright_outdoor",
    label: "Bright outdoor",
    preset: "outdoor",
    scene: "bright sunny outdoor setting",
    keywords: ["outdoor", "outdoors", "outside", "sunny", "beach", "park"],
  },
  {
    value: "kitchen",
    label: "Kitchen",
    preset: "kitchen_lifestyle",
    scene: "bright home kitchen",
    keywords: ["kitchen", "counter", "countertop"],
  },
  {
    value: "gym",
    label: "Gym",
    preset: "minimal_studio",
    scene: "modern gym with training equipment",
    keywords: ["gym", "workout", "fitness"],
  },
  {
    value: "studio",
    label: "Studio",
    preset: "minimal_studio",
    scene: "clean minimal interior",
    keywords: ["studio", "minimal", "minimalist"],
  },
  {
    value: "luxury",
    label: "Luxury",
    preset: "luxury_marble",
    scene: "elegant marble vanity",
    keywords: ["luxury", "marble", "elegant"],
  },
  {
    value: "cozy",
    label: "Cozy holiday",
    preset: "holiday",
    scene: "cozy living room at the holidays",
    keywords: ["holiday", "christmas", "cozy", "festive"],
  },
];

/** The mood choices offered when the planner does not pick them. */
export const defaultMoodChoices = ["bright_outdoor", "kitchen", "gym", "studio"] as const;
