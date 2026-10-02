import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { storeAudit } from "@curvi/pipeline/seed";
import { mainImagePng } from "@/lib/api-v1/test-fixtures";
import { checkerChannelFor } from "@/lib/tools/checker-rules";
import { IMAGE_MAX_BYTES } from "@/lib/upload-validation";
import type { ImportFetcher } from "@/lib/url-import/import-product";
import {
  ImportFetchError,
  safeFetch,
  type RawResponse,
  type Resolver,
  type SafeFetchOptions,
  type SafeFetchResult,
  type Transport,
} from "@/lib/url-import/safe-fetch";
import { runStoreAudit } from "./audit";
import fixture from "./products.fixture.json";

const STORE = new URL("https://candles.example.com/");
const LIST_URL = `https://candles.example.com/products.json?limit=${storeAudit.maxProducts}`;
const AMBER = "https://cdn.shopify.com/s/files/1/0000/0001/files/amber-front.png?v=1";
const FIG = "https://cdn.shopify.com/s/files/1/0000/0001/files/fig-front.png?v=1";

const amazon = checkerChannelFor("amazon");
const google = checkerChannelFor("google");

type Reply = { status: number; body?: Buffer; contentType?: string };

/** A fetcher that answers from a table and records every call. */
function tableFetcher(
  routes: Record<string, Reply | (() => Promise<Reply>)>,
  calls: { url: string; options: SafeFetchOptions }[] = [],
): ImportFetcher {
  return async (url, options) => {
    const href = url.toString();
    calls.push({ url: href, options });
    const route = routes[href];
    const reply = typeof route === "function" ? await route() : (route ?? { status: 404 });
    return {
      status: reply.status,
      contentType: reply.contentType ?? "",
      body: reply.body ?? Buffer.alloc(0),
      url: new URL(href),
    } satisfies SafeFetchResult;
  };
}

function json(value: unknown): Reply {
  return { status: 200, contentType: "application/json", body: Buffer.from(JSON.stringify(value)) };
}

describe("runStoreAudit", () => {
  it("checks each first image against the channel and counts failing, thin and skipped products", async () => {
    const good = await mainImagePng(2000, 0.87);
    const small = await mainImagePng(1200, 0.5);
    // The real SSRF guard with a fake network: internal.example resolves to
    // a private address, so its image is refused before any connection.
    const dns: Record<string, { address: string; family: number }[]> = {
      "candles.example.com": [{ address: "93.184.216.34", family: 4 }],
      "cdn.shopify.com": [{ address: "93.184.216.35", family: 4 }],
      "internal.example": [{ address: "10.0.0.5", family: 4 }],
    };
    const resolver: Resolver = async (hostname) => dns[hostname] ?? [];
    const connected: string[] = [];
    const bodies: Record<string, Buffer> = {
      [LIST_URL]: Buffer.from(JSON.stringify(fixture)),
      [AMBER]: good,
      [FIG]: small,
    };
    const transport: Transport = async (url, init) => {
      await new Promise<void>((resolve, reject) =>
        init.lookup(url.hostname, { all: true }, (err) => (err ? reject(err) : resolve())),
      );
      connected.push(url.hostname);
      const body = bodies[url.toString()];
      return {
        status: body ? 200 : 404,
        headers: {},
        body: Readable.from(body ? [body] : []),
      } satisfies RawResponse;
    };
    const fetcher: ImportFetcher = (url, options) => safeFetch(url, { ...options, resolver, transport });

    const outcome = await runStoreAudit(STORE, amazon, { fetcher });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const { report } = outcome;
    expect(report.store).toBe("candles.example.com");
    expect(report.channel).toEqual({ key: "amazon", name: amazon.name });
    expect(report.products.map((product) => product.result.status)).toEqual([
      "checked",
      "checked",
      "no_image",
      "not_checked",
    ]);
    const [amber, fig, , sea] = report.products;
    expect(amber?.result).toMatchObject({ status: "checked", pass: true, width: 2000, height: 2000 });
    expect(fig?.result).toMatchObject({ status: "checked", pass: false, width: 1200 });
    expect(sea?.result).toEqual({ status: "not_checked", reason: "blocked_host" });
    expect(report.summary).toEqual({
      listed: 4,
      checked: 2,
      failing: 1,
      thin: 3,
      notChecked: 1,
      thinImageCount: storeAudit.thinImageCount,
    });
    expect(connected).not.toContain("internal.example");
  });

  it("fetches every image with the seeded deadline and the upload byte cap", async () => {
    const calls: { url: string; options: SafeFetchOptions }[] = [];
    const good = await mainImagePng(2000, 0.87);
    const fetcher = tableFetcher({ [LIST_URL]: json(fixture), [AMBER]: { status: 200, body: good }, [FIG]: { status: 200, body: good } }, calls);
    await runStoreAudit(STORE, amazon, { fetcher });
    const list = calls.find((call) => call.url === LIST_URL);
    expect(list?.options).toMatchObject({
      maxBytes: storeAudit.productListMaxBytes,
      timeoutMs: storeAudit.productListTimeoutMs,
    });
    const images = calls.filter((call) => call.url !== LIST_URL);
    expect(images.length).toBeGreaterThan(0);
    for (const call of images) {
      expect(call.options.timeoutMs).toBe(storeAudit.imageTimeoutMs);
      expect(call.options.maxBytes).toBe(IMAGE_MAX_BYTES);
    }
  });

  it("reports an image over the byte cap, or not an image, as not checked", async () => {
    const fetcher: ImportFetcher = async (url, options) => {
      if (url.toString() === AMBER) {
        throw new ImportFetchError("too_large", "The response is too large.");
      }
      return tableFetcher({ [LIST_URL]: json(fixture), [FIG]: { status: 200, body: Buffer.from("<html>") } })(url, options);
    };
    const outcome = await runStoreAudit(STORE, amazon, { fetcher });
    expect(outcome.ok && outcome.report.products[0]?.result).toEqual({ status: "not_checked", reason: "too_large" });
    expect(outcome.ok && outcome.report.products[1]?.result).toEqual({ status: "not_checked", reason: "not_image" });
    expect(outcome.ok && outcome.report.summary.checked).toBe(0);
  });

  it("applies the picked channel's rules", async () => {
    // 80 percent fill: inside Google's range, under Amazon's minimum.
    const eighty = await mainImagePng(2000, 0.8);
    const routes = { [LIST_URL]: json({ products: [fixture.products[1]] }), [FIG]: { status: 200, body: eighty } };
    const onAmazon = await runStoreAudit(STORE, amazon, { fetcher: tableFetcher(routes) });
    const onGoogle = await runStoreAudit(STORE, google, { fetcher: tableFetcher(routes) });
    expect(onAmazon.ok && onAmazon.report.summary.failing).toBe(1);
    expect(onGoogle.ok && onGoogle.report.summary.failing).toBe(0);
  });

  it.each([
    [{ status: 404 }, "not_shopify"],
    [{ status: 401 }, "not_shopify"],
    [{ status: 200, body: Buffer.from("<html>Enter store password</html>") }, "not_shopify"],
    [json({ products: [] }), "no_products"],
    [{ status: 429 }, "store_busy"],
    [{ status: 503 }, "unreachable"],
  ] as [Reply, string][])("answers a product list of %o with %s", async (reply, reason) => {
    const outcome = await runStoreAudit(STORE, amazon, { fetcher: tableFetcher({ [LIST_URL]: reply }) });
    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.reason).toBe(reason);
  });

  it.each([
    ["timeout", "timeout"],
    ["too_large", "too_large"],
    ["blocked_host", "blocked_host"],
    ["too_many_redirects", "unreachable"],
    ["network", "unreachable"],
  ] as const)("answers a product list fetch that fails with %s as %s", async (fetchReason, reason) => {
    const fetcher: ImportFetcher = async () => {
      throw new ImportFetchError(fetchReason, "failed");
    };
    const outcome = await runStoreAudit(STORE, amazon, { fetcher });
    expect(!outcome.ok && outcome.reason).toBe(reason);
  });

  it("stops at the audit deadline and reports what it did not reach", async () => {
    const never = () => new Promise<Reply>(() => undefined);
    const fetcher = tableFetcher({ [LIST_URL]: json(fixture), [AMBER]: never, [FIG]: never });
    const started = Date.now();
    const outcome = await runStoreAudit(STORE, amazon, { fetcher, limits: { auditDeadlineMs: 80 } });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.report.products[0]?.result).toEqual({ status: "not_checked", reason: "deadline" });
    expect(outcome.report.summary.checked).toBe(0);
  });

  it("keeps at most the seeded number of downloads in flight", async () => {
    const good = await mainImagePng(400, 0.87);
    const products = Array.from({ length: 10 }, (_, index) => ({
      title: `Product ${index}`,
      handle: `product-${index}`,
      images: [{ src: `https://cdn.shopify.com/p${index}.png`, position: 1 }],
    }));
    let inFlight = 0;
    let peak = 0;
    const routes: Record<string, Reply | (() => Promise<Reply>)> = { [LIST_URL]: json({ products }) };
    for (let index = 0; index < 10; index += 1) {
      routes[`https://cdn.shopify.com/p${index}.png`] = async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        return { status: 200, body: good };
      };
    }
    const outcome = await runStoreAudit(STORE, amazon, { fetcher: tableFetcher(routes), limits: { imageConcurrency: 3 } });
    expect(outcome.ok && outcome.report.summary.checked).toBe(10);
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1);
  });
});
