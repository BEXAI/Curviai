import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { freeCredits, typicalPackCredits } from "@/lib/marketing-facts";
import { categories } from "./categories";
import { afterDemoImage, beforeDemoImage, galleryCases, isIllustrationSrc } from "./demo-images";
import { homeFaqs, homeFeatures } from "./home-copy";

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
  }),
}));

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children?: React.ReactNode }) =>
    React.createElement("a", { href, ...rest }, children),
}));

function render(element: React.ReactElement): string {
  return renderToStaticMarkup(element);
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

describe("hero upload box", () => {
  it("says the photo is not uploaded from the page and states the free grant", async () => {
    const { UploadBox } = await import("./upload-box");
    const html = render(React.createElement(UploadBox, { freeCredits: freeCredits() }));
    expect(html).toContain("Nothing is uploaded from this page");
    expect(html).toContain(`free account with ${freeCredits()} credits`);
    expect(html).not.toMatch(/see your pack/i);
    expect(html).not.toContain('type="file"');
    expect(html).toContain('href="/signup"');
    expect(html).toContain('href="/tools/main-image-checker"');
  });
});

describe("coming soon badge", () => {
  it("renders the shared label", async () => {
    const { ComingSoonBadge } = await import("./coming-soon-badge");
    expect(render(React.createElement(ComingSoonBadge))).toContain("Coming soon");
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
    expect(html).toContain('data-testid="illustration-label"');
    expect(html).not.toContain("Curvi output");
    expect(html).not.toContain("40 to 60");
    expect(faqQuestions(html)).toEqual(homeFaqs.map((faq) => faq.q));
  });

  it("home tells visitors paid plans are not open while Stripe is not set up", async () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "");
    const { default: HomePage } = await import("@/app/(marketing)/page");
    expect(render(React.createElement(HomePage))).toContain("Paid plans open soon");
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_placeholder");
    expect(render(React.createElement(HomePage))).not.toContain("Paid plans open soon");
  });

  it("help marks the Fresh Creative Drop coming soon and keeps it out of JSON-LD", async () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "");
    const { default: HelpPage } = await import("@/app/(marketing)/help/page");
    const html = render(React.createElement(HelpPage));
    expect(html).toContain("Coming soon");
    const questions = faqQuestions(html);
    expect(questions).not.toContain("What is the Fresh Creative Drop?");
    expect(questions).not.toContain("How do billing and cancellation work?");
    expect(questions).toContain("How do credits work?");
  });

  it("gallery labels every case as an illustration", async () => {
    const { default: GalleryPage } = await import("@/app/(marketing)/gallery/page");
    const html = render(React.createElement(GalleryPage));
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

  it("share pages say they are coming soon and show an illustration", async () => {
    const { default: SharePage } = await import("@/app/(marketing)/s/[slug]/page");
    const html = render(React.createElement(SharePage));
    expect(html).toContain("Coming soon");
    expect(html).toContain('data-testid="illustration-label"');
    expect(html).not.toContain("Makeover reference");
  });
});
