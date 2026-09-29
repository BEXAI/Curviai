import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { creditCosts } from "@curvi/pipeline/seed";
import { buildLlmsTxt } from "@/lib/llms";
import {
  freeCredits,
  specAvailability,
  typicalPackCredits,
  unqualifiedClaims,
  UNUSED_CREDITS_SENTENCE,
} from "@/lib/marketing-facts";
import { SITE_FEATURES, channelPageSeo } from "@/lib/seo";
import { brandKitCopy } from "./brand-kit-copy";
import { categories } from "./categories";
import { channelPageCopy } from "./channel-copy";
import { complianceDemoRows } from "./compliance-badge-demo";
import { helpArticles, helpClosing, structuredHelpArticles } from "./help-articles";
import {
  homeClosing,
  homeFaqs,
  homeFeatures,
  homeFeaturesIntro,
  homeHero,
  homeSteps,
} from "./home-copy";
import { pillarPageTexts, pillarPages } from "./pillar-copy";
import { signupLead } from "./signup-copy";
import { imageSpecs, specDisplayName } from "./spec-slug";
import { checkerGateCopy, checkerVerdictCopy, fixerGateCopy, resizerGateCopy, toolPackCta } from "./tool-copy";

// CLAUDE.md rule 9: no emojis, no arrows, no dashes as punctuation. Hyphens
// inside words such as "e-commerce" are fine.
const FORBIDDEN_COPY = /[‒-―←-⇿⟵-⟿]|\s-\s|--|\p{Extended_Pictographic}/u;

// The seed's rollover policy (one cycle, up to one month of allowance) is not
// enforced: subscription credits never expire today. Copy states
// UNUSED_CREDITS_SENTENCE instead and must never bring the cap back.
const CAPPED_ROLLOVER =
  /carr(?:y|ies|ied) over|roll(?:s|ed)? ?over|up to (?:one|a|\d+) months? of (?:your|the) allowance|capped at (?:one|a|\d+) months?/i;

function whatCurviDoes(): string[] {
  const text = buildLlmsTxt();
  const start = text.indexOf("What Curvi does:");
  const end = text.indexOf("Coming soon, not available on any plan yet:");
  return text
    .slice(start, end)
    .split("\n")
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2));
}

/** Every piece of copy that presents something as available today. */
function liveCopy(): { where: string; text: string }[] {
  return [
    ...Object.entries(homeHero).map(([key, text]) => ({ where: `home hero ${key}`, text })),
    ...homeSteps.map((step) => ({ where: `home step ${step.title}`, text: `${step.title}. ${step.body}` })),
    ...homeFeatures
      .filter((feature) => feature.status === "live")
      .map((feature) => ({ where: `home feature ${feature.key}`, text: `${feature.title}. ${feature.body}` })),
    { where: "home features intro", text: homeFeaturesIntro },
    ...homeFaqs.map((faq) => ({ where: `home FAQ ${faq.q}`, text: `${faq.q} ${faq.a}` })),
    { where: "home closing", text: `${homeClosing.title}. ${homeClosing.body}` },
    ...helpArticles
      .filter((article) => article.status !== "coming_soon")
      .map((article) => ({ where: `help ${article.slug}`, text: [article.title, ...article.body].join(" ") })),
    { where: "help closing", text: helpClosing },
    ...categories.flatMap((category) =>
      [category.headline, category.intro, category.proofLine, ...category.painPoints, ...category.packContents].map(
        (text) => ({ where: `category ${category.slug}`, text }),
      ),
    ),
    ...SITE_FEATURES.map((text) => ({ where: "SITE_FEATURES", text })),
    ...whatCurviDoes().map((text) => ({ where: "llms.txt what Curvi does", text })),
    ...complianceDemoRows().map((row) => ({
      where: `compliance demo ${row.rule}`,
      text: `${row.rule}. ${row.requirement}. ${row.measured}.`,
    })),
    { where: "free tool pack call to action", text: `${toolPackCta.title} ${toolPackCta.body}` },
    { where: "main image checker, image passes", text: checkerVerdictCopy.pass },
    { where: "main image checker, image fails", text: checkerVerdictCopy.fail },
    ...[checkerGateCopy, fixerGateCopy, resizerGateCopy].map((gate) => ({
      where: `free tool email gate ${gate.title}`,
      text: `${gate.title}. ${gate.body}`,
    })),
    { where: "signup lead", text: signupLead() },
    ...pillarPages.flatMap((page) => pillarPageTexts(page, { curviOnly: true }).map((text) => ({ where: `guide ${page.path}`, text }))),
    ...Object.entries(brandKitCopy).map(([key, text]) => ({ where: `brand kit ${key}`, text })),
    ...imageSpecs().flatMap((spec) => {
      const copy = channelPageCopy(spec);
      const seo = channelPageSeo(specDisplayName(spec.id), specAvailability(spec.id));
      return [
        { where: `channel page ${spec.id} intro`, text: copy.intro },
        { where: `channel page ${spec.id} call to action`, text: `${copy.ctaTitle}. ${copy.ctaBody}` },
        { where: `channel page ${spec.id} search snippet`, text: seo.description },
      ];
    }),
  ];
}

describe("marketing claims", () => {
  it("never present a feature or channel that is not live as available", () => {
    const offenders = liveCopy()
      .map(({ where, text }) => ({ where, claims: unqualifiedClaims(text) }))
      .filter((entry) => entry.claims.length > 0);
    expect(offenders).toEqual([]);
  });

  it("label every feature on the way as coming soon", () => {
    for (const feature of homeFeatures.filter((f) => f.status === "coming_soon")) {
      expect(unqualifiedClaims(`${feature.title}. ${feature.body}`).length, feature.key).toBeGreaterThan(0);
    }
    for (const article of helpArticles.filter((a) => a.status === "coming_soon")) {
      expect(article.body.join(" ")).toMatch(/coming soon/i);
    }
  });

  it("keep category pack items that do not run under Coming soon", () => {
    for (const category of categories) {
      expect(category.packContents.length, category.slug).toBeGreaterThan(0);
      for (const item of category.comingSoon) {
        // Each item names something that is not live yet. Once it ships, the
        // flag flips and this fails, so the item moves into packContents.
        expect(unqualifiedClaims(item).length, `${category.slug}: ${item}`).toBeGreaterThan(0);
      }
    }
  });

  it("follow the copy rules", () => {
    const all = [
      ...liveCopy().map((entry) => entry.text),
      ...homeFeatures.map((feature) => feature.body),
      ...helpArticles.flatMap((article) => article.body),
      ...categories.flatMap((category) => category.comingSoon),
    ];
    for (const text of all) {
      expect(text).not.toMatch(FORBIDDEN_COPY);
    }
  });
});

describe("unused credits", () => {
  it("never promise the capped rollover that nothing enforces", () => {
    for (const { where, text } of liveCopy()) {
      expect(text, where).not.toMatch(CAPPED_ROLLOVER);
    }
  });

  it("say what happens to unused credits with the one shared sentence", () => {
    const help = helpArticles.find((article) => article.slug === "how-credits-work");
    expect(help?.body.join(" ")).toContain(UNUSED_CREDITS_SENTENCE);
    expect(UNUSED_CREDITS_SENTENCE).not.toMatch(CAPPED_ROLLOVER);
  });

  it("recognize the retired capped wording", () => {
    for (const retired of [
      "Unused subscription credits carry over to the next billing cycle, up to one month of your allowance.",
      "Unused credits roll over one cycle, capped at one month.",
      "Credits rollover, up to 2 months of your allowance.",
    ]) {
      expect(retired).toMatch(CAPPED_ROLLOVER);
    }
  });
});

describe("numbers in copy", () => {
  it("state the typical pack size and free credits from the seeds", () => {
    const credits = homeFaqs.find((faq) => faq.q === "How do credits work?");
    expect(credits?.a).toContain(`about ${typicalPackCredits()} credits`);
    expect(credits?.a).toContain(`${creditCosts.deterministic} credit`);
    const card = homeFaqs.find((faq) => faq.q === "Can I try it without a card?");
    expect(card?.a).toContain(`${freeCredits()} credits once`);
    expect(homeClosing.body).toContain(`${freeCredits()} credits`);
    expect(helpClosing).toContain(`${freeCredits()} credits`);
    const help = helpArticles.find((article) => article.slug === "how-credits-work");
    expect(help?.body.join(" ")).toContain(`about ${typicalPackCredits()} credits`);
    expect(signupLead()).toContain(`${freeCredits()} credits`);
  });

  it("never repeat the old pack size, share page or annual discount claims", () => {
    for (const { where, text } of liveCopy()) {
      expect(text, where).not.toMatch(/40 to 60/);
      expect(text, where).not.toMatch(/20 percent/);
    }
  });
});

describe("FAQPage JSON-LD", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("leaves out coming soon articles and billing while paid plans cannot be bought", () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "");
    const slugs = structuredHelpArticles().map((article) => article.slug);
    expect(slugs).not.toContain("billing-and-cancellation");
    expect(slugs).not.toContain("what-is-the-fresh-creative-drop");
    expect(slugs).toEqual(
      helpArticles.filter((article) => article.structured === "always").map((article) => article.slug),
    );
  });

  it("adds the billing article once Stripe is configured, never coming soon ones", () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_placeholder");
    const slugs = structuredHelpArticles().map((article) => article.slug);
    expect(slugs).toContain("billing-and-cancellation");
    for (const article of helpArticles.filter((a) => a.status === "coming_soon")) {
      expect(slugs).not.toContain(article.slug);
      expect(article.structured).toBe("never");
    }
  });
});

// Files this package owns. Numbers in them must come from the seeds or the
// spec registry, and the retired false claims must not come back.
const OWNED_SOURCES = [
  "../../app/(marketing)/page.tsx",
  "../../app/(marketing)/help/page.tsx",
  "../../app/(marketing)/gallery/page.tsx",
  "../../app/(marketing)/for/[category]/page.tsx",
  "../../app/(marketing)/s/[slug]/page.tsx",
  "../../app/(marketing)/signup/page.tsx",
  "../../app/(marketing)/channels/[channel]/image-requirements/page.tsx",
  "../../app/(marketing)/tools/main-image-checker/page.tsx",
  "../../app/app/page.tsx",
  "../../app/app/brand/page.tsx",
  "../app/brand-kit-form.tsx",
  "./categories.ts",
  "./compliance-badge-demo.tsx",
  "./before-after-slider.tsx",
  "./demo-images.ts",
  "./upload-box.tsx",
  "./site-header.tsx",
  "./site-footer.tsx",
  "./home-copy.ts",
  "./help-articles.ts",
  "./coming-soon-badge.tsx",
  "./channel-copy.ts",
  "./signup-copy.ts",
  "./brand-kit-copy.ts",
  "./tool-copy.ts",
  "./tool-page-shell.tsx",
  "./main-image-checker.tsx",
  "./header-actions.tsx",
  "../../lib/llms.ts",
  "../../lib/marketing-facts.ts",
  "../../lib/seo.ts",
  // Pricing and billing (package P2): prices, savings, pack sizes and feature
  // availability come from the seeds and marketing-facts too.
  "../../app/(marketing)/pricing/page.tsx",
  "./pricing-tiers.tsx",
  "../../app/app/billing/page.tsx",
  "../app/billing-actions.tsx",
  "../../lib/billing/plan-features.ts",
];

const LITERALS: { name: string; pattern: RegExp }[] = [
  { name: "credit amount", pattern: /\b\d+(\.\d+)?\s+credits?\b/i },
  { name: "dollar amount", pattern: /\$\d/ },
  { name: "percent", pattern: /\b\d+(\.\d+)?\s+percent\b/i },
  // Tailwind classes such as "text-ink-200 px-3" are not pixel sizes.
  { name: "pixel size", pattern: /(?<![\w-])\d{3,5}\s?px\b/ },
  { name: "month count", pattern: /\b\d+\s+months?\b/i },
];

const RETIRED_CLAIMS: RegExp[] = [
  /Curvi output/,
  /product URL/i,
  /40 to 60/,
  /Publish straight/i,
  /text policy/i,
  /two minutes/i,
  /see your pack/i,
];

/** Code comments may describe layout or examples; only shipped strings count. */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
}

describe("owned marketing sources", () => {
  for (const relative of OWNED_SOURCES) {
    it(`${relative} has no hardcoded seed numbers or retired claims`, () => {
      const source = withoutComments(readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8"));
      for (const literal of LITERALS) {
        expect(source.match(literal.pattern)?.[0], `${literal.name} literal`).toBeUndefined();
      }
      expect(source.match(CAPPED_ROLLOVER)?.[0], "capped rollover wording").toBeUndefined();
      // marketing-facts.ts holds the patterns that detect these claims.
      if (!relative.endsWith("marketing-facts.ts")) {
        for (const claim of RETIRED_CLAIMS) {
          expect(source.match(claim)?.[0]).toBeUndefined();
        }
      }
    });
  }
});
