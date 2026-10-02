import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// /app/settings/referrals (P18-24): 404 while referrals are off or in demo
// mode; owners and admins get their invite link (issued on first visit) and
// counts; other seats are told who can invite.

beforeAll(() => {
  (globalThis as { React?: typeof React }).React = React;
});

const state = vi.hoisted(() => ({
  dbMode: true,
  on: true,
  role: "owner" as string,
}));
const issue = vi.hoisted(() => vi.fn(async () => ({ code: "abcd2345", created: false })));
const summary = vi.hoisted(() => vi.fn(async () => ({ signups: 3, pending: 2, rewarded: 1, rewardedThisMonth: 1 })));

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children?: React.ReactNode }) =>
    React.createElement("a", { href, ...rest }, children),
}));
vi.mock("@/lib/services", () => ({
  isDbMode: () => state.dbMode,
  getServices: () => ({
    ensureWorkspace: async () => ({ id: "ws_1", name: "Shop", plan: "starter", creditBalance: 10, role: state.role }),
  }),
}));
vi.mock("@/lib/services/db", () => ({ getDb: () => ({}) }));
vi.mock("@/lib/referrals/switch", () => ({ referralsOn: async () => state.on }));
vi.mock("@/lib/referrals/service", () => ({ issueReferralCode: issue, referralSummary: summary }));

const { default: ReferralsPage } = await import("./page");

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://curvi.ai");
  state.dbMode = true;
  state.on = true;
  state.role = "owner";
  issue.mockClear();
});

describe("/app/settings/referrals", () => {
  it("answers 404 while referrals are off and in demo mode", async () => {
    state.on = false;
    await expect(ReferralsPage()).rejects.toThrow("NEXT_NOT_FOUND");
    state.on = true;
    state.dbMode = false;
    await expect(ReferralsPage()).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("shows an owner the invite link and what it earned", async () => {
    const html = renderToStaticMarkup(await ReferralsPage());
    expect(issue).toHaveBeenCalledWith({}, "ws_1");
    expect(html).toContain('value="https://curvi.ai/r/abcd2345"');
    expect(html).toContain("Your invite link");
    expect(html).toContain("3 sellers signed up with your link. 1 has made a purchase.");
    expect(html).toContain("Give 50 credits, get 50 credits.");
  });

  it("issues no code for an editor or a client seat", async () => {
    for (const role of ["editor", "client"]) {
      state.role = role;
      const html = renderToStaticMarkup(await ReferralsPage());
      expect(html).toContain("Only owners and admins of this workspace can invite sellers.");
      expect(html).not.toContain("/r/");
    }
    expect(issue).not.toHaveBeenCalled();
  });
});
