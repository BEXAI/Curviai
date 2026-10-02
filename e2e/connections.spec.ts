import { expect, test, type Page } from "@playwright/test";

// PHASE_19 P19-10: Settings, Connected apps in demo mode. The demo viewer of
// /app is the demo workspace's owner; connections are made through the
// consent page (e2e/oauth-consent.spec.ts), whose demo requests send the
// browser to https://chatgpt.com, stubbed here.

const CALLBACK = /^https:\/\/chatgpt\.com\/connector\/oauth\/demo-callback\?/;

async function stubChatGpt(page: Page): Promise<void> {
  await page.route("https://chatgpt.com/**", (route) =>
    route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>ChatGPT stub</title><p>ChatGPT stub</p>" }),
  );
}

test("settings links Connected apps, which lists your ChatGPT connection and disconnects it", async ({ page }) => {
  await stubChatGpt(page);
  await page.goto("/oauth/consent?authorization_id=demo-fresh");
  await page.getByTestId("consent-connect").click();
  await page.waitForURL(CALLBACK);

  await page.goto("/app/settings");
  await page.getByTestId("connected-apps-link").getByRole("link", { name: "Manage connected apps" }).click();
  await expect(page).toHaveURL(/\/app\/settings\/connections$/);
  await expect(page.getByRole("heading", { level: 1, name: "Connected apps" })).toBeVisible();

  const own = page.locator('[data-testid="connection-row"][data-own="true"]').first();
  await expect(own).toContainText("ChatGPT can make packs in Demo Workspace using its credits.");
  await expect(own).toContainText("Connected on");
  await own.getByRole("button", { name: "Disconnect" }).click();
  await expect(page.getByTestId("connections-notice")).toHaveText(
    "Disconnected. ChatGPT can no longer use this workspace, and links it already shared stop working.",
  );
});

test("an owner sees a member's connection in the workspace and can disconnect it", async ({ page, context, baseURL }) => {
  await stubChatGpt(page);
  // The demo teammate connects ChatGPT to the demo workspace.
  await context.addCookies([{ name: "curvi_demo_consent_user", value: "teammate", url: baseURL ?? "http://localhost:3100" }]);
  await page.goto("/oauth/consent?authorization_id=demo-fresh");
  await page.getByTestId("consent-picker").getByRole("radio", { name: "Demo Workspace" }).check();
  await page.getByTestId("consent-connect").click();
  await page.waitForURL(CALLBACK);

  await page.goto("/app/settings/connections");
  const member = page.locator('[data-testid="connection-row"][data-own="false"]').filter({ hasText: "Connected by Demo teammate." });
  await expect(member.first()).toContainText("ChatGPT can make packs in Demo Workspace using its credits.");
  await member.first().getByRole("button", { name: "Disconnect" }).click();
  await expect(page.getByTestId("connections-notice")).toHaveText(
    "Disconnected. ChatGPT can no longer use this workspace, and links it already shared stop working.",
  );
});
