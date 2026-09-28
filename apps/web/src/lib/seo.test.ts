import { afterEach, describe, expect, it, vi } from "vitest";
import { tiers } from "@curvi/pipeline/seed";
import robots from "@/app/robots";
import { categories } from "@/components/marketing/categories";
import { imageSpecs, specDisplayName, specSlug } from "@/components/marketing/spec-slug";
import { buildLlmsTxt } from "./llms";
import { comingSoonFileNames, joinList, specAvailability, unqualifiedClaims } from "./marketing-facts";
import {
  DESCRIPTION_MAX,
  OG_IMAGE,
  SITE_DESCRIPTION,
  SITE_FEATURES,
  SITE_SUMMARY,
  SITE_TITLE,
  TITLE_MAX,
  categoryPageSeo,
  channelPageSeo,
  faqPageJsonLd,
  fitDescription,
  pageMetadata,
  renderedTitle,
  serializeJsonLd,
  softwareApplicationJsonLd,
} from "./seo";

// CLAUDE.md rule 9: no emojis, no arrows, no dashes as punctuation. Hyphens
// inside words such as "e-commerce" are fine.
const FORBIDDEN_COPY = /[‒-―←-⇿⟵-⟿]|\s-\s|--|\p{Extended_Pictographic}/u;

describe("site level SEO copy", () => {
  it("targets the AI e-commerce keywords within search result limits", () => {
    expect(SITE_TITLE.length).toBeLessThanOrEqual(TITLE_MAX);
    expect(SITE_TITLE).toContain("AI E-Commerce");
    expect(SITE_TITLE).toContain("Shopify");
    expect(SITE_TITLE).toContain("Amazon");
    expect(SITE_DESCRIPTION.length).toBeLessThanOrEqual(DESCRIPTION_MAX);
    expect(SITE_DESCRIPTION.toLowerCase()).toContain("ai e-commerce image optimization");
  });

  it("follows the copy rules", () => {
    for (const text of [SITE_TITLE, SITE_DESCRIPTION, SITE_SUMMARY, ...SITE_FEATURES]) {
      expect(text).not.toMatch(FORBIDDEN_COPY);
    }
  });
});

describe("pageMetadata", () => {
  it("sets a canonical URL and a page specific social card", () => {
    const meta = pageMetadata({ title: "Pricing", description: "Plans.", path: "/pricing" });
    expect(meta.title).toBe("Pricing");
    expect(meta.alternates?.canonical).toBe("/pricing");
    expect(meta.openGraph).toMatchObject({ url: "/pricing", title: "Pricing | Curvi", description: "Plans." });
    expect(meta.twitter).toMatchObject({ card: "summary_large_image", title: "Pricing | Curvi" });
    expect(meta.openGraph?.images).toEqual([OG_IMAGE]);
    expect(meta.twitter?.images).toEqual([OG_IMAGE.url]);
    expect(meta.robots).toBeUndefined();
  });

  it("keeps absolute titles free of the brand template", () => {
    const meta = pageMetadata({ title: SITE_TITLE, absoluteTitle: true, description: "x", path: "/" });
    expect(meta.title).toEqual({ absolute: SITE_TITLE });
    expect(meta.openGraph).toMatchObject({ title: SITE_TITLE });
  });

  it("marks pages noindex on request", () => {
    const meta = pageMetadata({ title: "Reset", description: "x", path: "/reset-password", noIndex: true });
    expect(meta.robots).toEqual({ index: false, follow: true });
  });
});

describe("programmatic SEO pages", () => {
  it("fits every channel page title and description", () => {
    for (const spec of imageSpecs()) {
      for (const status of ["live", "coming_soon"] as const) {
        const seo = channelPageSeo(specDisplayName(spec.id), status);
        expect(renderedTitle(seo.title).length, seo.title).toBeLessThanOrEqual(TITLE_MAX);
        expect(seo.description.length, seo.description).toBeLessThanOrEqual(DESCRIPTION_MAX);
        expect(seo.description).toMatch(/[.!?]$/);
        expect(seo.description).not.toMatch(FORBIDDEN_COPY);
      }
    }
  });

  it("promises channel files in snippets only for specs a pack makes", () => {
    for (const spec of imageSpecs()) {
      const status = specAvailability(spec.id);
      const seo = channelPageSeo(specDisplayName(spec.id), status);
      expect(seo.description).not.toMatch(/passes them the first time/);
      expect(unqualifiedClaims(seo.description), spec.id).toEqual([]);
      if (status === "live") {
        expect(seo.description, spec.id).toContain("how Curvi builds and measures files");
      } else {
        expect(seo.description, spec.id).toMatch(/coming soon/);
      }
    }
    expect(channelPageSeo("Walmart main image", "coming_soon").description).toContain("coming soon");
    expect(channelPageSeo("Walmart main image", "live").description).not.toContain("coming soon");
  });

  it("fits every category page title and description", () => {
    for (const category of categories) {
      const seo = categoryPageSeo(category.name);
      expect(renderedTitle(seo.title).length, seo.title).toBeLessThanOrEqual(TITLE_MAX);
      expect(seo.title).toContain("Shopify and Amazon");
      expect(seo.description.length, seo.description).toBeLessThanOrEqual(DESCRIPTION_MAX);
      expect(seo.description).toMatch(/[.!?]$/);
      expect(seo.description).not.toMatch(FORBIDDEN_COPY);
    }
  });
});

describe("fitDescription", () => {
  it("returns short text unchanged", () => {
    expect(fitDescription("One sentence.")).toBe("One sentence.");
  });

  it("drops whole sentences that would pass the limit", () => {
    expect(fitDescription("First part here. Second part is much longer than the limit allows.", 30)).toBe(
      "First part here.",
    );
  });

  it("cuts on a word boundary when the first sentence is too long", () => {
    const result = fitDescription("alpha beta gamma delta epsilon", 20);
    expect(result.length).toBeLessThanOrEqual(20);
    expect(result).toBe("alpha beta gamma.");
  });
});

describe("JSON-LD", () => {
  it("escapes script closing sequences", () => {
    const html = serializeJsonLd({ name: "</script><script>alert(1)</script>" });
    expect(html).not.toContain("<");
    expect(JSON.parse(html)).toEqual({ name: "</script><script>alert(1)</script>" });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("offers only the free plan while checkout cannot take payment", () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "");
    const app = softwareApplicationJsonLd() as { offers: { price: number }[] };
    expect(app.offers.map((offer) => offer.price)).toEqual([0]);
  });

  it("prices every offer from the tier seed once Stripe is configured", () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_placeholder");
    const app = softwareApplicationJsonLd() as { offers: { price: number }[] };
    expect(app.offers.map((offer) => offer.price)).toEqual(tiers.map((tier) => tier.monthlyUsd));
  });

  it("builds FAQ questions and answers", () => {
    expect(faqPageJsonLd([{ question: "Q?", answer: "A." }])).toEqual({
      "@type": "FAQPage",
      mainEntity: [{ "@type": "Question", name: "Q?", acceptedAnswer: { "@type": "Answer", text: "A." } }],
    });
  });
});

describe("llms.txt", () => {
  const text = buildLlmsTxt();

  it("follows the llms.txt shape", () => {
    expect(text.startsWith("# Curvi\n\n> ")).toBe(true);
    const [body = "", ...sections] = text.split(/^## /m);
    expect(body).toContain("Pricing:");
    expect(sections.length).toBeGreaterThan(0);
    // Every H2 section is a file list: each item links with [name](url).
    for (const section of sections) {
      const items = section.split("\n").filter((line) => line.startsWith("- "));
      expect(items.length).toBeGreaterThan(0);
      for (const item of items) {
        expect(item).toMatch(/^- \[[^\]]+\]\(https?:\/\/[^)]+\)/);
      }
    }
  });

  it("lists seed prices and every channel requirements page", () => {
    for (const tier of tiers.filter((t) => t.monthlyUsd > 0)) {
      expect(text).toContain(`$${tier.monthlyUsd} per month`);
    }
    for (const spec of imageSpecs()) {
      expect(text).toContain(`${specDisplayName(spec.id)} requirements`);
    }
  });

  it("marks requirement pages for files Curvi does not make yet", () => {
    for (const spec of imageSpecs()) {
      const line = text.split("\n").find((entry) => entry.includes(`/channels/${specSlug(spec.id)}/image-requirements`));
      expect(line, spec.id).toBeDefined();
      if (specAvailability(spec.id) === "live") {
        expect(line, spec.id).not.toContain("coming soon");
      } else {
        expect(line, spec.id).toContain("Curvi files for it are coming soon");
      }
    }
  });

  it("lists coming soon files only when some are on the way", () => {
    const soon = comingSoonFileNames();
    if (soon.length > 0) {
      expect(text).toContain(`- ${joinList(soon)}`);
    }
    expect(text).not.toMatch(/^- Files for\s*$/m);
  });

  it("follows the copy rules outside markdown list markers", () => {
    for (const line of text.split("\n")) {
      expect(line.replace(/^- /, "")).not.toMatch(FORBIDDEN_COPY);
    }
  });
});

describe("robots", () => {
  it("keeps the app and API out of every crawler group", () => {
    const rules = robots().rules;
    const groups = Array.isArray(rules) ? rules : [rules];
    expect(groups.length).toBeGreaterThan(1);
    for (const group of groups) {
      expect(group.disallow).toEqual(["/app/", "/api/"]);
    }
    const named = groups.flatMap((group) => (Array.isArray(group.userAgent) ? group.userAgent : []));
    expect(named).toEqual(expect.arrayContaining(["GPTBot", "ClaudeBot", "PerplexityBot", "Google-Extended"]));
  });
});
