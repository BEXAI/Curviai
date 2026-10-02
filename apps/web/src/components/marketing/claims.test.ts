import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { creditCosts } from "@curvi/pipeline/seed";
import { QC_THRESHOLDS } from "@curvi/pipeline/qc-thresholds";
import { buildLlmsFullTxt, buildLlmsTxt } from "@/lib/llms";
import {
  freeCredits,
  identityClaims,
  specAvailability,
  typicalPackCredits,
  CREDIT_TERMS_SENTENCE,
  unqualifiedClaims,
} from "@/lib/marketing-facts";
import { SITE_FEATURES, channelPageSeo } from "@/lib/seo";
import { brandKitCopy } from "./brand-kit-copy";
import { categories } from "./categories";
import { channelPageCopy } from "./channel-copy";
import { complianceDemoRows } from "./compliance-badge-demo";
import { aiLabelingHelpArticle, helpArticles, helpClosing, structuredHelpArticles } from "./help-articles";
import {
  homeChannelTiles,
  homeChannels,
  homeClosing,
  homeClosingAlt,
  homeFaqAside,
  homeFaqs,
  homeFeatures,
  homeFeaturesIntro,
  homeGuides,
  homeHero,
  homeHeroCtas,
  homeHeroFeatures,
  homeHeroNote,
  homeHowItWorks,
  homePack,
  homePricing,
  homeProof,
  homeReport,
  homeSteps,
  homeTools,
} from "./home-copy";
import { pillarPageTexts, pillarPages } from "./pillar-copy";
import { signupLead } from "./signup-copy";
import { imageSpecs, specDisplayName } from "./spec-slug";
import { checkerGateCopy, checkerVerdictCopy, fixerGateCopy, resizerGateCopy, toolPackCta } from "./tool-copy";
import { stubKeyOnly, stubOpenCheckout } from "@/lib/billing/test-env";

// CLAUDE.md rule 9: no emojis, no arrows, no dashes as punctuation. Hyphens
// inside words such as "e-commerce" are fine.
const FORBIDDEN_COPY = /[‒-―←-⇿⟵-⟿]|\s-\s|--|\p{Extended_Pictographic}/u;

// Credits never expire while the account is open (P20-05, founder decision
// 10; the seed's old rollover policy is gone). Copy states
// CREDIT_TERMS_SENTENCE and must never bring a cap or a lifetime back.
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
    ...Object.values(homeHeroCtas).map((cta) => ({ where: `home hero call to action ${cta.href}`, text: cta.label })),
    { where: "home hero note", text: homeHeroNote },
    ...homeHeroFeatures.map((feature) => ({ where: `home hero feature ${feature.key}`, text: feature.label })),
    ...(
      [
        ["home proof", homeProof],
        ["home how it works", homeHowItWorks],
        ["home pack", homePack],
        ["home report", homeReport],
        ["home channels", homeChannels],
        ["home pricing", homePricing],
        ["home FAQ aside", homeFaqAside],
        ["home guides", homeGuides],
      ] as const
    ).flatMap(([where, copy]) => Object.entries(copy).map(([key, text]) => ({ where: `${where} ${key}`, text }))),
    ...homeChannelTiles.map((tile) => ({ where: `home channel ${tile.name}`, text: `${tile.name}. ${tile.files}.` })),
    ...homeTools.map((tool) => ({ where: `home tool ${tool.href}`, text: `${tool.name}. ${tool.body}` })),
    { where: "home closing alternative", text: `${homeClosingAlt.before} ${homeClosingAlt.link}${homeClosingAlt.after}` },
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
    expect(help?.body.join(" ")).toContain(CREDIT_TERMS_SENTENCE);
    expect(CREDIT_TERMS_SENTENCE).not.toMatch(CAPPED_ROLLOVER);
  });

  it("never state a credit lifetime or expiry (P20-05)", () => {
    const LIFETIME = /\bexpir|usable for \d+ months|last(?:s)? \d+ months|\d+ months? (?:after|from) (?:purchase|you buy)/i;
    expect(CREDIT_TERMS_SENTENCE).not.toMatch(/expire/i);
    for (const { where, text } of liveCopy()) {
      expect(text, where).not.toMatch(LIFETIME);
    }
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

  it("keeps billing out while only the Stripe key is set (P20-01)", () => {
    stubKeyOnly(vi.stubEnv);
    expect(structuredHelpArticles().map((article) => article.slug)).not.toContain("billing-and-cancellation");
  });

  it("adds the billing article once checkout is open, never coming soon ones", () => {
    stubOpenCheckout(vi.stubEnv);
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
  "./site-header.tsx",
  "./site-footer.tsx",
  "./home-copy.ts",
  "./home-parts.tsx",
  "../ui/liquid-metal-hero.tsx",
  "../ui/liquid-metal-backdrop.tsx",
  "../ui/liquid-metal-canvas.tsx",
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

// P18-09 part 1: every product file is resized for its channel, so no copy
// may say the product, its label or its pixels come out exactly or
// identically as photographed. "Never redrawn" and the measured color check
// are the true claims (docs/marketing.md section 6.5, C-01 and C-02).
const RETIRED_IDENTITY_CLAIMS = [
  "Labels, logos and textures in the output match your photo exactly.",
  "The product is masked first, and the pixels inside the mask are never regenerated, so labels, logos and textures stay identical to the original photo.",
  "Fabric texture and printed graphics stay pixel for pixel identical to your photo.",
  "Feeding guides and safety text remain pixel identical to your upload.",
  "Curvi keeps your product pixels exactly as photographed and generates only the light, shadow and setting around them.",
  "Curvi locks 100% of your original product pixels while compiling asset suites.",
  "AI e-commerce images for Shopify and Amazon from one photo, product pixels untouched.",
  "It ensures that the subject of your original photo remains unchanged.",
  "Curvi preserves your device pixels exactly and swaps only the environment.",
  "Curvi masks the product so its pixels are locked before anything else happens.",
  "Curvi fixes every failing main image from the same photo, with your product pixels untouched.",
];

/**
 * Marketing and public sources whose shipped strings must make no identity
 * claim, read as text because some hold JSX copy no export reaches.
 * marketing-facts.ts holds the patterns themselves.
 */
const IDENTITY_SOURCES = [
  ...OWNED_SOURCES.filter((relative) => !relative.endsWith("marketing-facts.ts")),
  "./pillar-copy.ts",
  "./competitor-facts.ts",
  "../../app/opengraph-image.tsx",
  "../../app/(marketing)/welcome/page.tsx",
  "../../app/(marketing)/s/[slug]/og/route.tsx",
  "../../lib/shares/page-copy.ts",
  "../../lib/api-v1/openapi.ts",
  "../../../../../skills/curvi/SKILL.md",
];

describe("product identity claims", () => {
  it("catch every retired identity sentence", () => {
    for (const sentence of RETIRED_IDENTITY_CLAIMS) {
      expect(identityClaims(sentence), sentence).toEqual([sentence]);
    }
  });

  it("allow the measured wording, kept photos, denials and sizes", () => {
    for (const sentence of [
      "Never redrawn by AI. Curvi cuts out your real product and builds the scene around it, then measures the color inside your product on every file.",
      "Resizing for each channel means most files are not byte for byte copies, and the check measures exactly that.",
      "Every pixel of your photo kept byte for byte.",
      "Your photo file as uploaded, with location and camera details removed.",
      "The background has to be pure white, meaning every background pixel reads exactly 255 255 255.",
      "Measured 99.2 percent of edge pixels at exactly 255 255 255.",
      "An A plus header image is exactly 970 x 600 pixels.",
    ]) {
      expect(identityClaims(sentence), sentence).toEqual([]);
    }
  });

  it("never appear in live copy or in what is on the way", () => {
    const offenders = [
      ...liveCopy(),
      ...homeFeatures.map((feature) => ({ where: `home feature ${feature.key}`, text: feature.body })),
      ...helpArticles.map((article) => ({ where: `help ${article.slug}`, text: article.body.join(" ") })),
      ...pillarPages.flatMap((page) => pillarPageTexts(page).map((text) => ({ where: `guide ${page.path}`, text }))),
    ]
      .map(({ where, text }) => ({ where, claims: identityClaims(text) }))
      .filter((entry) => entry.claims.length > 0);
    expect(offenders).toEqual([]);
  });

  it("never appear in llms.txt or llms-full.txt", () => {
    expect(identityClaims(buildLlmsTxt())).toEqual([]);
    expect(identityClaims(buildLlmsFullTxt())).toEqual([]);
  });

  for (const relative of IDENTITY_SOURCES) {
    it(`${relative} ships no identity claim`, () => {
      const source = withoutComments(readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8"));
      expect(identityClaims(source.replace(/\s+/g, " "))).toEqual([]);
    });
  }

  it("state the fidelity limits from the QC threshold table", () => {
    const answer = helpArticles.find((article) => article.slug === "will-ai-change-my-product")?.body.join(" ") ?? "";
    expect(answer).toContain("never redraws your product");
    expect(answer).toContain(`at most ${QC_THRESHOLDS.main.maxMeanDeltaE} for main images`);
    expect(answer).toContain(`${QC_THRESHOLDS.other.maxMeanDeltaE} for the rest`);
    const tile = homeFeatures.find((feature) => feature.key === "fidelity");
    expect(tile?.body).toMatch(/^Never redrawn by AI\./);
  });
});

// P18-09 part 2: the AI labeling answer waits for the founder's smoke:iptc
// run on a production file (claim C-11), but its words are checked now so
// publishing it is only a list change.
describe("AI labeling answer", () => {
  const text = [aiLabelingHelpArticle.title, ...aiLabelingHelpArticle.body].join(" ");

  it("follows the copy rules and claims nothing that is not live", () => {
    expect(text).not.toMatch(FORBIDDEN_COPY);
    expect(unqualifiedClaims(text)).toEqual([]);
    expect(identityClaims(text)).toEqual([]);
  });

  it("quotes the three values Google Merchant Center lists and never says share pages carry the label", () => {
    for (const value of ["TrainedAlgorithmicMedia", "CompositeSynthetic", "AlgorithmicMedia"]) {
      expect(text).toContain(value);
    }
    expect(text).toContain("share page copies");
    expect(text).not.toMatch(/share pages? (?:carry|keep|show) the (?:tag|label)/i);
  });

  it("stays unpublished until the production check is recorded", () => {
    expect(helpArticles.map((article) => article.slug)).not.toContain(aiLabelingHelpArticle.slug);
  });
});
