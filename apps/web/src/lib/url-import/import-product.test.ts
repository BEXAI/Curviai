import { describe, expect, it, vi } from "vitest";
import { importProduct, type ImportFetcher } from "./import-product";
import { amazonSlugTitle, parseProductUrl } from "./product-url";
import { ImportFetchError, type SafeFetchResult } from "./safe-fetch";

function reply(url: string | URL, status: number, body: string, finalUrl?: string): SafeFetchResult {
  return { status, contentType: "", body: Buffer.from(body), url: new URL(finalUrl ?? url.toString()) };
}

function fetcherFrom(routes: Record<string, (url: string | URL) => SafeFetchResult | Promise<SafeFetchResult>>) {
  return vi.fn<ImportFetcher>(async (url) => {
    const route = routes[url.toString()];
    if (!route) {
      return reply(url, 404, "");
    }
    return route(url);
  });
}

const SHOP_JSON = JSON.stringify({
  product: {
    title: "Linen Apron",
    body_html: "<ul><li>Stone washed</li><li>Two pockets</li></ul>",
    images: [{ src: "https://cdn.shopify.com/apron.jpg", position: 1, width: 1200, height: 1500 }],
  },
});

describe("parseProductUrl", () => {
  it("reads Shopify links, including collection paths and custom domains", () => {
    const direct = parseProductUrl("https://store.example.com/products/linen-apron?variant=1#top");
    expect(direct.ok && direct.target.platform === "shopify" && direct.target.jsonUrl.toString()).toBe(
      "https://store.example.com/products/linen-apron.json",
    );
    const nested = parseProductUrl("https://shop.myshopify.com/collections/all/products/linen-apron");
    expect(nested.ok && nested.target.platform === "shopify" && nested.target.handle).toBe("linen-apron");
    const alreadyJson = parseProductUrl("https://shop.example.com/products/linen-apron.json");
    expect(alreadyJson.ok && alreadyJson.target.platform === "shopify" && alreadyJson.target.handle).toBe("linen-apron");
  });

  it("reads Amazon links, with or without https, down to the bare /dp/ page", () => {
    const parsed = parseProductUrl("www.amazon.co.uk/Blue-Kettle-1-7L/dp/b0abcdefgh/ref=sr_1_1?keywords=kettle");
    expect(parsed.ok).toBe(true);
    if (parsed.ok && parsed.target.platform === "amazon") {
      expect(parsed.target.asin).toBe("B0ABCDEFGH");
      expect(parsed.target.pageUrl.toString()).toBe("https://www.amazon.co.uk/dp/B0ABCDEFGH");
      expect(parsed.target.slugTitle).toBe("Blue Kettle 1 7L");
    }
    const gp = parseProductUrl("https://www.amazon.com/gp/product/B07FZ8S74R");
    expect(gp.ok && gp.target.platform === "amazon" && gp.target.asin).toBe("B07FZ8S74R");
  });

  it("refuses http, private hosts, and links that are not a product", () => {
    expect(parseProductUrl("http://store.example.com/products/a")).toMatchObject({ ok: false, reason: "invalid_url" });
    expect(parseProductUrl("https://127.0.0.1/products/a")).toMatchObject({ ok: false, reason: "blocked_host" });
    expect(parseProductUrl("https://localhost/products/a")).toMatchObject({ ok: false, reason: "blocked_host" });
    expect(parseProductUrl("https://store.example.com/about")).toMatchObject({ ok: false, reason: "unsupported" });
    expect(parseProductUrl("https://www.amazon.com/s?k=kettle")).toMatchObject({ ok: false, reason: "unsupported" });
    expect(parseProductUrl("javascript:alert(1)")).toMatchObject({ ok: false, reason: "invalid_url" });
  });

  it("reads a name from an Amazon slug only when it looks like one", () => {
    expect(amazonSlugTitle("/Echo-Dot-3rd-Gen/dp/B07FZ8S74R")).toBe("Echo Dot 3rd Gen");
    expect(amazonSlugTitle("/dp/B07FZ8S74R")).toBeNull();
    expect(amazonSlugTitle("/%E0%A4%A/dp/B07FZ8S74R")).toBeNull();
  });
});

describe("importProduct", () => {
  it("imports a Shopify product from its JSON", async () => {
    const fetcher = fetcherFrom({
      "https://store.example.com/products/linen-apron.json": (url) => reply(url, 200, SHOP_JSON),
    });
    const result = await importProduct("https://store.example.com/products/linen-apron", { fetcher });
    expect(result).toEqual({
      ok: true,
      product: {
        platform: "shopify",
        sourceUrl: "https://store.example.com/products/linen-apron",
        title: "Linen Apron",
        description: "Stone washed\nTwo pockets",
        bullets: ["Stone washed", "Two pockets"],
        images: [{ url: "https://cdn.shopify.com/apron.jpg", width: 1200, height: 1500 }],
        partial: false,
      },
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ accept: "application/json" });
  });

  it("falls back to Open Graph tags when the store has no product JSON", async () => {
    const fetcher = fetcherFrom({
      "https://store.example.com/products/linen-apron": (url) =>
        reply(url, 200, `<meta property="og:title" content="Apron"><meta property="og:image" content="https://cdn.example.com/a.jpg">`),
    });
    const result = await importProduct("https://store.example.com/products/linen-apron", { fetcher });
    expect(result.ok && result.product.platform).toBe("page");
    expect(result.ok && result.product.partial).toBe(true);
    expect(result.ok && result.product.images).toEqual([{ url: "https://cdn.example.com/a.jpg" }]);
  });

  it("says not found when neither the JSON nor the page has a product", async () => {
    const fetcher = fetcherFrom({});
    expect(await importProduct("https://store.example.com/products/gone", { fetcher })).toMatchObject({
      ok: false,
      reason: "not_found",
    });
  });

  it("stops at a blocked host without trying the page", async () => {
    const fetcher = vi.fn<ImportFetcher>(async () => {
      throw new ImportFetchError("blocked_host", "no");
    });
    expect(await importProduct("https://store.example.com/products/a", { fetcher })).toMatchObject({
      ok: false,
      reason: "blocked_host",
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("reports a timeout plainly", async () => {
    const fetcher = vi.fn<ImportFetcher>(async () => {
      throw new ImportFetchError("timeout", "slow");
    });
    const result = await importProduct("https://store.example.com/products/a", { fetcher });
    expect(result).toMatchObject({ ok: false, reason: "timeout" });
  });

  it("imports an Amazon product page", async () => {
    const html = `<span id="productTitle"> Blue Kettle </span><img id="landingImage" data-old-hires="https://m.media-amazon.com/k.jpg">`;
    const fetcher = fetcherFrom({ "https://www.amazon.com/dp/B0ABCDEFGH": (url) => reply(url, 200, html) });
    const result = await importProduct("https://www.amazon.com/Blue-Kettle/dp/B0ABCDEFGH", { fetcher });
    expect(result).toMatchObject({
      ok: true,
      product: { platform: "amazon", title: "Blue Kettle", images: [{ url: "https://m.media-amazon.com/k.jpg" }], partial: false },
    });
  });

  it("degrades to the name in the link when Amazon shows its robot check", async () => {
    const captcha = `<form action="/errors/validateCaptcha"></form>`;
    const fetcher = fetcherFrom({ "https://www.amazon.com/dp/B0ABCDEFGH": (url) => reply(url, 200, captcha) });
    const withSlug = await importProduct("https://www.amazon.com/Blue-Kettle/dp/B0ABCDEFGH", { fetcher });
    expect(withSlug).toMatchObject({ ok: true, product: { title: "Blue Kettle", images: [], partial: true } });
    expect(withSlug.ok && withSlug.product.notice).toMatch(/Amazon would not show us that page/);
    const bare = await importProduct("https://www.amazon.com/dp/B0ABCDEFGH", { fetcher });
    expect(bare).toMatchObject({ ok: false, reason: "blocked" });
  });

  it("degrades the same way when Amazon times out or redirects off Amazon", async () => {
    const slow = vi.fn<ImportFetcher>(async () => {
      throw new ImportFetchError("timeout", "slow");
    });
    expect(await importProduct("https://www.amazon.com/Blue-Kettle/dp/B0ABCDEFGH", { fetcher: slow })).toMatchObject({
      ok: true,
      product: { partial: true },
    });
    const away = fetcherFrom({
      "https://www.amazon.com/dp/B0ABCDEFGH": (url) =>
        reply(url, 200, `<span id="productTitle">Fake</span>`, "https://elsewhere.example.com/"),
    });
    expect(await importProduct("https://www.amazon.com/Blue-Kettle/dp/B0ABCDEFGH", { fetcher: away })).toMatchObject({
      ok: true,
      product: { title: "Blue Kettle", partial: true },
    });
  });

  it("never fetches a link that fails the URL checks", async () => {
    const fetcher = fetcherFrom({});
    for (const url of ["http://store.example.com/products/a", "https://10.0.0.1/products/a", "https://store.example.com/"]) {
      const result = await importProduct(url, { fetcher });
      expect(result.ok).toBe(false);
    }
    expect(fetcher).not.toHaveBeenCalled();
  });
});
