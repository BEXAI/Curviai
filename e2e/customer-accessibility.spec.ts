import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
for (const route of ["/app", "/app/new", "/app/products", "/app/library", "/help", "/gallery"]) {
  test(`${route} has no serious accessibility violations`, async ({ page }) => {
    await page.goto(route);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    // Next streams metadata separately from an async page body. Wait for the
    // accessible document name as well as its content before auditing it.
    await expect(page).toHaveTitle(/\S/);
    const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
    expect(result.violations.filter((violation) => violation.impact === "serious" || violation.impact === "critical")).toEqual([]);
  });
}
