import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { resetAcquisitionForTests } from "@/lib/acquisition";
import { SIGNUP_PAUSED_NOTICE } from "./acquisition-copy";

// /signup while the acquisition gate is closed (docs/phases/PHASE_18.md
// P18-03): a server side notice, and the form stays, so nobody is turned
// away. CURVI_DEMO_ACQUISITION drives the gate in demo mode.

// Vitest compiles JSX to React.createElement (see marketing-render.test.ts).
beforeAll(() => {
  (globalThis as { React?: typeof React }).React = React;
});

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children?: React.ReactNode }) =>
    React.createElement("a", { href, ...rest }, children),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => undefined, replace: () => undefined, refresh: () => undefined }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/signup",
}));

afterEach(() => {
  vi.unstubAllEnvs();
  resetAcquisitionForTests();
});

async function renderSignup(): Promise<string> {
  const { default: SignupPage } = await import("@/app/(marketing)/signup/page");
  return renderToStaticMarkup(await SignupPage());
}

describe("signup page and the acquisition gate", () => {
  it("shows the paused notice and keeps the signup form while waitlisted", async () => {
    vi.stubEnv("CURVI_DEMO_ACQUISITION", "waitlist");
    const html = await renderSignup();
    expect(html).toContain('data-testid="signup-paused-notice"');
    expect(html).toContain(SIGNUP_PAUSED_NOTICE);
    // The page still renders the account form below the notice (here its
    // offline state, since tests have no Supabase): signup stays open.
    expect(html.indexOf("signup-paused-notice")).toBeLessThan(html.indexOf('class="mt-8"'));
  });

  it("shows no notice while packs can run", async () => {
    vi.stubEnv("CURVI_DEMO_ACQUISITION", "");
    const html = await renderSignup();
    expect(html).not.toContain("signup-paused-notice");
  });
});
