import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// P18-13: the "Continue with Google" button shows on /signup and /login
// only with NEXT_PUBLIC_GOOGLE_AUTH=1, above the email form, with the
// clickwrap terms line above both buttons.

beforeAll(() => {
  (globalThis as { React?: typeof React }).React = React;
});

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children?: React.ReactNode }) =>
    React.createElement("a", { href, ...rest }, children),
}));

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://project.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-key");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

async function render(mode: "signup" | "login", google: boolean): Promise<string> {
  vi.stubEnv("NEXT_PUBLIC_GOOGLE_AUTH", google ? "1" : "");
  const { AuthForm } = await import("./auth-form");
  return renderToStaticMarkup(React.createElement(AuthForm, { mode }));
}

describe("Google sign in on the auth form", () => {
  it("is absent without the flag, and the form is unchanged", async () => {
    const html = await render("signup", false);
    expect(html).not.toContain('data-testid="google-sign-in"');
    expect(html).not.toContain("Continue with Google");
    // The terms line still sits with the email form.
    expect(html).toContain('data-testid="terms-notice"');
    expect(html.indexOf('data-testid="terms-notice"')).toBeGreaterThan(html.indexOf("Start free"));
    expect(await render("login", false)).not.toContain("Continue with Google");
  });

  it("shows above the email form on signup, with the terms line above both buttons", async () => {
    const html = await render("signup", true);
    const terms = html.indexOf('data-testid="terms-notice"');
    const google = html.indexOf('data-testid="google-sign-in"');
    const email = html.indexOf("Start free");
    expect(terms).toBeGreaterThan(-1);
    expect(google).toBeGreaterThan(terms);
    expect(email).toBeGreaterThan(google);
    expect(html).toContain("Continue with Google");
    expect(html).toContain("Or use your email");
    expect(html).toContain("By creating an account you agree to the");
    // One terms line, not two.
    expect(html.split('data-testid="terms-notice"')).toHaveLength(2);
  });

  it("shows on login with a terms line, since Google can create an account there", async () => {
    const html = await render("login", true);
    const terms = html.indexOf('data-testid="terms-notice"');
    expect(terms).toBeGreaterThan(-1);
    expect(html.indexOf('data-testid="google-sign-in"')).toBeGreaterThan(terms);
    expect(html).toContain("By continuing with Google you agree to the");
    expect(html).toContain("Log in");
  });

  it("uses plain copy: no emojis, arrows or dashes as punctuation (rule 9)", async () => {
    for (const mode of ["signup", "login"] as const) {
      const text = (await render(mode, true)).replace(/<[^>]+>/g, " ");
      expect(text).not.toMatch(/[–—→←]| - |->|<-/);
      expect(text).not.toMatch(/\p{Extended_Pictographic}/u);
    }
  });
});
