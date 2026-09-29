/**
 * What other tools say about themselves, for the comparison pages. Every
 * line here paraphrases the tool's own official site or docs, fetched on
 * the date in COMPETITOR_FACTS_CHECKED and recorded in docs/verification.md
 * (CLAUDE.md rule 7). Only neutral, verified facts about what each product
 * does: no claims about what a tool cannot do, no pricing, no logos. When a
 * site does not state something, the table says so instead of guessing.
 * Recheck and update the date before changing any line.
 */

export const COMPETITOR_FACTS_CHECKED = "2026-09-29";

/** Shown in a table cell when a tool's own site does not state the point. */
export const NOT_STATED = "Not stated on its site";

export interface CompetitorFact {
  name: string;
  /** Official page the facts come from. */
  source: string;
  /** What the tool does, in its own terms. */
  summary: string;
}

export interface GeneratorFact extends CompetitorFact {
  /** How an image is made, per the official docs. */
  howItWorks: string;
}

export interface PhotoToolFact extends CompetitorFact {
  /** What the site says about keeping product details. */
  productDetails: string;
  /** What the site says about marketplace or platform image rules. */
  channelRules: string;
}

export const imageGenerators: GeneratorFact[] = [
  {
    name: "Midjourney",
    source: "https://docs.midjourney.com/hc/en-us/articles/33329261836941-Getting-Started-Guide",
    summary: "A general AI image generator. You type a prompt and it creates a set of four images.",
    howItWorks:
      "Generates new images from a text prompt. Image prompts can guide content, composition, style and colors.",
  },
  {
    name: "DALL-E and OpenAI image models",
    source: "https://developers.openai.com/api/docs/guides/image-generation",
    summary: "OpenAI's image models, available through ChatGPT and the OpenAI API.",
    howItWorks:
      "Generates images from a text prompt, and edits existing images with a new prompt, partially or entirely.",
  },
  {
    name: "FLUX by Black Forest Labs",
    source: "https://bfl.ai",
    summary: "A family of generative models for images and video, offered through an API.",
    howItWorks: "Generates images from prompts, with a wide variety of styles and text rendering.",
  },
  {
    name: "Stable Diffusion by Stability AI",
    source: "https://stability.ai",
    summary: "Open generative models with image generation and editing tools for creators and developers.",
    howItWorks: "Generates and edits images from prompts, and can be deployed in your own environment.",
  },
];

export const photoTools: PhotoToolFact[] = [
  {
    name: "Photoroom",
    source: "https://www.photoroom.com",
    summary:
      "A background remover and AI photo editor with AI backgrounds, product staging, batch editing, an image API and marketplace sync.",
    productDetails: "Pixel precise cutouts for white or transparent backgrounds",
    channelRules: "Syncs images to Shopify and marketplace feeds",
  },
  {
    name: "Flair.ai",
    source: "https://flair.ai",
    summary:
      "An AI design tool for product photography, on model imagery, product videos and ad creative, with drag and drop scene staging.",
    productDetails: "Keeps patterns and logos when fitting clothing and jewelry onto AI models",
    channelRules: NOT_STATED,
  },
  {
    name: "Claid.ai",
    source: "https://claid.ai",
    summary:
      "An AI photo studio and API for product and fashion photos: generated backgrounds, AI fashion models, background removal, enhancement and upscaling.",
    productDetails: "Trained to preserve logos, branding and product shapes",
    channelRules: "Checks and edits images to platform requirements",
  },
  {
    name: "Pebblely",
    source: "https://pebblely.com",
    summary:
      "An AI product photo generator with more than 100 background templates, bulk generation and resizing for different platforms.",
    productDetails: NOT_STATED,
    channelRules: "Says its photos suit all marketplaces, platforms and channels",
  },
];
