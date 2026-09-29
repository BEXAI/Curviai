import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { TierFeature, TierKey } from "@curvi/pipeline/seed";
import { listSpecs } from "@curvi/specs";
import { creditBalanceLine, submitFailureSpendsKey } from "@/components/app/new-pack-form";
import { checkChannelEntitlements } from "@/lib/entitlements";
import { isSpecLive } from "@/lib/marketing-facts";
import { KEEP_PHOTOS_PAUSED_COPY, whiteRequiredCopy } from "@/lib/output-options-copy";
import { LISTING_MODE_LINE } from "@/lib/output-options-form";
import { PACKS_PAUSED_COPY, SCENES_PAUSED_COPY } from "@/lib/provider-preflight";
import { newPackChannelOptions } from "./channel-options";

// The new pack form must never offer a channel createJob refuses: a channel
// whose feature is not live shows Coming soon and cannot be picked, and one
// outside the plan links to billing (Phase 10 decision 1). The server check
// in createJob stays; this covers the form side.

beforeAll(() => {
  // The web tsconfig keeps JSX for Next.js, so Vitest compiles it to
  // React.createElement calls against a global React.
  (globalThis as { React?: typeof React }).React = React;
});

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children?: React.ReactNode }) =>
    React.createElement("a", { href, ...rest }, children),
}));

const page = vi.hoisted(() => ({
  plan: "growth",
  creditBalance: 40,
  options: false,
  brandColors: ["#1F2A44"] as string[],
  storedPhotoCount: undefined as number | undefined,
}));

vi.mock("@/lib/services", () => ({
  getServices: () => ({
    ensureWorkspace: async () => ({
      id: "ws_1",
      name: "Test shop",
      plan: page.plan,
      creditBalance: page.creditBalance,
      role: "owner",
    }),
    listProducts: async () =>
      page.storedPhotoCount === undefined
        ? []
        : [
            {
              id: "00000000-0000-4000-8000-000000000201",
              title: "Stored mug",
              mode: "listing",
              storedPhotoCount: page.storedPhotoCount,
            },
          ],
    outputOptionsEnabled: async () => page.options,
    getBrandKit: async () => ({
      name: "Kit",
      colors: page.brandColors,
      fonts: { heading: "Inter", body: "Inter" },
      stylePreset: "auto",
      hasLogo: false,
    }),
  }),
}));

const preflight = vi.hoisted(() => ({ verdict: "ok" as "ok" | "scenes_paused" | "packs_paused" }));

vi.mock("@/lib/provider-preflight", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/provider-preflight")>();
  return { ...actual, providerPreflight: async () => preflight.verdict };
});

const ALL_TIERS: TierKey[] = ["free", "starter", "growth", "pro", "agency"];

describe("newPackChannelOptions", () => {
  it("lists every registry channel with the verdict createJob would give it", () => {
    const lives: Array<(feature: TierFeature) => boolean> = [
      () => false,
      (feature) => feature === "templatedVideo",
      () => true,
    ];
    for (const isLive of lives) {
      for (const tier of ALL_TIERS) {
        const options = newPackChannelOptions(tier, isLive);
        expect(options.map((o) => o.id)).toEqual(listSpecs().map((s) => s.id));
        for (const option of options) {
          const accepted = checkChannelEntitlements([option.id], tier, isLive).ok;
          expect(option.availability === "available", `${option.id} on ${tier}`).toBe(accepted);
        }
      }
    }
  });

  it("marks video Coming soon on every plan today", () => {
    for (const tier of ALL_TIERS) {
      const video = newPackChannelOptions(tier).filter((o) => o.id.startsWith("video."));
      expect(video.length).toBeGreaterThan(0);
      expect(video.every((o) => o.availability === "coming_soon" && o.upgradeTo === null)).toBe(true);
    }
  });

  it("names the plan to upgrade to once a video feature ships outside this plan", () => {
    const templated = (feature: TierFeature) => feature === "templatedVideo";
    const listing = newPackChannelOptions("free", templated).find((o) => o.id === "video.amazon_listing");
    expect(listing).toMatchObject({ availability: "upgrade_required", upgradeTo: "starter" });
  });

  it("marks every image spec a pack makes no files for Coming soon on every plan", () => {
    for (const tier of ALL_TIERS) {
      const options = newPackChannelOptions(tier, () => true);
      const images = options.filter((o) => !o.id.startsWith("video."));
      for (const option of images) {
        expect(option.availability, `${option.id} on ${tier}`).toBe(isSpecLive(option.id) ? "available" : "coming_soon");
      }
      expect(options.find((o) => o.id === "amazon.aplus.premium_full")).toMatchObject({
        availability: "coming_soon",
        upgradeTo: null,
      });
    }
  });

  it("offers a spec once it ships", () => {
    const premium = newPackChannelOptions("growth", undefined, () => true).find(
      (o) => o.id === "amazon.aplus.premium_full",
    );
    expect(premium?.availability).toBe("available");
  });
});

describe("new pack form helpers", () => {
  it("starts a new intent after a 409 or the server's own 503 refusal, and keeps the key otherwise", () => {
    expect(submitFailureSpendsKey(409)).toBe(true);
    expect(submitFailureSpendsKey(503, "unavailable")).toBe(true);
    // A 503 from anything else (a proxy, workspace setup) may follow a
    // started pack, so the retry keeps the key and replays it.
    expect(submitFailureSpendsKey(503)).toBe(false);
    for (const status of [400, 401, 402, 403, 404, 422, 429, 500, 502, 504]) {
      expect(submitFailureSpendsKey(status, "unavailable"), String(status)).toBe(false);
    }
  });

  it("explains a balance below zero instead of showing a negative number", () => {
    const line = creditBalanceLine(-12);
    expect(line).toContain("12 credits below zero");
    expect(line).toContain("smaller plan");
    expect(line).toContain("top up or your next renewal");
    expect(line).not.toContain("-12");
    expect(line).not.toMatch(/[–—→]| - |->/);
    expect(creditBalanceLine(-1)).toContain("1 credit below zero");
    expect(creditBalanceLine(40)).toBe("You have 40 credits. Only assets that pass QC are charged.");
  });
});

async function renderPage(): Promise<string> {
  const { default: NewPackPage } = await import("./page");
  const element = await NewPackPage({ searchParams: Promise.resolve({}) });
  return renderToStaticMarkup(element);
}

/** The markup of one channel row, found by its test id. */
function channelRow(html: string, id: string): string {
  const start = html.indexOf(`data-testid="channel-${id}"`);
  expect(start, `row for ${id}`).toBeGreaterThan(-1);
  const end = html.indexOf('data-testid="channel-', start + 1);
  return html.slice(start, end === -1 ? undefined : end);
}

describe("/app/new", () => {
  it("shows video channels with a Coming soon label and a disabled checkbox", async () => {
    const html = await renderPage();
    for (const id of ["video.social_9x16", "video.amazon_listing"]) {
      const row = channelRow(html, id);
      expect(row).toContain('disabled=""');
      expect(row).toContain("Coming soon");
      expect(row).not.toContain('checked=""');
    }
  });

  it("keeps image channels pickable, with the defaults checked", async () => {
    const html = await renderPage();
    const main = channelRow(html, "amazon.main");
    expect(main).not.toContain('disabled=""');
    expect(main).toContain('checked=""');
    expect(main).not.toContain("Coming soon");
    const pin = channelRow(html, "pinterest.pin");
    expect(pin).not.toContain('disabled=""');
    expect(pin).not.toContain('checked=""');
  });

  it("renders exactly as before PHASE_15 while output options are off", async () => {
    const html = await renderPage();
    expect(html).toContain("3. How it is made");
    expect(html).not.toContain("How your images look");
    expect(html).not.toContain('role="switch"');
    expect(html).not.toContain('role="radiogroup"');
    expect(html).not.toContain('data-testid="row-chip"');
    expect(html).not.toContain('data-testid="summary-bar"');
    expect(html).toContain('data-testid="listing-mode"');
  });

  it("does the same on a plan that includes video, since video does not ship yet", async () => {
    page.plan = "agency";
    try {
      const html = await renderPage();
      expect(channelRow(html, "video.social_9x16")).toContain("Coming soon");
      expect(html).not.toContain('data-testid="channel-upgrade"');
    } finally {
      page.plan = "growth";
    }
  });

  it("shows an image spec that does not ship yet as Coming soon with a disabled checkbox", async () => {
    for (const plan of ["free", "agency"]) {
      page.plan = plan;
      try {
        const row = channelRow(await renderPage(), "amazon.aplus.premium_full");
        expect(row).toContain('disabled=""');
        expect(row).toContain("Coming soon");
        expect(row).not.toContain('checked=""');
      } finally {
        page.plan = "growth";
      }
    }
    // Shipping A plus headers stay pickable.
    expect(channelRow(await renderPage(), "amazon.aplus.basic_header")).not.toContain('disabled=""');
  });

  it("explains a balance below zero in the pack summary", async () => {
    page.creditBalance = -7.5;
    try {
      const html = await renderPage();
      expect(html).toContain("7.5 credits below zero");
      expect(html).not.toContain("-7.5");
    } finally {
      page.creditBalance = 40;
    }
  });

  it("nudges a low balance above the form and warns when the pick costs more than the balance", async () => {
    page.creditBalance = 2;
    try {
      const html = await renderPage();
      expect(html).toContain('data-testid="low-balance-nudge"');
      // No Stripe keys in tests: early access copy, and no checkout link.
      expect(html).toContain("Credits are limited during early access");
      expect(html).not.toContain("checkout=");
      expect(html).toContain('data-testid="estimate-over-balance"');
    } finally {
      page.creditBalance = 40;
    }
    const html = await renderPage();
    expect(html).not.toContain('data-testid="low-balance-nudge"');
    expect(html).not.toContain('data-testid="estimate-over-balance"');
  });

  it("shows no preflight banner while every image service is up", async () => {
    const html = await renderPage();
    expect(html).not.toContain('data-testid="preflight-banner"');
    expect(createButton(html)).not.toContain('disabled=""');
  });

  it("pauses packs and disables Create pack while the cutout service is down", async () => {
    preflight.verdict = "packs_paused";
    try {
      const html = await renderPage();
      expect(html).toContain('data-testid="preflight-banner"');
      expect(html).toContain(PACKS_PAUSED_COPY);
      expect(createButton(html)).toContain('disabled=""');
    } finally {
      preflight.verdict = "ok";
    }
  });

  it("says scenes are paused but keeps Create pack when only scenes are down", async () => {
    preflight.verdict = "scenes_paused";
    try {
      const html = await renderPage();
      expect(html).toContain("Lifestyle scenes are paused");
      expect(html).toContain("White background and cutout files still work");
      expect(createButton(html)).not.toContain('disabled=""');
    } finally {
      preflight.verdict = "ok";
    }
  });
});

describe("/app/new with output options on", () => {
  async function renderOn(): Promise<string> {
    page.options = true;
    try {
      return await renderPage();
    } finally {
      page.options = false;
    }
  }

  it("shows section 3 with the looks as a radiogroup and the switch", async () => {
    const html = await renderOn();
    expect(html).toContain("3. How your images look");
    expect(html).toContain('role="radiogroup"');
    // Three look cards, and the four bundle cards above the channel list (PHASE_16).
    expect(html.match(/role="radio"/g)?.length).toBe(3 + 4);
    expect(html).toMatch(/<button[^>]*role="switch"[^>]*aria-checked="true"/);
    expect(html).toContain("Remove the background");
    expect(html).toContain(LISTING_MODE_LINE);
    expect(html).toContain('data-testid="summary-bar"');
    expect(html).toContain('data-testid="summary-background"');
    expect(html).toContain("Background: removed, on white");
    expect(html).not.toContain('data-testid="listing-mode"');
  });

  it("shows the bundle cards above the channel list with Everything picked and a figure on each (PHASE_16)", async () => {
    const html = await renderOn();
    const cards = html.indexOf('data-testid="bundle-cards"');
    expect(cards).toBeGreaterThan(-1);
    expect(cards).toBeLessThan(html.indexOf('data-testid="channel-amazon.main"'));
    expect(html).toContain('aria-label="How much to make"');
    for (const key of ["main", "listing", "aplus", "everything"]) {
      expect(html).toContain(`data-testid="bundle-${key}-credits"`);
    }
    expect(html).toMatch(/role="radio" aria-checked="true"[^>]*data-testid="bundle-everything"/);
    expect(html).toContain("Main image only");
    expect(html).not.toContain("Not in the set you picked.");
  });

  it("shows no bundle cards while output options are off", async () => {
    const html = await renderPage();
    expect(html).not.toContain('data-testid="bundle-cards"');
  });

  it("carries the registry flags as chips on channel rows", async () => {
    const html = await renderOn();
    expect(channelRow(html, "amazon.main")).toContain("Stays white");
    expect(channelRow(html, "meta.story_9x16")).toContain("Set shape, 1080 by 1920");
    expect(channelRow(html, "shopify.product")).not.toContain('data-testid="row-chip"');
  });

  it("shows no heads up for today's pack on white", async () => {
    const html = await renderOn();
    expect(html).not.toContain('data-testid="heads-up"');
    expect(html).not.toContain('data-testid="row-heads-up"');
  });

  it("offers brand colors from the kit on a plan with brand kits", async () => {
    const html = await renderOn();
    expect(html).toContain("Brand color 1, #1F2A44");
    expect(html).not.toContain('data-testid="brand-look-unavailable"');
  });

  it("disables Brand look with the plan that includes brand kits on Free", async () => {
    page.plan = "free";
    try {
      const html = await renderOn();
      expect(html).toContain("Brand kits come with the Starter plan.");
      expect(html).not.toContain("Brand color 1");
    } finally {
      page.plan = "growth";
    }
  });

  it("asks for a brand color when the kit has none", async () => {
    page.brandColors = [];
    try {
      const html = await renderOn();
      expect(html).toContain("Add a brand color first.");
      expect(html).toContain('href="/app/brand"');
    } finally {
      page.brandColors = ["#1F2A44"];
    }
  });

  it("moves the cutout pause into the form with Keep my photos instead", async () => {
    preflight.verdict = "packs_paused";
    try {
      const html = await renderOn();
      expect(html).toContain(KEEP_PHOTOS_PAUSED_COPY);
      expect(html).not.toContain(PACKS_PAUSED_COPY);
      expect(html).toContain('data-testid="keep-photos-instead"');
      // Marketplace ready needs a cutout, so it still cannot start.
      expect(createButton(html)).toContain('disabled=""');
    } finally {
      preflight.verdict = "ok";
    }
  });

  it("turns the scenes extra off and says why while scenes are paused", async () => {
    preflight.verdict = "scenes_paused";
    try {
      const html = await renderOn();
      const scenes = html.slice(html.indexOf('data-testid="extra-scenes"'), html.indexOf('data-testid="extra-backdrops"'));
      expect(scenes).toContain('disabled=""');
      expect(scenes).not.toContain('checked=""');
      expect(scenes).toContain(SCENES_PAUSED_COPY);
      expect(createButton(html)).not.toContain('disabled=""');
    } finally {
      preflight.verdict = "ok";
    }
  });

  it("names the white channels in their copy", () => {
    expect(whiteRequiredCopy("walmart.main").leaveOut).toBe("Leave Walmart out");
  });
});

function createButton(html: string): string {
  const at = html.indexOf('data-testid="create-pack"');
  const start = html.lastIndexOf("<button", at);
  return html.slice(start, html.indexOf(">", at) + 1);
}
