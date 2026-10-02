import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { validationGates } from "@curvi/pipeline/seed";
import type { FunnelReport, FunnelWindowStats } from "@/lib/funnel-report";

// /app/ops/funnel (P18-02) is for the emails in OPS_EMAILS only. Everyone
// else gets notFound(), so the page answers 404 and does not show that it
// exists.

beforeAll(() => {
  (globalThis as { React?: typeof React }).React = React;
});

const state = vi.hoisted(() => ({
  user: null as null | { email?: string; email_confirmed_at?: string },
  dbMode: true,
  readError: false,
}));
const load = vi.hoisted(() => vi.fn());

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({ auth: {
    getUser: async () => ({ data: { user: state.user && { ...state.user, id: "operator" } } }),
    getClaims: async () => ({ data: { claims: { sub: "operator", aal: "aal2" } } }),
  } }),
}));
vi.mock("@/lib/services", () => ({ isDbMode: () => state.dbMode }));
vi.mock("@/lib/services/db", () => ({ getDb: () => ({}) }));
vi.mock("@/lib/funnel-report", () => ({ loadFunnelReport: load }));

const { default: FunnelPage } = await import("./page");

const NOT_FOUND = { digest: "NEXT_HTTP_ERROR_FALLBACK;404" };
const FORBIDDEN_COPY = /[‒-―←-⇿⟵-⟿]|\s-\s|--|\p{Extended_Pictographic}/u;
const OPERATOR = { email: "founder@curvi.ai", email_confirmed_at: "2026-09-30T00:00:00Z" };

function stats(signups: number): FunnelWindowStats {
  return {
    window: { key: "since", from: new Date("2026-10-01T00:00:00Z"), to: new Date("2026-10-12T09:00:00Z") },
    confirmedSignups: signups,
    bySelfReported: [{ label: "reddit", count: 3 }],
    byUtmSource: [{ label: "newsletter", count: 2 }],
    byPageSource: [{ label: "home", count: 6 }],
    firstPacksStarted: 4,
    firstPacksDone: 4,
    activation: { hits: 4, of: signups },
    firstDownloads: 1,
    payments: 1,
    firstPayments: 1,
    paymentsUsd: 29,
    repeat: { hits: 1, of: 4 },
    payerRepeat: { hits: 0, of: 1 },
    sharesPublished: 2,
    leadsCaptured: 3,
    newLeads: [{ label: "main-image-checker", count: 2 }],
    feedback: { hits: 0, of: 0 },
    previewsMade: 0,
    previewsClaimed: 0,
    prospectPacks: 0,
    claimsRedeemed: 0,
    emailsSent: [{ label: "welcome", count: 3 }],
  };
}

function report(): FunnelReport {
  return {
    generatedAt: new Date("2026-10-12T09:00:00Z"),
    week: stats(10),
    since: stats(10),
    visitors: { visitors: 40, pageViews: 90, topSources: [] },
    shareViews: 5,
    weekly: [{ week: "2026-10-05", signups: 10, firstPacksDone: 4, firstDownloads: 1, firstPayments: 1 }],
    gates: validationGates.map((gate) => ({ gate, value: 0, denominator: 0, state: "too_early" as const })),
    excludedWorkspaces: 1,
  };
}

async function render(): Promise<string> {
  return renderToStaticMarkup(await FunnelPage());
}

beforeEach(() => {
  vi.stubEnv("OPS_EMAILS", "Founder@Curvi.ai");
  vi.stubEnv("OPS_EMAIL", "");
  state.user = null;
  state.dbMode = true;
  load.mockReset();
  load.mockImplementation(async () => report());
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("ops funnel page", () => {
  it("is not found for visitors, sellers and unconfirmed operator emails", async () => {
    await expect(FunnelPage()).rejects.toMatchObject(NOT_FOUND);
    state.user = { email: "seller@example.com", email_confirmed_at: "2026-09-30T00:00:00Z" };
    await expect(FunnelPage()).rejects.toMatchObject(NOT_FOUND);
    state.user = { email: "founder@curvi.ai" };
    await expect(FunnelPage()).rejects.toMatchObject(NOT_FOUND);
    expect(load).not.toHaveBeenCalled();
  });

  it("shows an operator the funnel by week, source and gate, leaving operator workspaces out", async () => {
    state.user = OPERATOR;
    const html = await render();
    expect(html).toContain('data-testid="funnel-dashboard"');
    expect(html).toContain('data-testid="funnel-weekly"');
    expect(html).toContain('data-testid="funnel-gates"');
    expect(html).toContain("40% (4 of 10)");
    expect(html).toContain("reddit");
    expect(html).toContain("1 workspace is left out");
    expect(load).toHaveBeenCalledWith({}, { operatorEmails: ["founder@curvi.ai"] });
    expect(html.replace(/<[^>]+>/g, " ")).not.toMatch(FORBIDDEN_COPY);
  });

  it("tells an operator when there is no database or the read failed", async () => {
    state.user = OPERATOR;
    state.dbMode = false;
    expect(await render()).toContain("The funnel needs the database");
    state.dbMode = true;
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    load.mockRejectedValueOnce(new Error("db down"));
    expect(await render()).toContain("could not be read just now");
  });
});
