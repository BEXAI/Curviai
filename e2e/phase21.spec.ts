import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

// Demo services only. No mail, paid generation, receiver setup or external
// webhook request is needed to exercise these customer-facing boundaries.
async function accessible(page: Page) {
  await expect(page).toHaveTitle(/\S/);
  const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
  expect(result.violations.filter((violation) => violation.impact === "serious" || violation.impact === "critical")).toEqual([]);
}

test("a seller can report once, reload its case and add a keyboard-accessible reply", async ({ page }) => {
  await page.addLocatorHandler(page.getByTestId("pack-ready-notice").first(), async () => {
    const dismiss = page.getByTestId("pack-ready-notice").getByRole("button", { name: "Dismiss" });
    while (await dismiss.count()) await dismiss.first().click();
  }, { noWaitAfter: true });
  await page.goto("/app/new");
  await page.getByTestId("create-pack").click();
  await page.waitForURL(/\/app\/jobs\/[^/]+$/, { timeout: 15000 });
  const jobPath = new URL(page.url()).pathname;
  await page.goto(`${jobPath}/cases`);
  await expect(page.getByRole("heading", { name: "Pack help", exact: true })).toBeVisible();
  await expect(page.getByText("No reports for this pack yet.")).toBeVisible();
  const message = "The product label is hard to read in the lifestyle image.";
  await page.getByLabel("What needs attention?").selectOption("fidelity");
  await page.getByLabel("What happened?").fill(message);
  const submitted = page.waitForResponse((response) => response.request().method() === "POST" && response.url().endsWith(`${jobPath.replace("/app/", "/api/")}/cases`));
  await page.getByRole("button", { name: "Send report", exact: true }).focus();
  await page.keyboard.press("Enter");
  const first = await submitted;
  expect(first.ok()).toBe(true);
  const created = await first.json() as { case: { id: string }; created: boolean };
  expect(created.created).toBe(true);
  const report = page.locator(`#case-${created.case.id}`);
  await expect(page.getByRole("status").filter({ hasText: "Your report was received" })).toBeVisible();
  await expect(report.getByRole("heading", { name: "Product appearance" })).toBeVisible();
  await expect(report.getByRole("list", { name: "Case timeline" })).toContainText(message);

  await page.reload();
  await expect(page.locator('[id^="case-"]').filter({ has: page.getByRole("heading", { name: "Product appearance" }) })).toHaveCount(1);
  await expect(report.getByRole("list", { name: "Case timeline" })).toContainText(message);
  // Reporting the same category again returns the open case, without another
  // case or timeline entry. The actual server handles this duplicate.
  await page.getByLabel("What happened?").fill(message);
  await page.getByRole("button", { name: "Send report", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "There is already a case" })).toBeVisible();
  await expect(report.getByRole("list", { name: "Case timeline" }).getByRole("listitem")).toHaveCount(1);

  const reply = "The issue appears near the small text under the logo.";
  await report.getByLabel("Your reply").fill(reply);
  await report.getByRole("button", { name: "Send reply", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(report.getByRole("status")).toHaveText("Your reply was saved.");
  await expect(report.getByRole("list", { name: "Case timeline" })).toContainText(reply);
  await page.reload();
  await expect(report.getByRole("list", { name: "Case timeline" }).getByRole("listitem")).toHaveCount(2);
  await accessible(page);
});

test("credit planning explains sparse history, existing holds and the disabled demo budget", async ({ page }) => {
  await page.goto("/app/billing");
  const planning = page.getByRole("region", { name: "Credit planning" });
  await expect(planning).toBeVisible();
  await expect(planning).toContainText("midnight UTC");
  for (const label of ["Available now", "Active holds, all months", "Delivered this month", "Returned in the last 30 days"]) {
    await expect(planning.getByText(label, { exact: true })).toBeVisible();
  }
  await expect(planning.getByTestId("credit-projection")).toContainText("Insufficient history for a consumption estimate");
  await expect(planning).toContainText("Disabled. Your available balance and plan still apply.");
  await expect(planning).toContainText("Budget changes are unavailable in the demo.");
  await expect(planning.getByRole("button", { name: "Save credit budget" })).toHaveCount(0);
  const history = planning.getByRole("link").first();
  await expect(history).toHaveAttribute("href", "#credit-history");
  await history.focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#credit-history$/);
  await expect(page.locator("#credit-history")).toBeVisible();
  await accessible(page);
});

test("webhook setup stays inactive in the demo and explains the authenticated receiver contract", async ({ page }) => {
  const externalRequests: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).hostname !== "localhost") externalRequests.push(request.url());
  });
  await page.goto("/app/settings/webhooks");
  await expect(page.getByRole("heading", { name: "Completion webhooks", exact: true })).toBeVisible();
  await expect(page.getByRole("status")).toContainText("This demo sends no requests.");
  await expect(page.getByRole("button", { name: "Verify and activate" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Save disabled receiver" })).toHaveCount(0);
  const contract = page.getByRole("region", { name: "Receiver contract" });
  await expect(contract).toContainText("Deduplicate by event ID");
  await expect(contract).toContainText("your own authorized Curvi API key");
  await expect(contract).toContainText("Events contain no images, download links or credentials.");
  await expect(page.getByText(/normally checked every 10 minutes/)).toBeVisible();
  await expect(contract).toContainText("six times over 72 hours");
  await accessible(page);
  expect(externalRequests).toEqual([]);
});
