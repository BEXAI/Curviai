import { expect, test, type BrowserContext, type Page } from "@playwright/test";

// PHASE_19 P19-09: the ChatGPT consent page in demo mode, where Supabase is
// not configured. The demo serves fixed authorization requests (demo-fresh,
// demo-consented, demo-unknown-client; any other id has expired), and a
// cookie picks the demo person: unset is the demo owner (one workspace),
// "teammate" has two workspaces, "signed_out" has no session. The demo
// requests send the browser back to https://chatgpt.com, stubbed here.

const PERSON_COOKIE = "curvi_demo_consent_user";
const CALLBACK = /^https:\/\/chatgpt\.com\/connector\/oauth\/demo-callback\?/;

async function signInAs(context: BrowserContext, baseURL: string | undefined, person: "teammate" | "signed_out"): Promise<void> {
  await context.addCookies([{ name: PERSON_COOKIE, value: person, url: baseURL ?? "http://localhost:3100" }]);
}

async function stubChatGpt(page: Page): Promise<void> {
  await page.route("https://chatgpt.com/**", (route) =>
    route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>ChatGPT stub</title><p>ChatGPT stub</p>" }),
  );
}

async function expectNoSellingOrMarketingLinks(page: Page): Promise<void> {
  await expect(page.locator('a[href^="/pricing"]')).toHaveCount(0);
  await expect(page.locator('a[href="/login"], a[href^="/login?"], a[href="/signup"], a[href^="/signup?"]')).toHaveCount(0);
  await expect(page.getByRole("link", { name: /pricing/i })).toHaveCount(0);
}

test.beforeEach(async ({ page }) => {
  await stubChatGpt(page);
});

test("signed out shows the sign in form in its own layout, with no pricing link", async ({ page, context, baseURL }) => {
  await signInAs(context, baseURL, "signed_out");
  const response = await page.goto("/oauth/consent?authorization_id=demo-fresh");
  expect(response?.status()).toBe(200);
  await expect(page.getByRole("heading", { level: 1, name: "Connect ChatGPT to Curvi" })).toBeVisible();
  const signIn = page.getByTestId("consent-sign-in");
  await expect(signIn).toBeVisible();
  await expect(signIn.getByRole("button", { name: "Log in", exact: true })).toBeVisible();
  await expect(signIn.getByRole("button", { name: "Create an account", exact: true })).toBeVisible();
  await expectNoSellingOrMarketingLinks(page);
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
});

// The demo build has no Supabase, so the sign in card is the maintenance
// notice; the Forgot password? button that stays on this page is checked with
// Supabase configured in components/oauth/consent-sign-in.test.ts.
test("the sign in card never leaves for /forgot-password or the marketing pages", async ({ page, context, baseURL }) => {
  await signInAs(context, baseURL, "signed_out");
  await page.goto("/oauth/consent?authorization_id=demo-fresh");
  const signIn = page.getByTestId("consent-sign-in");
  await expect(signIn).toBeVisible();
  for (const tab of ["Log in", "Create an account"]) {
    await signIn.getByRole("button", { name: tab, exact: true }).click();
    await expect(page.locator('a[href^="/forgot-password"]')).toHaveCount(0);
    await expectNoSellingOrMarketingLinks(page);
  }
  expect(page.url()).toContain("/oauth/consent?authorization_id=demo-fresh");
});

test("two workspaces show the picker, every requested scope and the note", async ({ page, context, baseURL }) => {
  await signInAs(context, baseURL, "teammate");
  await page.goto("/oauth/consent?authorization_id=demo-fresh");
  await expect(page.getByTestId("consent-account")).toContainText("Signed in as teammate@example.com.");
  await expect(page.getByRole("button", { name: "Use another account" })).toBeVisible();
  const picker = page.getByTestId("consent-picker");
  await expect(picker).toContainText("Which workspace should ChatGPT use?");
  await expect(picker.getByRole("radio")).toHaveCount(2);
  await expect(picker.getByRole("radio", { name: "Demo Workspace" })).toBeChecked();
  await expect(page.getByTestId("consent-scopes").locator("li")).toHaveText([
    "A private id for your Curvi account",
    "Your email address",
    "Your name and picture, if your account has them",
    "Your phone number, if your account has one",
    "Access that stays on until you disconnect",
  ]);
  await expect(page.getByText("ChatGPT asks for these by default. Curvi does not use them.")).toBeVisible();
  await expect(page.getByText("You can disconnect at any time in Settings, Connected apps.")).toBeVisible();
  await expectNoSellingOrMarketingLinks(page);
});

test("an expired or malformed request shows the expiry copy", async ({ page }) => {
  for (const id of ["demo-gone", "..%2F..%2Fadmin"]) {
    await page.goto(`/oauth/consent?authorization_id=${id}`);
    await expect(page.getByTestId("consent-message")).toHaveText(
      "This connection request expired. Go back to ChatGPT and press Connect again.",
    );
  }
});

test("Connect leaves for the client's redirect with a code", async ({ page }) => {
  await page.goto("/oauth/consent?authorization_id=demo-fresh");
  await expect(page.getByTestId("consent-account")).toContainText("Signed in as owner@example.com.");
  await expect(page.getByTestId("consent-picker")).toHaveCount(0);
  await page.getByTestId("consent-connect").click();
  await page.waitForURL(CALLBACK);
  expect(new URL(page.url()).searchParams.get("code")).toBeTruthy();
  await expect(page.getByText("ChatGPT stub")).toBeVisible();
});

test("Cancel sends the denial back to the client", async ({ page }) => {
  await page.goto("/oauth/consent?authorization_id=demo-fresh");
  await page.getByTestId("consent-cancel").click();
  await page.waitForURL(CALLBACK);
  expect(new URL(page.url()).searchParams.get("error")).toBe("access_denied");
});

test("a client Curvi does not work with is refused before any redirect", async ({ page }) => {
  await page.goto("/oauth/consent?authorization_id=demo-unknown-client");
  await expect(page.getByTestId("consent-message")).toHaveText("Curvi does not work with this app yet, so nothing was shared.");
  expect(page.url()).toContain("/oauth/consent");
});

test("the consented path ends back at the client, with or without a live connection", async ({ page }) => {
  await page.goto("/oauth/consent?authorization_id=demo-consented");
  if (!CALLBACK.test(page.url())) {
    // No live connection yet: the page asks first, then follows the link.
    await page.getByTestId("consent-connect").click();
  }
  await page.waitForURL(CALLBACK);
  expect(new URL(page.url()).searchParams.get("code")).toBeTruthy();
});

test("Use another account signs this browser out and shows the sign in form", async ({ page }) => {
  await page.goto("/oauth/consent?authorization_id=demo-fresh");
  await page.getByRole("button", { name: "Use another account" }).click();
  await expect(page.getByTestId("consent-sign-in")).toBeVisible();
  // Marked switched, so after signing in the page says to press Connect in
  // ChatGPT again (Supabase bound the request to the first account).
  expect(page.url()).toContain("/oauth/consent?authorization_id=demo-fresh&switched=1");
});
