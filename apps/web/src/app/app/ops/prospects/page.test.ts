import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// /app/ops/prospects (P18-04) is for the emails in OPS_EMAILS only. Everyone
// else gets notFound(), so the page answers 404 and does not show that it
// exists.

beforeAll(() => {
  (globalThis as { React?: typeof React }).React = React;
});

const state = vi.hoisted(() => ({
  user: null as null | { email?: string; email_confirmed_at?: string },
  dbMode: true,
}));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({ auth: {
    getUser: async () => ({ data: { user: state.user && { ...state.user, id: "operator" } } }),
    getClaims: async () => ({ data: { claims: { sub: "operator", aal: "aal2" } } }),
  } }),
}));
vi.mock("@/lib/services", () => ({ isDbMode: () => state.dbMode }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children?: React.ReactNode }) =>
    React.createElement("a", { href, ...rest }, children),
}));

const { default: ProspectsPage } = await import("./page");

const NOT_FOUND = { digest: "NEXT_HTTP_ERROR_FALLBACK;404" };
const OPERATOR = { email: "founder@curvi.ai", email_confirmed_at: "2026-09-30T00:00:00Z" };

beforeEach(() => {
  vi.stubEnv("OPS_EMAILS", "founder@curvi.ai");
  state.user = OPERATOR;
  state.dbMode = true;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("/app/ops/prospects", () => {
  it("is not found for anyone who is not an operator", async () => {
    for (const user of [null, { email: "seller@shop.example", email_confirmed_at: "2026-09-30T00:00:00Z" }, { email: "founder@curvi.ai" }]) {
      state.user = user;
      await expect(ProspectsPage()).rejects.toMatchObject(NOT_FOUND);
    }
  });

  it("asks for the database without it", async () => {
    state.dbMode = false;
    const html = renderToStaticMarkup(await ProspectsPage());
    expect(html).toContain('data-testid="prospects-notice"');
  });

  it("shows the tool to an operator, with the seeded default channels picked", async () => {
    const html = renderToStaticMarkup(await ProspectsPage());
    expect(html).toContain('data-testid="prospects-dashboard"');
    expect(html).toContain("Make the prospect pack");
    expect(html).toContain("Add prospect credits");
    expect(html.match(/<input type="checkbox"[^>]*checked=""/g)?.length).toBe(2);
  });
});
