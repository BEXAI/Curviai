import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { freeCredits, isSpecLive, typicalPackCredits, unqualifiedClaims } from "@/lib/marketing-facts";
import { brandKitCopy } from "./brand-kit-copy";
import { categories } from "./categories";
import { afterDemoImage, beforeDemoImage, galleryCases, isIllustrationSrc } from "./demo-images";
import { homeFaqs, homeFeatures } from "./home-copy";
import { imageSpecs, specSlug } from "./spec-slug";
import { checkerVerdictCopy, toolPackCta } from "./tool-copy";
import { stubOpenCheckout } from "@/lib/billing/test-env";

// The web tsconfig keeps JSX as is for Next.js, so Vitest compiles it to
// React.createElement calls. Components only call it while rendering, so a
// global React set before the first render is enough.
beforeAll(() => {
  (globalThis as { React?: typeof React }).React = React;
});

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));

const dashboard = vi.hoisted(() => ({
  workspace: { id: "ws_1", name: "Test shop", plan: "starter", creditBalance: 15, role: "owner" } as {
    id: string;
    name: string;
    plan: string;
    creditBalance: number;
    role: string;
  } | null,
}));

vi.mock("@/lib/services", () => ({
  getServices: () => ({
    ensureWorkspace: async () => dashboard.workspace,
    listProducts: async () => [],
    listRecentJobs: async () => [],
    getBrandKit: async () => ({
      name: "Test kit",
      colors: ["#1D2433"],
      fonts: { heading: "playfair_display", body: "" },
      stylePreset: "auto",
      hasLogo: false,
    }),
    listJobFiles: async () => null,
    getJob: async () => null,
  }),
  isDbMode: () => false,
}));

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children?: React.ReactNode }) =>
    React.createElement("a", { href, ...rest }, children),
}));

function render(element: React.ReactElement): string {
  return renderToStaticMarkup(element);
}

/**
 * Visible text of the element carrying a data-testid, with block ends read
 * as sentence ends so unqualifiedClaims sees headings and buttons apart.
 */
function testIdText(html: string, testId: string): string {
  const at = html.indexOf(`data-testid="${testId}"`);
  if (at < 0) {
    return "";
  }
  const open = html.lastIndexOf("<", at);
  const tag = /^<(\w+)/.exec(html.slice(open))?.[1] ?? "div";
  const tags = new RegExp(`<(/?)${tag}\\b[^>]*>`, "g");
  tags.lastIndex = open;
  let depth = 0;
  for (let match = tags.exec(html); match; match = tags.exec(html)) {
    depth += match[1] ? -1 : 1;
    if (depth === 0) {
      return html
        .slice(open, match.index + match[0].length)
        .replace(/<\/(h\d|p|a|li|button)>/g, ". ")
        .replace(/<[^>]+>/g, " ")
        .replace(/&#x27;/g, "'")
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, "&")
        .replace(/\s+/g, " ")
        .trim();
    }
  }
  return "";
}

/** JSON-LD FAQ questions in rendered markup. */
function faqQuestions(html: string): string[] {
  const scripts = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
  return scripts.flatMap((match) => {
    const data = JSON.parse(match[1] ?? "{}") as { "@graph"?: { "@type": string; mainEntity?: { name: string }[] }[] };
    return (data["@graph"] ?? [])
      .filter((node) => node["@type"] === "FAQPage")
      .flatMap((node) => (node.mainEntity ?? []).map((question) => question.name));
  });
}

describe("demo imagery", () => {
  it("is drawn in code, so it counts as an illustration", () => {
    expect(isIllustrationSrc(beforeDemoImage)).toBe(true);
    expect(isIllustrationSrc(afterDemoImage)).toBe(true);
    for (const item of galleryCases) {
      expect(isIllustrationSrc(item.before) && isIllustrationSrc(item.after), item.slug).toBe(true);
    }
    expect(isIllustrationSrc("https://cdn.example.com/sample.jpg")).toBe(false);
  });

  it("carries an Illustration label in the slider", async () => {
    const { BeforeAfterSlider } = await import("./before-after-slider");
    const html = render(React.createElement(BeforeAfterSlider, { beforeSrc: beforeDemoImage, afterSrc: afterDemoImage }));
    expect(html).toContain('data-testid="illustration-label"');
    expect(html).toContain('alt="Illustration, before"');
    expect(html).toContain('alt="Illustration, after"');
    expect(html).not.toContain("Curvi output");
  });

  it("drops the label for real photos", async () => {
    const { BeforeAfterSlider } = await import("./before-after-slider");
    const html = render(
      React.createElement(BeforeAfterSlider, {
        beforeSrc: "https://cdn.example.com/before.jpg",
        afterSrc: "https://cdn.example.com/after.jpg",
      }),
    );
    expect(html).not.toContain("illustration-label");
    expect(html).toContain('alt="Before"');
  });
});

describe("compliance badge demo", () => {
  it("is labeled an example and lists only checks QC measures today", async () => {
    const { ComplianceBadgeDemo } = await import("./compliance-badge-demo");
    const html = render(React.createElement(ComplianceBadgeDemo));
    expect(html).toContain("Example report");
    expect(html).not.toMatch(/Text and props|None detected/);
    expect(html).toContain("Background");
    expect(html).toContain("Product fill");
    expect(html).toContain("Resolution");
  });

  it("shows example measurements that pass the amazon.main spec", async () => {
    const { complianceDemoRows } = await import("./compliance-badge-demo");
    const { amazonMainRules } = await import("@/lib/marketing-facts");
    const rules = amazonMainRules();
    const fill = complianceDemoRows().find((row) => row.rule === "Product fill");
    const measured = Number(fill?.measured.split(" ")[0]);
    expect(measured).toBeGreaterThanOrEqual(rules.fillMinPercent);
    expect(measured).toBeLessThanOrEqual(rules.fillMaxPercent);
    expect(Math.max(rules.width, rules.height)).toBeGreaterThanOrEqual(rules.minLongSide);
  });
});

describe("coming soon badge", () => {
  it("renders the shared label", async () => {
    const { ComingSoonBadge } = await import("./coming-soon-badge");
    expect(render(React.createElement(ComingSoonBadge))).toContain("Coming soon");
  });
});

describe("home pack tiles", () => {
  it("title each file by name and show the count as a chip", async () => {
    const { PackTile } = await import("./home-parts");
    const html = render(React.createElement(PackTile, { line: { label: "Background sweeps, 2", credits: 1 } }));
    expect(html).toMatch(/<h3[^>]*>Background sweeps<\/h3>/);
    expect(html).toContain(">2 files<");
    expect(html).toContain("1 credit");
    expect(html).toContain('data-status="live"');
    expect(html).not.toContain('data-testid="coming-soon"');
  });

  it("give a file that is not delivered yet the Coming soon label instead of credits", async () => {
    const { PackTile } = await import("./home-parts");
    const html = render(
      React.createElement(PackTile, { line: { label: "Infographic, coming soon", credits: 0, comingSoon: true } }),
    );
    expect(html).toMatch(/<h3[^>]*>Infographic<\/h3>/);
    expect(html).toContain('data-testid="coming-soon"');
    expect(html).toContain('data-status="coming_soon"');
    expect(html).toContain("border-dashed");
    expect(html).not.toMatch(/\b0 credits?\b/);
  });

  it("render every line of the typical pack as live or coming soon", async () => {
    const { typicalPackLines } = await import("@/lib/marketing-facts");
    const { PackTile } = await import("./home-parts");
    for (const line of typicalPackLines()) {
      const html = render(React.createElement(PackTile, { line }));
      const labelled = html.includes('data-testid="coming-soon"');
      expect(labelled, line.label).toBe(line.comingSoon === true);
      expect(html, line.label).not.toContain(", coming soon");
    }
  });
});

describe("pages", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("home labels features on the way and states seed numbers", async () => {
    const { default: HomePage } = await import("@/app/(marketing)/page");
    const html = render(React.createElement(HomePage));
    const soon = homeFeatures.filter((feature) => feature.status === "coming_soon").length;
    expect(html.match(/data-testid="coming-soon"/g)?.length).toBe(soon);
    expect(html).toContain(`about ${typicalPackCredits()} credits`);
    expect(html).toContain(`${freeCredits()} credits`);
    // The home slider shows a real Curvi result, so it carries no Illustration label.
    expect(html).toContain('src="/home/before-car.jpg"');
    expect(html).not.toContain('data-testid="illustration-label"');
    expect(html).not.toContain("Curvi output");
    expect(html).not.toContain("40 to 60");
    expect(faqQuestions(html)).toEqual(homeFaqs.map((faq) => faq.q));
  });

  it("home tells visitors paid plans are not open while Stripe is not set up", async () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "");
    const { default: HomePage } = await import("@/app/(marketing)/page");
    expect(render(React.createElement(HomePage))).toContain("Paid plans open soon");
    stubOpenCheckout(vi.stubEnv);
    expect(render(React.createElement(HomePage))).not.toContain("Paid plans open soon");
  });

  it("help indexes published articles and omits coming-soon and gated billing articles", async () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "");
    const { default: HelpPage } = await import("@/app/(marketing)/help/page");
    const html = render(React.createElement(HelpPage));
    expect(html).not.toContain("What is the Fresh Creative Drop?");
    expect(html).not.toContain("How do billing and cancellation work?");
    expect(html).toContain('href="/help/how-credits-work"');
    // Full article answers live on their individual Article pages.
    expect(faqQuestions(html)).toEqual([]);
  });

  it("gallery labels every case as an illustration", async () => {
    const { default: GalleryPage } = await import("@/app/(marketing)/gallery/page");
    const html = render(await GalleryPage());
    // No customer has opted in here, so only the drawn cases show.
    expect(html).not.toContain('data-testid="customer-makeovers"');
    expect(html.match(/data-testid="illustration-label"/g)?.length).toBe(galleryCases.length);
    expect(html).not.toContain(">Demo<");
    expect(html).not.toContain("Curvi output");
  });

  it("category pages show coming soon pack items and seed free credits", async () => {
    const { default: CategoryPage } = await import("@/app/(marketing)/for/[category]/page");
    for (const category of categories) {
      const element = await CategoryPage({ params: Promise.resolve({ category: category.slug }) });
      const html = render(element);
      expect(html.match(/data-testid="coming-soon"/g)?.length ?? 0, category.slug).toBe(category.comingSoon.length);
      expect(html).toContain(`${freeCredits()} credits`);
      expect(html).toContain('data-testid="illustration-label"');
      expect(html).not.toContain("share page");
    }
  });

  it("dashboard first session promises only what the form does (Update 6.12)", async () => {
    const { default: DashboardPage } = await import("@/app/app/page");
    const html = render(await DashboardPage());
    expect(html).toContain('data-testid="first-session"');
    expect(html).toContain("Upload one product photo.");
    expect(html).not.toMatch(/URL/);
    expect(html).not.toContain("40 to 60");
    expect(html).toContain(`about ${typicalPackCredits()} credits`);
    expect(html).toContain("On the Starter plan");
  });

  it("dashboard sign in state states the free grant from the seed", async () => {
    const saved = dashboard.workspace;
    dashboard.workspace = null;
    try {
      const { default: DashboardPage } = await import("@/app/app/page");
      const html = render(await DashboardPage());
      expect(html).toContain(`${freeCredits()} free credits`);
    } finally {
      dashboard.workspace = saved;
    }
  });

  it("the example share page labels its drawings as an illustration", async () => {
    const { default: SharePage } = await import("@/app/(marketing)/s/[slug]/page");
    const html = render(await SharePage({ params: Promise.resolve({ slug: "example" }) }));
    expect(html).toContain('data-testid="illustration-label"');
    expect(html).toContain("not a real Curvi result");
    expect(html).not.toContain("Coming soon");
    expect(html).not.toContain("Makeover reference");
  });

  it("an unknown share slug is not found and stays out of the index", async () => {
    const { default: SharePage, generateMetadata } = await import("@/app/(marketing)/s/[slug]/page");
    await expect(SharePage({ params: Promise.resolve({ slug: "abcdefghjk" }) })).rejects.toThrow();
    const metadata = await generateMetadata({ params: Promise.resolve({ slug: "abcdefghjk" }) });
    expect(metadata.robots).toMatchObject({ index: false });
  });
});

describe("channel requirement pages", () => {
  it("sell files only for specs a pack makes and label the rest coming soon", async () => {
    const page = await import("@/app/(marketing)/channels/[channel]/image-requirements/page");
    for (const spec of imageSpecs()) {
      const params = () => Promise.resolve({ channel: specSlug(spec.id) });
      const html = render(await page.default({ params: params() }));
      const intro = testIdText(html, "channel-intro");
      const cta = testIdText(html, "channel-cta");
      const description = String((await page.generateMetadata({ params: params() })).description);
      expect(intro.length, spec.id).toBeGreaterThan(0);
      expect(cta.length, spec.id).toBeGreaterThan(0);
      expect(unqualifiedClaims(intro), `${spec.id} intro`).toEqual([]);
      expect(unqualifiedClaims(cta), `${spec.id} call to action`).toEqual([]);
      expect(unqualifiedClaims(description), `${spec.id} search snippet`).toEqual([]);
      if (isSpecLive(spec.id)) {
        expect(html, spec.id).not.toContain('data-testid="coming-soon"');
        expect(intro, spec.id).toContain("Curvi builds");
        expect(description, spec.id).not.toMatch(/coming soon/i);
      } else {
        expect(html, spec.id).toContain('data-testid="coming-soon"');
        expect(intro, spec.id).toMatch(/coming soon/i);
        expect(cta, spec.id).toMatch(/coming soon/i);
        expect(html, spec.id).not.toContain("Curvi builds");
        expect(description, spec.id).toMatch(/coming soon/i);
      }
      expect(html, spec.id).not.toMatch(/passes them the first time|meets every rule/);
    }
  });

  it("show an exact size only for specs that accept one size", async () => {
    const page = await import("@/app/(marketing)/channels/[channel]/image-requirements/page");
    const pin = render(await page.default({ params: Promise.resolve({ channel: "pinterest-pin" }) }));
    expect(pin).toContain("Exact size");
    expect(pin).not.toContain("Recommended size");
    const main = render(await page.default({ params: Promise.resolve({ channel: "amazon-main" }) }));
    expect(main).toContain("Recommended size");
    expect(main).not.toContain("Exact size");
  });

  it("keep brand names capitalized in the explanation", async () => {
    const page = await import("@/app/(marketing)/channels/[channel]/image-requirements/page");
    const html = render(await page.default({ params: Promise.resolve({ channel: "ebay-listing" }) }));
    expect(html).toContain("eBay listing image");
    expect(html).not.toMatch(/\bebay listing image/);
  });
});

describe("free tool pages", () => {
  it("sell only what a pack makes today in the shared call to action", async () => {
    const { ToolPageShell } = await import("./tool-page-shell");
    const html = render(
      React.createElement(ToolPageShell, {
        currentPath: "/tools/main-image-checker",
        title: "Tool",
        description: "About.",
        children: null,
      }),
    );
    const cta = testIdText(html, "tool-pack-cta");
    expect(cta).toContain(toolPackCta.body);
    expect(cta).not.toMatch(/video/i);
    expect(unqualifiedClaims(cta)).toEqual([]);
  });

  it("keep the checker verdicts free of video claims", () => {
    for (const text of Object.values(checkerVerdictCopy)) {
      expect(text).not.toMatch(/video/i);
      expect(unqualifiedClaims(text)).toEqual([]);
    }
  });

  it("state the checker thresholds from the amazon.main spec", async () => {
    const { default: CheckerPage, metadata } = await import("@/app/(marketing)/tools/main-image-checker/page");
    const { amazonMainRules } = await import("@/lib/marketing-facts");
    const rules = amazonMainRules();
    const html = render(await CheckerPage({ searchParams: Promise.resolve({}) }));
    // Both ends of the fill rule (Update.md 6.10).
    expect(html).toContain(`${rules.fillMinPercent} to ${rules.fillMaxPercent} percent`);
    expect(html).toContain(`at least ${rules.minLongSide} px`);
    expect(String(metadata.description)).toContain(
      `${rules.fillMinPercent} to ${rules.fillMaxPercent} percent fill`,
    );
  });
});

describe("signup page", () => {
  it("states the seed free grant and promises no share page", async () => {
    const { default: SignupPage } = await import("@/app/(marketing)/signup/page");
    const html = render(await SignupPage());
    const lead = testIdText(html, "signup-lead");
    expect(lead).toContain(`Start free with ${freeCredits()} credits`);
    expect(lead).not.toMatch(/share page/i);
    expect(unqualifiedClaims(lead)).toEqual([]);
  });
});

describe("brand kit page", () => {
  it("says which parts of the kit packs use", async () => {
    const { default: BrandPage } = await import("@/app/app/brand/page");
    const html = render(await BrandPage());
    const intro = testIdText(html, "brand-kit-intro");
    expect(intro).toContain(brandKitCopy.intro);
    expect(intro).toMatch(/brand color/);
    expect(html).not.toContain("keep every pack consistent");
    expect(html).not.toContain("Sets the default look");
    expect(html).not.toContain("Save the kit to apply");
    for (const hint of [brandKitCopy.fontsHint, brandKitCopy.logoHint, brandKitCopy.presetHint]) {
      expect(html).toContain(hint);
      expect(unqualifiedClaims(hint)).toEqual([]);
    }
    expect(unqualifiedClaims(intro)).toEqual([]);
  });

  it("offers the seeded fonts and the automatic style preset as choices", async () => {
    const { default: BrandPage } = await import("@/app/app/brand/page");
    const html = render(await BrandPage());
    expect(html).toContain(brandKitCopy.defaultFontLabel);
    expect(html).toContain("Playfair Display");
    expect(html).toContain("Roboto Slab");
    expect(html).toContain(brandKitCopy.autoPresetLabel);
    expect(html).toContain("luxury marble");
  });
});

describe("site header", () => {
  it("offers log in and signup to signed out visitors", async () => {
    const { SiteHeader } = await import("./site-header");
    const html = render(React.createElement(SiteHeader));
    expect(html).toContain('href="/login"');
    expect(html).toContain('href="/signup?source=header"');
    expect(html).toContain(">Start free<");
    expect(html).not.toContain("Open app");
  });

  it("offers Open app instead of signup to signed in visitors", async () => {
    const { HeaderActionsView } = await import("./header-actions");
    const html = render(
      React.createElement(HeaderActionsView, { signedIn: true, links: [{ href: "/pricing", label: "Pricing" }] }),
    );
    expect(html).toContain('href="/app"');
    expect(html).toContain("Open app");
    expect(html).toContain('href="/pricing"');
    expect(html).not.toContain("Start free");
    expect(html).not.toContain('href="/signup"');
    expect(html).not.toContain('href="/login"');
  });
});
