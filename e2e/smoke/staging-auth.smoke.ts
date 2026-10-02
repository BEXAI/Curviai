import { expect, test } from "@playwright/test";
import { smokeSettings } from "./settings";

const settings = smokeSettings(process.env);
test.skip(settings.mode !== "staging", "Browser sign in is staging only; production CAPTCHA is never bypassed.");

test("the staging smoke user signs in with staging test CAPTCHA", async ({ page }) => {
  const email = process.env.SMOKE_USER_EMAIL;
  const password = process.env.SMOKE_USER_PASSWORD;
  expect(email, "Staging smoke requires SMOKE_USER_EMAIL").toBeTruthy();
  expect(password, "Staging smoke requires SMOKE_USER_PASSWORD").toBeTruthy();
  await page.goto("/login");
  await expect(page.getByTestId("environment-banner")).toContainText("staging");
  await page.getByLabel("Email", { exact: true }).fill(email!);
  await page.getByLabel("Password", { exact: true }).fill(password!);
  const submit = page.getByRole("button", { name: "Log in", exact: true });
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect(page).toHaveURL(/\/app(?:\/|$|\?)/, { timeout: 30_000 });
});
