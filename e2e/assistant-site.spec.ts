import { expect, test } from "@playwright/test";

// PHASE_19 P19-22 to P19-24: the pages the ChatGPT plugin listing links,
// the domain proof route and the help article. These run in demo mode,
// where OPENAI_APPS_CHALLENGE_TOKEN is not set.

test("support page gives the email and links help, Connected apps and the policies", async ({ page }) => {
  const response = await page.goto("/support");
  expect(response?.status()).toBe(200);
  await expect(page.getByRole("heading", { level: 1, name: "Support" })).toBeVisible();
  await expect(page.getByTestId("support-lead")).toContainText("support@curvi.ai");
  await expect(page.getByTestId("support-lead")).toContainText("the pack id ChatGPT showed you");
  const main = page.locator("main");
  for (const href of ["/help", "/app/settings/connections", "/privacy", "/terms"]) {
    await expect(main.locator(`a[href="${href}"]`).first()).toBeVisible();
  }
  await expect(page.locator("footer").locator('a[href="/support"]')).toHaveCount(1);
});

test("privacy and terms cover ChatGPT and other assistants", async ({ page }) => {
  expect((await page.goto("/privacy"))?.status()).toBe(200);
  const section = page.getByTestId("privacy-assistants");
  await expect(section).toContainText("Using Curvi from ChatGPT and other assistants");
  await expect(section).toContainText("OpenAI for ChatGPT and Codex");
  await expect(section).toContainText("We do not receive your conversations.");
  // The retention table (P20-23) holds the assistant connection and log rows.
  await expect(page.getByTestId("privacy-retention")).toContainText("Records of the assistants you connect");
  await expect(page.getByTestId("privacy-retention")).toContainText("Request logs and error reports");
  expect((await page.goto("/terms"))?.status()).toBe(200);
  await expect(page.getByTestId("terms-assistants")).toContainText("credits it spends are charged the same way");
});

test("help keeps the unpublished ChatGPT article gated", async ({ page, request }) => {
  await page.goto("/help");
  await expect(page.locator("#use-curvi-in-chatgpt")).toHaveCount(0);
  expect((await request.get("/help/use-curvi-in-chatgpt")).status()).toBe(404);
});

test("the domain proof path serves the approved challenge as plain text", async ({ request }) => {
  const response = await request.get("/.well-known/openai-apps-challenge");
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toMatch(/^text\/plain/);
  // OpenAI wants the exact token and nothing else: no JSON, list or whitespace.
  expect(await response.text()).toMatch(/^[A-Za-z0-9_-]{20,}$/);
});

test("llms.txt does not link the unpublished ChatGPT article", async ({ request }) => {
  const text = await (await request.get("/llms.txt")).text();
  expect(text).not.toContain("/help#use-curvi-in-chatgpt");
  expect(text).not.toContain("/help/use-curvi-in-chatgpt");
});
