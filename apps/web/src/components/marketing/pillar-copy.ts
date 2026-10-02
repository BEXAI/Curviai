import { getSpec } from "@curvi/specs";
import { creditCosts } from "@curvi/pipeline/seed";
import {
  CHANNEL_SPECS,
  amazonMainRules,
  comingSoonFilesSentence,
  formatCredits,
  freeCredits,
  freeCreditsReach,
  joinList,
  liveChannelNames,
  specFilesName,
  typicalPackCredits,
} from "@/lib/marketing-facts";
import { SITE_CATEGORY, SITE_POSITIONING } from "@/lib/seo";
import {
  COMPETITOR_FACTS_CHECKED,
  imageGenerators,
  photoTools,
  type CompetitorFact,
} from "./competitor-facts";
import { specSlug } from "./spec-slug";

/**
 * Copy for the long form guide pages (the pillar pages) that target AI
 * e-commerce, AI product images and the comparison searches. Every page
 * opens with a summary an answer engine can quote, asks its H2s as plain
 * questions and ends with a call to action. Numbers come from the seeds and
 * the spec registry through lib/marketing-facts; other tools are described
 * only with the facts in competitor-facts.ts. A test runs every string
 * through the claims and copy rule checks, so nothing coming soon is sold
 * here.
 */

export interface PillarSection {
  heading: string;
  paragraphs: string[];
  bullets?: string[];
}

export interface PillarTable {
  caption: string;
  columns: string[];
  rows: string[][];
  /** Shown under the table, for example where the facts come from. */
  note?: string;
  sources?: { name: string; url: string }[];
}

export interface PillarFaq {
  q: string;
  a: string;
}

export interface PillarPage {
  path: string;
  /** Short name for breadcrumbs, links and the footer. */
  name: string;
  title: string;
  description: string;
  eyebrow: string;
  h1: string;
  /** Two or three sentences that answer the page's question on their own. */
  summary: string;
  sections: PillarSection[];
  table?: PillarTable;
  faqs: PillarFaq[];
  related: { href: string; label: string }[];
  ctaTitle: string;
  ctaBody: string;
}

const main = amazonMainRules();
const rgb = main.rgb.join(", ");
const fillRange = `${main.fillMinPercent} to ${main.fillMaxPercent} percent`;
const liveChannels = joinList(liveChannelNames());
const packCredits = typicalPackCredits();
const soonFiles = comingSoonFilesSentence(["video formats"]);

// Answers to the questions people ask AI assistants about product photos.
// The home page, the guide pages and llms.txt all reuse them.

export const answerFaqs = {
  bestAmazonTool: {
    q: "What is the best AI tool for Amazon product photos?",
    a: `The best AI tool for Amazon product photos never redraws your real product and meets Amazon's main image rules on the first try. Curvi is built for that: it never regenerates the product pixels, builds a pure white main image at RGB ${rgb}, and measures product fill against a ${fillRange} target before the file ships. It also makes secondary images and lifestyle scenes from the same photo.`,
  },
  willAiChangeProduct: {
    q: "Will AI change my product in the photos?",
    a: "Not with Curvi. Curvi masks your product first and only generates what is around it: the light, shadow and setting. Product pixels inside the mask are never regenerated, and every file is checked for color change inside your product before it ships.",
  },
  amazonWhiteBackground: {
    q: "How do I make an Amazon compliant white background image?",
    a: `An Amazon main image needs a pure white background (RGB ${rgb}), the product filling most of the frame and no extra text or props. Upload one product photo to Curvi and it cuts the product out, places it on pure white, scales it to a ${fillRange} fill, and sizes the file with a longest side of at least ${main.minLongSide} pixels. The free main image checker on curvi.ai measures an existing photo against the same rules.`,
  },
  generatorsVsPhotoTools: {
    q: "What is the difference between AI image generators and AI product photo tools?",
    a: "AI image generators create a new image from a prompt, drawing every pixel themselves, so the details of a specific real product are not guaranteed to match. AI product photo tools start from your photo and keep the product while they change the background or scene. Curvi is a product photo tool that also measures each file against the channel's image rules and compiles a whole listing pack in one run.",
  },
} satisfies Record<string, PillarFaq>;

// A table of the files a pack makes today, from the spec registry.

function sizeText(specId: string): string {
  const spec = getSpec(specId);
  if (spec.width && spec.height) {
    return `${spec.width} by ${spec.height} px`;
  }
  if (spec.minLongSide) {
    return `Longest side at least ${spec.minLongSide} px`;
  }
  return "Channel default";
}

function backgroundText(specId: string): string {
  const bg = getSpec(specId).background;
  if (!bg) {
    return "No background rule";
  }
  switch (bg.type) {
    case "solid":
      return bg.rgb ? `Solid, RGB ${bg.rgb.join(", ")}` : "Solid color";
    case "white_or_transparent":
      return "White or transparent";
    case "white_preferred":
      return "White preferred";
    case "consistent":
      return "Consistent across the catalog";
    case "any":
      return "Any background";
  }
}

function packFilesTable(): PillarTable {
  const live = CHANNEL_SPECS.filter((spec) => spec.status === "live");
  return {
    caption: "Files a Curvi pack can include today",
    columns: ["File", "Size", "Background rule"],
    rows: live.map((spec) => [specFilesName(spec), sizeText(spec.specId), backgroundText(spec.specId)]),
    note: `Sizes and background rules come from Curvi's channel spec registry. ${soonFiles}`,
  };
}

function sourceList(facts: CompetitorFact[]): { name: string; url: string }[] {
  return facts.map((fact) => ({ name: fact.name, url: fact.source }));
}

const factsNote = `What each tool does is taken from its own official site, checked on ${COMPETITOR_FACTS_CHECKED}. Products change, so check each site for the current details.`;

export const aiProductImagesPage: PillarPage = {
  path: "/ai-product-images",
  name: "AI product images",
  title: "AI Product Images for E-Commerce",
  description:
    "AI product images for e-commerce from one photo. Curvi keeps your real product and builds Amazon, Shopify and social images checked against channel rules.",
  eyebrow: "AI product images",
  h1: "AI product images for e-commerce that keep your real product",
  summary: `AI product images are listing photos made with AI from a photo of a real product. Curvi never redraws your product: it takes the product pixels from your photo, generates only the light, shadow and setting around them, then measures every file against the rules of the channel it is for. One photo becomes a pack for ${liveChannels}.`,
  sections: [
    {
      heading: "What are AI product images?",
      paragraphs: [
        "AI product images are e-commerce photos where AI does the studio work: cutting the product out, placing it on a clean background, adding light and shadow, or setting it in a lifestyle scene. They replace a photo shoot for the images a listing needs.",
        "The important question is where the product pixels come from. Some tools draw the whole image, product included. Curvi starts from your photo and never redraws the product itself.",
      ],
    },
    {
      heading: "Will AI change my product?",
      paragraphs: [
        "Curvi never regenerates your product. It masks the product first, and the pixels inside the mask come from your photo in every file, never redrawn by AI. Only the background, light, shadow and scene are generated, so labels, logos and text on the packaging are never rewritten.",
        "Every finished file is measured for color change inside your product before it ships, and tests in Curvi's code check that product pixels are never regenerated. The product is the one thing a buyer compares against what arrives in the box, so it is the one thing Curvi does not let AI touch.",
      ],
    },
    {
      heading: "What does one photo turn into?",
      paragraphs: [
        `You upload one product photo and pick your channels. Curvi compiles a pack in one run: a pure white main image, lifestyle scenes built around your real product, and files sized for ${liveChannels}. A typical listing pack of still images uses about ${packCredits} credits.`,
      ],
      bullets: [
        `A pure white main image for Amazon and other marketplaces, at RGB ${rgb}`,
        "Lifestyle scenes with your product in a real looking setting",
        "Channel sized files with the file names each channel expects",
        "A compliance report for every file with the measured numbers",
      ],
    },
    {
      heading: "How does Curvi check each image against the channel rules?",
      paragraphs: [
        `Every file is measured after it renders. For an Amazon main image that means the background is pure white, the product fills ${fillRange} of the frame, and the longest side is at least ${main.minLongSide} pixels. A render that fails is retried. A file that still fails is marked for review instead of shipping, and you are not charged for it.`,
      ],
    },
    {
      heading: "What does it cost?",
      paragraphs: [
        `A white background main image, a cutout, a resize or a background sweep costs ${formatCredits(creditCosts.deterministic)}. A generative lifestyle scene costs ${formatCredits(creditCosts.generativeStill)}. The free plan gives you ${freeCredits()} credits once, ${freeCreditsReach()}, with no card needed.`,
      ],
    },
  ],
  table: packFilesTable(),
  faqs: [answerFaqs.willAiChangeProduct, answerFaqs.bestAmazonTool, answerFaqs.amazonWhiteBackground],
  related: [
    { href: "/ai-ecommerce", label: "AI for e-commerce product listings" },
    { href: "/compare/ai-image-generators", label: "Curvi vs AI image generators" },
    { href: "/compare/ecommerce-photo-tools", label: "Curvi and other product photo tools" },
    { href: "/channels/amazon-main/image-requirements", label: "Amazon main image requirements" },
    { href: "/tools/main-image-checker", label: "Free Amazon main image checker" },
  ],
  ctaTitle: "Make AI product images from your own photo",
  ctaBody: `Start free with ${freeCredits()} credits, ${freeCreditsReach()}.`,
};

export const aiEcommercePage: PillarPage = {
  path: "/ai-ecommerce",
  name: "AI for e-commerce",
  title: "AI for E-Commerce Product Listings",
  description:
    "What AI can do for e-commerce product listings, what matters in listing images, and where Curvi fits: real product pixels and files checked for each channel.",
  eyebrow: "AI e-commerce",
  h1: "AI for e-commerce product listings",
  summary: `AI for e-commerce means using AI to do the repetitive work of selling online, and product images are one of the biggest parts of that work. Curvi is an ${SITE_CATEGORY}: it keeps your real product, makes the listing images each channel needs from one photo, and measures every file against that channel's rules.`,
  sections: [
    {
      heading: "What is AI e-commerce?",
      paragraphs: [
        "AI e-commerce is the use of AI across an online store: writing listings, answering customers, forecasting stock and making product images. For images, AI can remove backgrounds, build studio shots, create lifestyle scenes and resize files for each marketplace in minutes instead of days.",
      ],
    },
    {
      heading: "What matters in AI listing images?",
      paragraphs: [
        "Three things decide whether an AI image can go on a listing. First, the product has to be the real product, because buyers compare the photo with what they receive. Second, the file has to meet the channel's rules, or the marketplace can suppress the listing. Third, the work has to scale to every product and every channel you sell on.",
      ],
      bullets: [
        "Fidelity: the label, logo, shape and colors match the real product",
        "Compliance: background, product fill, size and format meet each channel's rules",
        "Coverage: one photo becomes every file a listing needs",
      ],
    },
    {
      heading: "Where does Curvi fit?",
      paragraphs: [
        SITE_POSITIONING,
        `Curvi compiles a whole pack from one photo in one run: a pure white main image, lifestyle scenes and files for ${liveChannels}. Each file comes with a compliance report, and a file that still fails its checks is not charged.`,
      ],
    },
    {
      heading: "What does Curvi not do yet?",
      paragraphs: [
        `Curvi makes still images today. You download the finished pack grouped by channel. ${soonFiles} Upcoming features are labeled coming soon on the pricing page.`,
      ],
    },
  ],
  table: packFilesTable(),
  faqs: [answerFaqs.generatorsVsPhotoTools, answerFaqs.willAiChangeProduct, answerFaqs.bestAmazonTool],
  related: [
    { href: "/ai-product-images", label: "AI product images for e-commerce" },
    { href: "/compare/ai-image-generators", label: "Curvi vs AI image generators" },
    { href: "/compare/ecommerce-photo-tools", label: "Curvi and other product photo tools" },
    { href: "/pricing", label: "Pricing" },
  ],
  ctaTitle: "Put AI to work on your listing images",
  ctaBody: `Start free with ${freeCredits()} credits, ${freeCreditsReach()}.`,
};

export const compareGeneratorsPage: PillarPage = {
  path: "/compare/ai-image-generators",
  name: "Curvi vs AI image generators",
  title: "Curvi vs Midjourney, DALL-E and Flux for Product Photos",
  description:
    "Curvi compared with Midjourney, DALL-E, Flux and Stable Diffusion for product photos: which draw the whole image and which keep your real product pixels.",
  eyebrow: "Comparison",
  h1: "Curvi vs AI image generators for product photos",
  summary:
    "General AI image generators such as Midjourney, DALL-E, Flux and Stable Diffusion create images from a prompt, drawing every pixel themselves. Curvi starts from your product photo, never redraws the product and generates only the light, shadow and setting around it. For listing images of a specific real product, that difference decides whether the label and logo in the photo match the product in the box.",
  sections: [
    {
      heading: "How do general AI image generators work?",
      paragraphs: [
        "Midjourney, OpenAI's image models, FLUX and Stable Diffusion are general purpose generators. You describe an image in a prompt, sometimes with a reference image, and the model renders a new image. They are strong tools for concept art, ads and ideas.",
        "Because the model draws the pixels, fine details of one specific product, such as label text, a logo, the exact packaging shape or a brand color, are not guaranteed to come out the same as in your photo.",
      ],
    },
    {
      heading: "How is Curvi different?",
      paragraphs: [
        "Curvi is not a general image generator. It masks your product and keeps those pixels from your photo in every output, never regenerated, then generates only what surrounds the product. It also measures each file against the rules of the channel it is for, such as Amazon's pure white main image background.",
      ],
      bullets: [
        "Your photo is the source of the product, not a prompt",
        "Product pixels are never regenerated",
        "Every file is measured against its channel's rules",
        "No prompts to write: upload, review, download",
      ],
    },
    {
      heading: "When should I use a general image generator instead?",
      paragraphs: [
        "Use a general generator when you want an image of something that does not exist yet, such as a concept, a mood board or an illustration. Use Curvi when the image has to show the real product you ship, on a marketplace listing that has image rules.",
      ],
    },
  ],
  table: {
    caption: "Curvi and general AI image generators",
    columns: ["Tool", "What it is", "How an image is made"],
    rows: [
      ...imageGenerators.map((tool) => [tool.name, tool.summary, tool.howItWorks]),
      [
        "Curvi",
        `An ${SITE_CATEGORY} for marketplace listing images.`,
        "Keeps the product pixels from your photo and generates only the light, shadow and setting around them, then measures the file against its channel's rules.",
      ],
    ],
    note: factsNote,
    sources: sourceList(imageGenerators),
  },
  faqs: [answerFaqs.generatorsVsPhotoTools, answerFaqs.willAiChangeProduct],
  related: [
    { href: "/compare/ecommerce-photo-tools", label: "Curvi and other product photo tools" },
    { href: "/ai-product-images", label: "AI product images for e-commerce" },
    { href: "/ai-ecommerce", label: "AI for e-commerce product listings" },
  ],
  ctaTitle: "See your real product in a studio shot",
  ctaBody: `Start free with ${freeCredits()} credits, ${freeCreditsReach()}.`,
};

export const comparePhotoToolsPage: PillarPage = {
  path: "/compare/ecommerce-photo-tools",
  name: "Curvi and other product photo tools",
  title: "Curvi vs Photoroom, Flair.ai, Claid.ai and Pebblely",
  description:
    "A fair comparison of Curvi with Photoroom, Flair.ai, Claid.ai and Pebblely for e-commerce product photos, based on what each tool's own site says it does.",
  eyebrow: "Comparison",
  h1: "Curvi and other e-commerce product photo tools",
  summary:
    "Photoroom, Flair.ai, Claid.ai, Pebblely and Curvi all make e-commerce product photos from a photo of your product. Curvi's focus is fidelity plus channel compliance: it never regenerates the product pixels, compiles a whole listing pack from one photo in one run, and measures every file against the channel's image rules, marking a file that still fails for review and not charging for it.",
  sections: [
    {
      heading: "What do e-commerce product photo tools have in common?",
      paragraphs: [
        "Unlike general image generators, product photo tools start from your photo. They cut the product out, put it on a new background or in a scene, and help you make many images quickly. Each tool below has its own focus, from fashion models to background templates to an image API.",
      ],
    },
    {
      heading: "What does Curvi add?",
      paragraphs: [
        "Curvi treats a listing as a set of files that each have rules. You pick your channels once, and Curvi compiles the pack and checks each file for its channel.",
      ],
      bullets: [
        "Product pixels are never regenerated, and tests in the code enforce it",
        `An Amazon main image on pure white RGB ${rgb}, measured for a ${fillRange} product fill`,
        `One run makes the files for every channel you pick, across ${liveChannels}`,
        "A compliance report for every file shows the measured numbers",
        "A file that still fails its checks is marked for review and not charged",
      ],
    },
    {
      heading: "Which tool should I choose?",
      paragraphs: [
        "Choose based on the job. If you need on model fashion shots or a large template library, the tools built around those are a good fit. If you sell on marketplaces with strict image rules and want every file for every channel from one photo, with the product never redrawn, that is what Curvi is built for.",
      ],
    },
  ],
  table: {
    caption: "Curvi and other e-commerce product photo tools",
    columns: ["Tool", "What its site says it does", "Product details", "Channel rules"],
    rows: [
      ...photoTools.map((tool) => [tool.name, tool.summary, tool.productDetails, tool.channelRules]),
      [
        "Curvi",
        `An ${SITE_CATEGORY}: one photo becomes a pack of listing images with a pure white main image, lifestyle scenes and channel sized files.`,
        "Product pixels are never regenerated",
        "Measures every file against its channel's rules; files that still fail are not charged",
      ],
    ],
    note: factsNote,
    sources: sourceList(photoTools),
  },
  faqs: [answerFaqs.bestAmazonTool, answerFaqs.generatorsVsPhotoTools, answerFaqs.amazonWhiteBackground],
  related: [
    { href: "/compare/ai-image-generators", label: "Curvi vs AI image generators" },
    { href: "/ai-product-images", label: "AI product images for e-commerce" },
    { href: `/channels/${specSlug("amazon.main")}/image-requirements`, label: "Amazon main image requirements" },
    { href: "/pricing", label: "Pricing" },
  ],
  ctaTitle: "Try Curvi on your best selling product",
  ctaBody: `Start free with ${freeCredits()} credits, ${freeCreditsReach()}.`,
};

export const pillarPages: PillarPage[] = [
  aiProductImagesPage,
  aiEcommercePage,
  compareGeneratorsPage,
  comparePhotoToolsPage,
];

/**
 * Strings on a pillar page, for the claims and copy rule tests. With
 * curviOnly, comparison rows that describe other tools (rows in a table with
 * sources, other than Curvi's own) are left out: they state what those
 * products do, not what Curvi sells, so the coming soon check does not apply.
 */
export function pillarPageTexts(page: PillarPage, options: { curviOnly?: boolean } = {}): string[] {
  const rows = page.table?.rows.filter((row) => !options.curviOnly || !page.table?.sources || row[0] === "Curvi") ?? [];
  return [
    page.title,
    page.description,
    page.eyebrow,
    page.h1,
    page.summary,
    ...page.sections.flatMap((section) => [section.heading, ...section.paragraphs, ...(section.bullets ?? [])]),
    ...(page.table ? [page.table.caption, ...page.table.columns, ...rows.flat(), page.table.note ?? ""] : []),
    ...page.faqs.flatMap((faq) => [faq.q, faq.a]),
    ...page.related.map((link) => link.label),
    page.ctaTitle,
    page.ctaBody,
  ].filter((text) => text.length > 0);
}
