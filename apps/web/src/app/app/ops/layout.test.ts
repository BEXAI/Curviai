import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// docs/phases/PHASE_20.md W7: one operator gate for everything under
// /app/ops, reusing isOperator (lib/ops.ts). Everyone else gets notFound().

const state = vi.hoisted(() => ({
  user: null as null | { email?: string; email_confirmed_at?: string | null },
  fails: false,
  aal: "aal2",
  path: "/app/ops",
}));

vi.mock("next/headers", () => ({ headers: async () => new Headers({ "x-curvi-ops-path": state.path }) }));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => {
    if (state.fails) throw new Error("auth unavailable");
    return { auth: {
      getUser: async () => ({ data: { user: state.user && { ...state.user, id: "operator" } } }),
      getClaims: async () => ({ data: { claims: { sub: "operator", aal: state.aal } } }),
    } };
  },
}));

const { default: OpsLayout, metadata } = await import("./layout");

const NOT_FOUND = { digest: "NEXT_HTTP_ERROR_FALLBACK;404" };
const CHILD = "operator page";

beforeEach(() => {
  vi.stubEnv("OPS_EMAILS", " Founder@Curvi.ai , ops@example.com ");
  vi.stubEnv("OPS_EMAIL", "");
  state.user = null;
  state.fails = false;
  state.aal = "aal2";
  state.path = "/app/ops";
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("/app/ops layout", () => {
  it("renders the page for a confirmed operator email, in any case", async () => {
    state.user = { email: "founder@curvi.ai", email_confirmed_at: "2026-09-01T00:00:00Z" };
    expect(renderToStaticMarkup(await OpsLayout({ children: CHILD }))).toContain(CHILD);
    state.user = { email: "OPS@example.com", email_confirmed_at: "2026-09-01T00:00:00Z" };
    expect(renderToStaticMarkup(await OpsLayout({ children: CHILD }))).toContain(CHILD);
  });

  it.each([
    ["signed out", null],
    ["a seller", { email: "seller@example.com", email_confirmed_at: "2026-09-01T00:00:00Z" }],
    ["an unconfirmed operator email", { email: "founder@curvi.ai", email_confirmed_at: null }],
  ])("answers 404 when %s", async (_label, user) => {
    state.user = user;
    await expect(OpsLayout({ children: CHILD })).rejects.toMatchObject(NOT_FOUND);
  });

  it("answers 404 when the session cannot be read", async () => {
    state.fails = true;
    await expect(OpsLayout({ children: CHILD })).rejects.toMatchObject(NOT_FOUND);
  });

  it("answers 404 for everyone when no operator is listed", async () => {
    vi.stubEnv("OPS_EMAILS", "");
    state.user = { email: "founder@curvi.ai", email_confirmed_at: "2026-09-01T00:00:00Z" };
    await expect(OpsLayout({ children: CHILD })).rejects.toMatchObject(NOT_FOUND);
  });

  it("requires MFA except on its enrollment and challenge page", async () => {
    state.user = { email: "founder@curvi.ai", email_confirmed_at: "2026-09-01T00:00:00Z" };
    state.aal = "aal1";
    await expect(OpsLayout({ children: CHILD })).rejects.toMatchObject({ digest: expect.stringContaining("/app/ops/security") });
    state.path = "/app/ops/security";
    expect(renderToStaticMarkup(await OpsLayout({ children: CHILD }))).toContain(CHILD);
  });

  it("is never indexed", () => {
    expect(metadata.robots).toMatchObject({ index: false, follow: false });
  });
});
