import type { Metadata } from "next";
import { tiers, type TierDefinition } from "@curvi/pipeline/seed";
import { isStripeConfigured, siteUrl } from "@/lib/env";

/**
 * Search, answer engine and generative engine metadata for the marketing
 * site. Page titles, descriptions, canonical URLs, social cards and JSON-LD
 * all come from here so every page targets the same keyword set and prices
 * always come from the seed (CLAUDE.md rule 2).
 */

export const SITE_NAME = "Curvi";

/** Home page title, used as an absolute title so the brand is not repeated. */
export const SITE_TITLE = "AI E-Commerce Image Optimization for Shopify and Amazon | Curvi";

export const SITE_DESCRIPTION =
  "AI e-commerce image optimization for Shopify and Amazon sellers. Turn one photo into compliant listing images and lifestyle scenes, product pixels untouched.";

/** One sentence answer to "what is Curvi", reused by JSON-LD and llms.txt. */
export const SITE_SUMMARY =
  "Curvi is an AI e-commerce image tool for Shopify and Amazon sellers. It turns one product photo into a pack of marketplace compliant images, measures every file against the channel rules, and never regenerates the product itself.";

export const SITE_KEYWORDS = [
  "AI e-commerce",
  "e-commerce AI image optimization",
  "AI images for e-commerce",
  "AI product photos",
  "AI product photography",
  "AI product images for Shopify",
  "AI product images for Amazon",
  "Shopify product images",
  "Amazon product images",
  "Amazon main image requirements",
  "white background product photos",
  "marketplace image compliance",
  "e-commerce product image optimization",
];

/** Features that work in the product today. Keep this list honest. */
export const SITE_FEATURES = [
  "Pure white Amazon main images measured against the 85 percent fill rule",
  "AI lifestyle scenes built around the real product photo",
  "Product pixels never regenerated, so labels and logos never warp",
  "Channel sized exports for Amazon, Shopify, Google Merchant, Walmart, Etsy, eBay, TikTok Shop, Meta and Pinterest",
  "A compliance report that checks background, fill and resolution for every file",
  "Brand kit colors applied across the pack",
];

/** The social card rendered by app/opengraph-image.tsx. */
export const OG_IMAGE = {
  url: "/opengraph-image",
  width: 1200,
  height: 630,
  alt: "Curvi: AI e-commerce image optimization for Shopify and Amazon. Shot once. Ready everywhere.",
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
      images: [OG_IMAGE],
    },
    twitter: {
      card: "summary_large_image",
      title: fullTitle,
      description: input.description,
      images: [OG_IMAGE.url],
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

export function channelPageSeo(displayName: string): { title: string; description: string } {
  return {
    title: `${displayName} requirements and size guide`,
    description: fitDescription(
      `${displayName} rules: size, background, product fill, text, format and file size, plus how AI image optimization passes them the first time.`,
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
    description: SITE_SUMMARY,
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
 * checkout cannot take payment.
 */
export function purchasableTiers(): TierDefinition[] {
  return tiers.filter((tier) => tier.monthlyUsd === 0 || isStripeConfigured());
}

/** The product itself, with one offer per purchasable plan from the tier seed. */
export function softwareApplicationJsonLd(): JsonLdNode {
  return {
    "@type": "SoftwareApplication",
    "@id": softwareId(),
    name: SITE_NAME,
    url: absoluteUrl("/"),
    applicationCategory: "BusinessApplication",
    applicationSubCategory: "AI e-commerce image optimization",
    operatingSystem: "Web",
    description: SITE_SUMMARY,
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

/** Wrap several nodes in one graph so they can reference each other by @id. */
export function jsonLdGraph(nodes: JsonLdNode[]): JsonLdNode {
  return { "@context": "https://schema.org", "@graph": nodes };
}
