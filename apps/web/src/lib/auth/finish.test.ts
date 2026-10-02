import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdsConversion } from "@/lib/ads-conversions";

// docs/phases/PHASE_20.md P20-28, contract commit: finishSignIn is a pure
// move of the steps /auth/callback ran after the code exchange. Each case
// below lists the effects the callback had before the move (the terms
// record, PHASE_18's signup confirmation, the conversion call, PHASE_18's
// preview and prospect claims and pending referral, and the redirect, which
// PHASE_19's consent return keeps off the welcome page) and checks that both
// finishSignIn and the callback still produce exactly those.

const NOW = Date.parse("2026-10-01T12:00:00Z");
const minutesAgo = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

const state = vi.hoisted(() => ({
  dbMode: true,
  user: null as null | { id: string; created_at?: string | null; email_confirmed_at?: string | null },
  terms: [] as Array<{ userId: string; source: string; userAgent: string | null }>,
  conversions: [] as Array<{ id: string; type: string; sourceUrl: string; cookieHeader: string | null }>,
  confirmed: [] as Array<{ userId: string; attrParam: string | null }>,
  claims: [] as Array<{ step: "preview" | "prospect" | "referral"; userId: string | null }>,
  claimedProduct: null as string | null,
}));

vi.mock("@/lib/services", () => ({ isDbMode: () => state.dbMode }));
vi.mock("@/lib/services/db", () => ({ getDb: () => ({ fake: true }) }));
vi.mock("@/lib/trust/terms", () => ({
  recordTermsAcceptanceSafely: async (_db: unknown, input: { userId: string; source: string; headers: Headers }) => {
    state.terms.push({ userId: input.userId, source: input.source, userAgent: input.headers.get("user-agent") });
  },
}));
vi.mock("@/lib/ads-conversions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ads-conversions")>();
  return {
    ...actual,
    sendAdsConversion: async (event: AdsConversion, opts: { cookieHeader: string | null | undefined }) => {
      state.conversions.push({
        id: event.id,
        type: event.type,
        sourceUrl: event.sourceUrl,
        cookieHeader: opts.cookieHeader ?? null,
      });
      return false;
    },
  };
});
vi.mock("@/lib/services/attribution", () => ({
  recordSignupConfirmed: async (_db: unknown, input: { user: { id: string }; attrParam: string | null }) => {
    state.confirmed.push({ userId: input.user.id, attrParam: input.attrParam });
    return "written";
  },
}));
vi.mock("@/lib/free-preview/deps", () => ({
  claimSignupPreview: async (_preview: unknown, userId: string | null) => {
    state.claims.push({ step: "preview", userId });
    return state.claimedProduct ? { productId: state.claimedProduct } : null;
  },
}));
vi.mock("@/lib/prospects/runtime", () => ({
  claimSignupProspect: async (_claim: unknown, userId: string | null) => {
    state.claims.push({ step: "prospect", userId });
    return null;
  },
}));
vi.mock("@/lib/referrals/signup", () => ({
  recordSignupReferral: async (_ref: unknown, userId: string | null) => {
    state.claims.push({ step: "referral", userId });
  },
}));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({
    auth: { exchangeCodeForSession: async () => ({ data: { user: state.user }, error: null }) },
  }),
}));

const { finishSignIn } = await import("./finish");
const { GET } = await import("@/app/auth/callback/route");

const USER_ID = "0b7a4d1e-5c3f-4a2b-9e8d-7c6b5a4f3e2d";
const COOKIE = "curvi_consent=granted";
const AGENT = "Mozilla/5.0 test";

interface Case {
  name: string;
  dbMode: boolean;
  user: typeof state.user;
  next: string;
  /** Extra callback query, after code and next. */
  query?: string;
  /** What the preview claim returns (P18-12). */
  claimedProduct?: string;
  expected: {
    terms: typeof state.terms;
    confirmed: typeof state.confirmed;
    conversions: typeof state.conversions;
    claims: typeof state.claims;
    destination: string;
  };
}

const newUser = { id: USER_ID, created_at: minutesAgo(5), email_confirmed_at: minutesAgo(1) };
const oldUser = { id: USER_ID, created_at: minutesAgo(60 * 24 * 30), email_confirmed_at: minutesAgo(60 * 24 * 29) };
const termsRow = { userId: USER_ID, source: "signup_callback", userAgent: AGENT };
const conversion = {
  id: `registration_completed:${USER_ID}`,
  type: "registration_completed",
  sourceUrl: "https://curvi.ai/signup",
  cookieHeader: COOKIE,
};

const fresh = { confirmed: [{ userId: USER_ID, attrParam: null }] };
const allClaims: typeof state.claims = [
  { step: "preview", userId: USER_ID },
  { step: "prospect", userId: USER_ID },
  { step: "referral", userId: USER_ID },
];
const CONSENT_NEXT = "/oauth/consent?authorization_id=AbCdEfGhIjKlMnOpQrStUvWxYz012345";

const CASES: Case[] = [
  {
    name: "a new account confirming its email records terms, sends the conversion and goes to /welcome",
    dbMode: true,
    user: newUser,
    next: "/app",
    expected: { terms: [termsRow], ...fresh, conversions: [conversion], claims: allClaims, destination: "/welcome" },
  },
  {
    name: "the welcome page carries a checkout destination",
    dbMode: true,
    user: newUser,
    next: "/app/billing?checkout=growth&cadence=annual",
    expected: {
      terms: [termsRow],
      ...fresh,
      conversions: [conversion],
      claims: allClaims,
      destination: `/welcome?next=${encodeURIComponent("/app/billing?checkout=growth&cadence=annual")}`,
    },
  },
  {
    name: "an older account (a recovery link) records terms only and goes straight on",
    dbMode: true,
    user: oldUser,
    next: "/app/brand",
    expected: { terms: [termsRow], confirmed: [], conversions: [], claims: [], destination: "/app/brand" },
  },
  {
    name: "demo mode writes no terms record and no signup confirmation",
    dbMode: false,
    user: newUser,
    next: "/app",
    expected: { terms: [], confirmed: [], conversions: [conversion], claims: allClaims, destination: "/welcome" },
  },
  {
    name: "an exchange with no user has no effects",
    dbMode: true,
    user: null,
    next: "/app/jobs",
    expected: { terms: [], confirmed: [], conversions: [], claims: [], destination: "/app/jobs" },
  },
  {
    name: "Google's attr reaches the signup confirmation (P18-01)",
    dbMode: true,
    user: newUser,
    next: "/app",
    query: "attr=eyJzb3VyY2UiOiJob21lIn0",
    expected: {
      terms: [termsRow],
      confirmed: [{ userId: USER_ID, attrParam: "eyJzb3VyY2UiOiJob21lIn0" }],
      conversions: [conversion],
      claims: allClaims,
      destination: "/welcome",
    },
  },
  {
    name: "a claimed free preview continues to a new pack on its product (P18-12)",
    dbMode: true,
    user: newUser,
    next: "/app",
    claimedProduct: "prod_1",
    expected: {
      terms: [termsRow],
      ...fresh,
      conversions: [conversion],
      claims: [
        { step: "preview", userId: USER_ID },
        { step: "referral", userId: USER_ID },
      ],
      destination: `/welcome?next=${encodeURIComponent("/app/new?product=prod_1")}`,
    },
  },
  {
    name: "a claim keeps an explicit destination",
    dbMode: true,
    user: newUser,
    next: "/app/brand",
    claimedProduct: "prod_1",
    expected: {
      terms: [termsRow],
      ...fresh,
      conversions: [conversion],
      claims: [
        { step: "preview", userId: USER_ID },
        { step: "referral", userId: USER_ID },
      ],
      destination: `/welcome?next=${encodeURIComponent("/app/brand")}`,
    },
  },
  {
    name: "the way back to the ChatGPT consent page skips the welcome page (P19-09)",
    dbMode: true,
    user: newUser,
    next: CONSENT_NEXT,
    expected: { terms: [termsRow], ...fresh, conversions: [conversion], claims: allClaims, destination: CONSENT_NEXT },
  },
];

function effects() {
  return { terms: state.terms, confirmed: state.confirmed, conversions: state.conversions, claims: state.claims };
}

function headers(): Headers {
  return new Headers({ cookie: COOKIE, "user-agent": AGENT });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://curvi.ai");
  state.terms = [];
  state.conversions = [];
  state.confirmed = [];
  state.claims = [];
  state.claimedProduct = null;
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("finishSignIn keeps the callback's effects (P20-28 contract)", () => {
  it.each(CASES)("finishSignIn: $name", async (c) => {
    state.dbMode = c.dbMode;
    state.claimedProduct = c.claimedProduct ?? null;
    const destination = await finishSignIn({
      user: c.user,
      next: c.next,
      origin: "https://curvi.ai",
      headers: headers(),
      params: new URLSearchParams(c.query ?? ""),
    });
    expect({ ...effects(), destination }).toEqual(c.expected);
  });

  it.each(CASES)("/auth/callback: $name", async (c) => {
    state.dbMode = c.dbMode;
    state.user = c.user;
    state.claimedProduct = c.claimedProduct ?? null;
    const extra = c.query ? `&${c.query}` : "";
    const response = await GET(
      new NextRequest(`https://curvi.ai/auth/callback?code=abc&next=${encodeURIComponent(c.next)}${extra}`, {
        headers: headers(),
      }),
    );
    const location = new URL(response.headers.get("location") ?? "");
    expect(location.origin).toBe("https://curvi.ai");
    expect({ ...effects(), destination: `${location.pathname}${location.search}` }).toEqual(c.expected);
  });
});
