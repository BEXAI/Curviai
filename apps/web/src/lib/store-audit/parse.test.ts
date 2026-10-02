import { describe, expect, it } from "vitest";
import { storeAudit } from "@curvi/pipeline/seed";
import { storeAuditErrors } from "@/components/marketing/search-copy";
import { parseProductList, parseStoreAddress, productListUrl } from "./parse";
import fixture from "./products.fixture.json";

describe("parseStoreAddress", () => {
  it.each([
    ["yourstore.com", "https://yourstore.com"],
    ["  yourstore.com  ", "https://yourstore.com"],
    ["https://yourstore.com/collections/all?page=2#top", "https://yourstore.com"],
    ["http://yourstore.com", "https://yourstore.com"],
    ["HTTPS://Shop.Example.com/products/mug", "https://shop.example.com"],
    ["example-shop.myshopify.com", "https://example-shop.myshopify.com"],
  ])("reads %s as %s", (raw, origin) => {
    const result = parseStoreAddress(raw);
    expect(result.ok && result.origin.toString()).toBe(`${origin}/`);
  });

  it.each([
    ["", "invalid_store"],
    ["   ", "invalid_store"],
    ["not a store", "invalid_store"],
    ["ftp://yourstore.com", "invalid_store"],
    ["https://user:pass@yourstore.com", "invalid_store"],
    ["https://yourstore.com:8443", "invalid_store"],
    ["localhost", "blocked_host"],
    ["127.0.0.1", "blocked_host"],
    ["https://169.254.169.254/latest/meta-data", "blocked_host"],
    ["https://[::1]/", "blocked_host"],
    ["router.local", "blocked_host"],
    ["intranet", "blocked_host"],
    ["amazon.com", "amazon"],
    ["https://www.amazon.co.uk/stores/page/ABC", "amazon"],
  ])("refuses %s (%s) before any fetch", (raw, reason) => {
    const result = parseStoreAddress(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe(reason);
      expect(result.message).toBe(storeAuditErrors[result.reason]);
    }
  });

  it("refuses an address longer than the form allows", () => {
    expect(parseStoreAddress(`${"a".repeat(2050)}.com`).ok).toBe(false);
  });
});

describe("productListUrl", () => {
  it("asks for the seeded number of products", () => {
    expect(productListUrl(new URL("https://yourstore.com"), storeAudit.maxProducts).toString()).toBe(
      `https://yourstore.com/products.json?limit=${storeAudit.maxProducts}`,
    );
  });
});

describe("parseProductList", () => {
  const base = new URL("https://candles.example.com/products.json?limit=25");

  it("reads products, their first image by position and their image count", () => {
    const products = parseProductList(fixture, base, 25);
    expect(products).not.toBeNull();
    expect(products?.map((product) => product.title)).toEqual([
      "Amber & Oak Candle",
      "Fig Leaf Candle",
      "Gift Card",
      "Sea Salt Candle",
    ]);
    const [amber, fig, gift, sea] = products ?? [];
    expect(amber?.firstImage).toBe("https://cdn.shopify.com/s/files/1/0000/0001/files/amber-front.png?v=1");
    // A protocol relative src is read as https.
    expect(amber?.imageCount).toBe(3);
    expect(amber?.url).toBe("https://candles.example.com/products/amber-oak-candle");
    expect(fig?.imageCount).toBe(1);
    expect(gift?.firstImage).toBeNull();
    expect(gift?.imageCount).toBe(0);
    // A plain http image link is dropped; the https one stays (the fetch
    // still decides whether its host is public).
    expect(sea?.imageCount).toBe(1);
    expect(sea?.firstImage).toBe("https://internal.example/s/files/sea-front.png");
  });

  it("keeps at most the limit", () => {
    expect(parseProductList(fixture, base, 2)?.length).toBe(2);
  });

  it("returns null for anything that is not a product list", () => {
    for (const json of [null, "html", { product: {} }, { products: "nope" }, []]) {
      expect(parseProductList(json, base, 25)).toBeNull();
    }
  });

  it("encodes the handle in the product link", () => {
    const products = parseProductList({ products: [{ title: "Mug", handle: "mug/../../admin" }] }, base, 25);
    expect(products?.[0]?.url).toBe("https://candles.example.com/products/mug%2F..%2F..%2Fadmin");
  });
});
