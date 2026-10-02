import { expect, test } from "@playwright/test";

// P18-14 in demo mode: a published pack page gets share buttons whose links
// carry the network's UTM tags, and the page's Make mine link carries
// source=share, the share's slug and the landing tags through to /signup.

async function publishedSharePath(page: import("@playwright/test").Page, gallery = false): Promise<string> {
  await page.goto("/app/new");
  await page.getByRole("button", { name: "Create pack" }).click();
  await page.waitForURL(/\/app\/jobs\//, { timeout: 15_000 });
  await expect(page.getByTestId("job-status")).toHaveText("Done", { timeout: 45_000 });
  const panel = page.getByTestId("share-panel");
  await expect(panel).toBeVisible({ timeout: 30_000 });
  if (gallery) {
    await panel.getByTestId("share-gallery").check();
  }
  await panel.getByTestId("share-publish").click();
  await expect(panel.getByTestId("share-published")).toBeVisible();
  return panel.getByTestId("share-link").innerText();
}

test("share buttons tag each network and Make mine carries the slug to signup", async ({ page }) => {
  test.setTimeout(120_000);
  const path = await publishedSharePath(page);
  const slug = path.replace("/s/", "");

  const buttons = page.getByTestId("share-buttons");
  await expect(buttons).toBeVisible();
  const x = new URL((await buttons.getByTestId("share-x").getAttribute("href"))!);
  expect(`${x.origin}${x.pathname}`).toBe("https://x.com/intent/tweet");
  const shared = new URL(x.searchParams.get("url")!);
  expect(shared.pathname).toBe(path);
  expect(shared.searchParams.get("utm_source")).toBe("x");
  expect(shared.searchParams.get("utm_medium")).toBe("share");
  expect(shared.searchParams.get("utm_campaign")).toBe("pack_share");
  for (const network of ["linkedin", "pinterest", "reddit"]) {
    const href = (await buttons.getByTestId(`share-${network}`).getAttribute("href"))!;
    expect(href).toContain(encodeURIComponent(`utm_source=${network}`));
  }

  await page.goto(`${path}?utm_source=x&utm_medium=share&utm_campaign=pack_share`);
  const makeMine = page.getByRole("link", { name: "Make mine" });
  await expect(makeMine).toHaveAttribute("href", /utm_source=x/);
  const href = new URL((await makeMine.getAttribute("href"))!, "https://curvi.invalid");
  expect(href.pathname).toBe("/signup");
  expect(href.searchParams.get("source")).toBe("share");
  expect(href.searchParams.get("s")).toBe(slug);
  expect(href.searchParams.get("utm_campaign")).toBe("pack_share");

  await makeMine.click();
  await page.waitForURL(/\/signup\?/);
  const landed = new URL(page.url());
  expect(landed.searchParams.get("source")).toBe("share");
  expect(landed.searchParams.get("s")).toBe(slug);
});

test("the sitemap never lists a drawn demo share, even one in the gallery", async ({ page, request }) => {
  test.setTimeout(120_000);
  const path = await publishedSharePath(page, true);
  const body = await (await request.get("/sitemap.xml")).text();
  expect(body).toContain("<urlset");
  expect(body).not.toContain(path);
});

test("the pack page points to the share buttons", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/app/new");
  await page.getByRole("button", { name: "Create pack" }).click();
  await page.waitForURL(/\/app\/jobs\//, { timeout: 15_000 });
  await expect(page.getByTestId("job-status")).toHaveText("Done", { timeout: 45_000 });
  const hint = page.getByTestId("share-networks-hint");
  await expect(hint).toBeVisible({ timeout: 30_000 });
  await expect(hint.getByRole("link")).toHaveAttribute("href", "#share");
});
