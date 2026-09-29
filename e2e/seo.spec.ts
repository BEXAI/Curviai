import { expect, test } from "@playwright/test";

const guides = [
  { path: "/ai-product-images", h1: "AI product images for e-commerce that keep your real product" },
  { path: "/ai-ecommerce", h1: "AI for e-commerce product listings" },
  { path: "/compare/ai-image-generators", h1: "Curvi vs AI image generators for product photos" },
  { path: "/compare/ecommerce-photo-tools", h1: "Curvi and other e-commerce product photo tools" },
];

function jsonLdTypes(blocks: string[]): string[] {
  return blocks.flatMap((block) => {
    const data = JSON.parse(block) as { "@graph"?: { "@type": string }[] };
    return (data["@graph"] ?? []).map((node) => node["@type"]);
  });
}

for (const guide of guides) {
  test(`${guide.path} renders its H1, summary and structured data`, async ({ page }) => {
    const response = await page.goto(guide.path);
    expect(response?.status()).toBe(200);
    await expect(page.getByRole("heading", { level: 1, name: guide.h1 })).toBeVisible();
    await expect(page.getByTestId("pillar-summary")).not.toBeEmpty();
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", new RegExp(`${guide.path}$`));
    await expect(page.locator('meta[property="og:image"]').first()).toHaveAttribute("content", /opengraph-image/);
    const types = jsonLdTypes(await page.locator('script[type="application/ld+json"]').allTextContents());
    expect(types).toEqual(expect.arrayContaining(["WebPage", "BreadcrumbList", "FAQPage"]));
    await expect(page.locator("main").getByRole("link", { name: "Start free" }).first()).toHaveAttribute(
      "href",
      "/signup",
    );
  });
}

test("the footer links every guide", async ({ page }) => {
  await page.goto("/");
  const footer = page.locator("footer");
  for (const guide of guides) {
    await expect(footer.locator(`a[href="${guide.path}"]`)).toHaveCount(1);
  }
});

test("llms.txt lists the guides and llms-full.txt carries their text", async ({ request }) => {
  const short = await request.get("/llms.txt");
  expect(short.status()).toBe(200);
  const shortText = await short.text();
  const full = await request.get("/llms-full.txt");
  expect(full.status()).toBe(200);
  const fullText = await full.text();
  for (const guide of guides) {
    expect(shortText).toContain(guide.path);
    expect(fullText).toContain(`## ${guide.h1}`);
  }
});

test("the sitemap lists the guides", async ({ request }) => {
  const body = await (await request.get("/sitemap.xml")).text();
  for (const guide of guides) {
    expect(body).toContain(`https://curvi.ai${guide.path}</loc>`);
  }
});
