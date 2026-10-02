import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// PHASE_19 P19-09: "Forgot password?" inside the ChatGPT connect flow stays
// on the consent page. The e2e suite runs the demo build without Supabase,
// where the sign in card is the maintenance notice, so the forms with
// Supabase configured are checked here.

beforeAll(() => {
  // The web tsconfig keeps JSX for Next.js, so Vitest compiles it to
  // React.createElement calls against a global React.
  (globalThis as { React?: typeof React }).React = React;
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-key-for-tests");
  vi.resetModules();
});

afterAll(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("the consent page's sign in forms", () => {
  it("offers Forgot password? as a button on the page, never a link to /forgot-password", async () => {
    const { ConsentSignIn } = await import("./consent-sign-in");
    const html = renderToStaticMarkup(React.createElement(ConsentSignIn, { next: "/oauth/consent?authorization_id=x" }));
    expect(html).toContain("Welcome back");
    expect(html).toMatch(/<button[^>]*>Forgot password\?<\/button>/);
    expect(html).not.toContain('href="/forgot-password"');
    expect(html).not.toContain('href="/pricing"');
  });

  it("the web log in page keeps its link to /forgot-password", async () => {
    const { AuthForm } = await import("@/components/marketing/auth-form");
    const html = renderToStaticMarkup(React.createElement(AuthForm, { mode: "login" }));
    expect(html).toMatch(/<a[^>]*href="\/forgot-password"[^>]*>Forgot password\?<\/a>/);
  });

  it("the reset form goes back to log in on the same page", async () => {
    const { ForgotPasswordForm } = await import("@/components/marketing/password-forms");
    // Its props default to {}, which createElement's overloads do not take.
    const Form = ForgotPasswordForm as React.FC<{ onLogIn?: () => void }>;
    const inFlow = renderToStaticMarkup(React.createElement(Form, { onLogIn: () => undefined }));
    expect(inFlow).toContain("Reset your password");
    expect(inFlow).toMatch(/Remembered it\?.*<button[^>]*>Log in<\/button>/s);
    expect(inFlow).not.toContain('href="/login"');
  });
});
