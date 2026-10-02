import type { Metadata } from "next";
import { packBundles, tiers, type TierDefinition } from "@curvi/pipeline/seed";
import { isCheckoutOpen, siteUrl } from "@/lib/env";
import { amazonMainRules, isLive, joinList, liveChannelNames, type Availability } from "@/lib/marketing-facts";
import { checkerChannels } from "@/lib/tools/checker-rules";

/**
 * Search, answer engine and generative engine metadata for the marketing
 * site. Page titles, descriptions, canonical URLs, social cards and JSON-LD
 * all come from here so every page targets the same keyword set and prices
 * always come from the seed (CLAUDE.md rule 2).
 */

export const SITE_NAME = "Curvi";

/** Home page title, used as an absolute title so the brand is not repeated. */
export const SITE_TITLE = "AI E-Commerce Product Images for Amazon and Shopify | Curvi";

/** Kept under this length so the home title shows in full in search results. */
export const SITE_TITLE_MAX = 60;

export const SITE_DESCRIPTION =
  "AI product images for e-commerce that keep your real product. One photo becomes Amazon, Shopify and social listing images, each checked against channel rules.";

/** The category Curvi names itself with, reused by pages, JSON-LD and llms.txt. */
export const SITE_CATEGORY = "AI e-commerce image compiler";

/** One sentence answer to "what is Curvi", reused by JSON-LD and llms.txt. */
export const SITE_SUMMARY =
  "Curvi is an AI e-commerce image compiler for Shopify and Amazon sellers. It turns one product photo into a pack of channel ready listing images, measures every file against the channel rules, and never regenerates the product itself.";

/**
 * The positioning in two plain sentences an answer engine can quote: how
 * Curvi differs from general image generators and from other product photo
 * tools. States only what ships (fidelity lock, measured checks, one run).
 */
export const SITE_POSITIONING =
  "General AI image generators draw every pixel from a prompt, so a real product's label, logo, shape or color can come out different. Curvi keeps the seller's real product pixels, generates only the light, shadow and setting around them, and measures every file against the channel's image rules before it ships.";

export const SITE_KEYWORDS = [
  "e-commerce",
  "AI e-commerce",
  "AI e-commerce images",
  "AI products",
  "AI product images",
  "AI product photos",
  "AI product photography",
  "AI images",
  "AI images for online stores",
  "AI product images for Amazon",
  "AI images for Shopify",
  "AI product images for Shopify",
  "Amazon main image white background AI",
  "Amazon main image requirements",
  "white background product photos",
  "AI product photo that keeps the product",
  "marketplace image compliance",
  "AI e-commerce image compiler",
];

const amazonMain = amazonMainRules();

/**
 * Features that work in the product today. Keep this list honest: numbers
 * come from the spec registry and channels from the availability list in
 * lib/marketing-facts, and a test fails if an item names something that is
 * coming soon.
 */
export const SITE_FEATURES = [
  `Pure white Amazon main images measured against the ${amazonMain.fillMinPercent} to ${amazonMain.fillMaxPercent} percent fill rule`,
  "AI lifestyle scenes built around the real product photo",
  "Product pixels never regenerated, so labels and logos never warp",
  `Channel sized image files for ${joinList(liveChannelNames())}`,
  "A compliance report that checks background, fill and resolution for every file",
  "Your first brand kit color used for the brand color background shot in packs",
  "A whole listing pack compiled from one product photo in one run",
  "Files that still fail their channel checks are marked for review and not charged",
  `Free browser tools: a main image checker for ${joinList(checkerChannels().map((channel) => channel.name))}, a white background fixer and a marketplace image resizer`,
  // PHASE_16 formats, each worded only while its flag says live.
  ...(isLive("packBundles")
    ? [`Pack sets that choose how much a pack makes: ${joinList(Object.values(packBundles).map((bundle) => bundle.label))}`]
    : []),
  ...(isLive("aplusModules")
    ? ["Amazon A+ content modules built from the product's own facts and your press quotes or awards"]
    : []),
  ...(isLive("adsFormats")
    ? [
        "Moodboard pins, social carousels that read as one story across the swipe, and static ad packs in several versions with a sheet of headlines and calls to action",
      ]
    : []),
  // P18-11, worded only while the urlImport flag says live.
  ...(isLive("urlImport")
    ? ["Start a pack from a Shopify or Amazon product link: the name and notes fill in, and you pick the photo"]
    : []),
];

/** The social card rendered by app/opengraph-image.tsx. */
export const OG_IMAGE = {
  url: "/opengraph-image",
  width: 1200,
  height: 630,
  alt: "Curvi: AI e-commerce product images for Amazon and Shopify. Shot once. Ready everywhere.",
};

export const TITLE_MAX = 70;
export const DESCRIPTION_MAX = 160;

interface PageSeoInput {
  /** Page title. The root layout template appends " | Curvi" unless absolute. */
  title: string;
  description: string;
  /** Canonical path, starting with "/". */
  path: string;
  keywords?: string[];
  /** Use the title as is, without the brand template. */
  absoluteTitle?: boolean;
  noIndex?: boolean;
  /** A page's own social card, e.g. a share page's before and after. */
  image?: { url: string; width: number; height: number; alt: string };
}

/** The title as it renders in the browser tab and search results. */
export function renderedTitle(title: string, absolute = false): string {
  return absolute ? title : `${title} | ${SITE_NAME}`;
}

/**
 * Full metadata for one marketing page. Next.js replaces nested objects such
 * as openGraph instead of merging them, and a page that sets openGraph also
 * loses the root opengraph-image file, so every page sets its own social card
 * title, description, URL and image here.
 */
export function pageMetadata(input: PageSeoInput): Metadata {
  const fullTitle = renderedTitle(input.title, input.absoluteTitle);
  const image = input.image ?? OG_IMAGE;
  return {
    title: input.absoluteTitle ? { absolute: input.title } : input.title,
    description: input.description,
    keywords: input.keywords ?? SITE_KEYWORDS,
    alternates: { canonical: input.path },
    openGraph: {
      type: "website",
      siteName: SITE_NAME,
      locale: "en_US",
      url: input.path,
      title: fullTitle,
      description: input.description,
      images: [image],
    },
    twitter: {
      card: "summary_large_image",
      title: fullTitle,
      description: input.description,
      images: [image.url],
    },
    ...(input.noIndex ? { robots: { index: false, follow: true } } : {}),
  };
}

/**
 * Join whole sentences until the next one would pass the limit, so search
 * snippets never end mid word. Falls back to a word boundary cut.
 */
export function fitDescription(text: string, max = DESCRIPTION_MAX): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) {
    return clean;
  }
  const sentences = clean.match(/[^.!?]+[.!?]+/g) ?? [];
  let result = "";
  for (const sentence of sentences) {
    const next = `${result} ${sentence.trim()}`.trim();
    if (next.length > max) {
      break;
    }
    result = next;
  }
  if (result) {
    return result;
  }
  const cut = clean.slice(0, max - 1);
  return `${cut.slice(0, cut.lastIndexOf(" "))}.`;
}

/**
 * A channel page sells files only when a pack makes them (the spec level
 * availability in lib/marketing-facts). Otherwise the snippet says the files
 * are coming soon, so search results never promise them.
 */
export function channelPageSeo(
  displayName: string,
  status: Availability,
): { title: string; description: string } {
  const rules = `${displayName} rules: size, background, product fill, text, format and file size`;
  return {
    title: `${displayName} requirements and size guide`,
    description: fitDescription(
      status === "live"
        ? `${rules}, and how Curvi builds and measures files to match.`
        : `${rules}, with Curvi files for it coming soon.`,
    ),
  };
}

export function categoryPageSeo(name: string): { title: string; description: string } {
  const lower = name.toLowerCase();
  return {
    title: `AI ${lower} product photos for Shopify and Amazon`,
    description: fitDescription(
      `AI product photos for ${lower} sellers on Shopify and Amazon: a compliant main image and lifestyle scenes from one photo, product never repainted.`,
    ),
  };
}

// JSON-LD

type JsonLdNode = Record<string, unknown>;

/**
 * Serialize JSON-LD for a script tag. Escaping "<" stops any string value
 * from closing the script element early.
 */
export function serializeJsonLd(data: JsonLdNode | JsonLdNode[]): string {
  return JSON.stringify(data).replace(/</g, "\\u003c");
}

function absoluteUrl(path: string): string {
  return new URL(path, siteUrl()).toString();
}

function organizationId(): string {
  return absoluteUrl("/#organization");
}

function softwareId(): string {
  return absoluteUrl("/#software");
}

export function organizationJsonLd(): JsonLdNode {
  return {
    "@type": "Organization",
    "@id": organizationId(),
    name: SITE_NAME,
    url: absoluteUrl("/"),
    email: "hello@curvi.ai",
    logo: absoluteUrl("/brand/curvi-mark-512.png"),
    image: absoluteUrl("/brand/curvi-mark-512.png"),
    description: SITE_SUMMARY,
    slogan: "Shot once. Ready everywhere.",
    knowsAbout: [
      "E-commerce product photography",
      "AI product images",
      "Amazon main image requirements",
      "Shopify product images",
      "Marketplace image compliance",
    ],
  };
}

export function websiteJsonLd(): JsonLdNode {
  return {
    "@type": "WebSite",
    "@id": absoluteUrl("/#website"),
    name: SITE_NAME,
    url: absoluteUrl("/"),
    description: SITE_DESCRIPTION,
    inLanguage: "en",
    publisher: { "@id": organizationId() },
  };
}

function tierName(tier: TierDefinition): string {
  return tier.key.charAt(0).toUpperCase() + tier.key.slice(1);
}

function tierOffer(tier: TierDefinition): JsonLdNode {
  const credits =
    tier.creditsPerMonth > 0 ? `${tier.creditsPerMonth} credits per month` : `${tier.creditsOnce} credits once`;
  return {
    "@type": "Offer",
    name: `${tierName(tier)} plan`,
    description: credits,
    price: tier.monthlyUsd,
    priceCurrency: "USD",
    url: absoluteUrl("/pricing"),
    ...(tier.monthlyUsd > 0
      ? {
          priceSpecification: {
            "@type": "UnitPriceSpecification",
            price: tier.monthlyUsd,
            priceCurrency: "USD",
            unitText: "month",
          },
        }
      : {}),
  };
}

/**
 * Plans that can be bought today. Paid tiers are listed only once Stripe is
 * configured, so answer engines are never told a plan is for sale when
 * checkout cannot take payment, and never a tier set up by email (P20-08).
 */
export function purchasableTiers(): TierDefinition[] {
  return tiers.filter((tier) => tier.monthlyUsd === 0 || (tier.selfServe && isCheckoutOpen()));
}

/** The product itself, with one offer per purchasable plan from the tier seed. */
export function softwareApplicationJsonLd(): JsonLdNode {
  return {
    "@type": "SoftwareApplication",
    "@id": softwareId(),
    name: SITE_NAME,
    url: absoluteUrl("/"),
    applicationCategory: "BusinessApplication",
    applicationSubCategory: SITE_CATEGORY,
    operatingSystem: "Web",
    description: `${SITE_SUMMARY} ${SITE_POSITIONING}`,
    featureList: SITE_FEATURES,
    keywords: SITE_KEYWORDS.join(", "),
    audience: {
      "@type": "BusinessAudience",
      audienceType: "E-commerce sellers and brands on Shopify, Amazon and other marketplaces",
    },
    publisher: { "@id": organizationId() },
    offers: purchasableTiers().map(tierOffer),
  };
}

export function faqPageJsonLd(faqs: { question: string; answer: string }[]): JsonLdNode {
  return {
    "@type": "FAQPage",
    mainEntity: faqs.map((faq) => ({
      "@type": "Question",
      name: faq.question,
      acceptedAnswer: { "@type": "Answer", text: faq.answer },
    })),
  };
}

export function breadcrumbJsonLd(items: { name: string; path: string }[]): JsonLdNode {
  return {
    "@type": "BreadcrumbList",
    itemListElement: items.map((item, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: item.name,
      item: absoluteUrl(item.path),
    })),
  };
}

/** A free in browser tool page. */
export function webApplicationJsonLd(input: { name: string; path: string; description: string }): JsonLdNode {
  return {
    "@type": "WebApplication",
    name: input.name,
    url: absoluteUrl(input.path),
    description: input.description,
    applicationCategory: "BusinessApplication",
    operatingSystem: "Web",
    isAccessibleForFree: true,
    // A free tool, not a plan price, so this zero is not a seed value.
    offers: { "@type": "Offer", price: 0, priceCurrency: "USD" },
    publisher: { "@id": organizationId() },
  };
}

/**
 * A long form guide page. The about node points at the product so answer
 * engines connect the page's answers to Curvi.
 */
export function webPageJsonLd(input: { name: string; path: string; description: string }): JsonLdNode {
  return {
    "@type": "WebPage",
    "@id": absoluteUrl(`${input.path}#webpage`),
    name: input.name,
    url: absoluteUrl(input.path),
    description: input.description,
    inLanguage: "en",
    isPartOf: { "@id": absoluteUrl("/#website") },
    about: { "@id": softwareId() },
    publisher: { "@id": organizationId() },
  };
}

/** Wrap several nodes in one graph so they can reference each other by @id. */
export function jsonLdGraph(nodes: JsonLdNode[]): JsonLdNode {
  return { "@context": "https://schema.org", "@graph": nodes };
}
