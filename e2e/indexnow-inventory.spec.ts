import { createServer, type Server } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { test, expect } from "@playwright/test";
import { collectInventory, createOfflineParsers } from "../apps/web/scripts/indexnow/inventory";

const HOME = "https://curvi.ai/";
let parsers: Awaited<ReturnType<typeof createOfflineParsers>>;

test.beforeAll(async () => { parsers = await createOfflineParsers(); });
test.afterAll(async () => { await parsers?.close(); });

test("works through the actual tsx CLI runtime without serializing missing build helpers", async () => {
  const modulePath = resolve("apps/web/scripts/indexnow/inventory.ts");
  const script = `import { createOfflineParsers } from ${JSON.stringify(modulePath)};
const parsers = await createOfflineParsers();
try {
  const parsed = await parsers.inspectHtml('<html><head><title>Curvi</title><link rel="canonical" href="/"></head><body><main><h1>Public product information</h1><p>Visible static description.</p></main></body></html>', 'https://curvi.ai/');
  if (!parsed.meaningfulContent || parsed.canonicalUrls[0] !== 'https://curvi.ai/') throw new Error('Offline parser failed');
  process.stdout.write('offline-runtime-ok');
} finally { await parsers.close(); }`;
  const result = await promisify(execFile)(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], { timeout: 20_000 });
  expect(result.stdout).toBe("offline-runtime-ok");
});

function page(content: string, options: { head?: string; header?: string; script?: string; footer?: string } = {}) {
  return `<!doctype html><html><head><title>Curvi product photos</title><meta name="description" content="Public product images"><link rel="canonical" href="/"><link rel="stylesheet" href="/_next/static/style-BUILD.css">${options.head ?? ""}</head><body><header>${options.header ?? "Site navigation"}</header><main>${content}</main><footer>${options.footer ?? "Site footer"}</footer><script>${options.script ?? "globalThis.buildId = 'BUILD'"}</script></body></html>`;
}

function xml(entries: string) {
  return `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${entries}</urlset>`;
}

test("strictly parses a sitemap, namespaces and genuine content date metadata", async () => {
  await expect(parsers.parseSitemap(xml("<url><loc>https://curvi.ai/</loc><lastmod>2026-09-27</lastmod></url><url><loc>https://curvi.ai/login</loc></url>"))).resolves.toEqual([{ url: HOME, lastmod: "2026-09-27" }, { url: "https://curvi.ai/login" }]);
  await expect(parsers.parseSitemap('<sm:urlset xmlns:sm="http://www.sitemaps.org/schemas/sitemap/0.9"><sm:url><sm:loc>https://curvi.ai/signup</sm:loc></sm:url></sm:urlset>')).resolves.toEqual([{ url: "https://curvi.ai/signup" }]);
});

test("rejects malformed XML, indexes, DTD, unsafe URLs, duplicates and invalid dates", async () => {
  const invalid = [
    xml("<url><loc>https://curvi.ai/</url>"),
    '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></sitemapindex>',
    '<urlset><url><loc>https://curvi.ai/</loc></url></urlset>',
    '<!DOCTYPE urlset [<!ENTITY private SYSTEM "file:///private">]>' + xml("<url><loc>&private;</loc></url>"),
    xml("<url><loc>https://foreign.test/</loc></url>"),
    xml("<url><loc>https://curvi.ai/api/private</loc></url>"),
    xml("<url><loc>https://curvi.ai/?token=one&amp;secret=two</loc></url>"),
    xml("<url><loc>https://curvi.ai/</loc></url><url><loc>https://curvi.ai/</loc></url>"),
    xml("<url><loc>https://curvi.ai/</loc><loc>https://curvi.ai/pricing</loc></url>"),
    xml("<url><loc>https://curvi.ai/</loc><lastmod>2026-02-30</lastmod></url>"),
    xml("<url><loc><nested>https://curvi.ai/</nested></loc></url>"),
    xml("<url><loc>https://curvi.ai/</loc><unknown>extra</unknown></url>"),
    xml("<url><loc>&undefined;</loc></url>"),
  ];
  for (const source of invalid) await expect(parsers.parseSitemap(source)).rejects.toThrow();
  await expect(parsers.parseSitemap(xml(Array.from({ length: 1_001 }, (_, i) => `<url><loc>https://curvi.ai/help/${i}</loc></url>`).join("")))).rejects.toThrow("1000 URL");
  await expect(parsers.parseSitemap(" ".repeat(1_000_001))).rejects.toThrow("oversized");
});

test("DOM parsing resolves HTML entities and case-insensitive canonical/robot attributes", async () => {
  const inspection = await parsers.inspectHtml('<html><head><title>A &amp; B</title><LINK href="/" REL="alternate CANONICAL"><META content="NOINDEX, follow" NAME="BINGBOT"><meta name="description" content="A &quot;great&quot; photo"></head><body><main><h1>A &amp; B</h1><p>Useful &#112;roduct information.</p><img alt="A &amp; B" src="/product.png"><a href="/pricing">Prices &amp; plans</a></main></body></html>', HOME);
  expect(inspection.canonicalUrls).toEqual([HOME]);
  expect(inspection.robots).toEqual(["NOINDEX, follow"]);
  const content = JSON.parse(inspection.meaningfulContent);
  expect(content.title).toBe("A & B");
  expect(content.description).toEqual(['A "great" photo']);
  expect(content.text).toContain("Useful product information.");
  expect(content.images).toEqual([{ src: "https://curvi.ai/product.png", alt: "A & B" }]);
});

test("uses the HTML base URL when resolving a relative canonical", async () => {
  const inspected = await parsers.inspectHtml(page("<h1>Public content</h1>", { head: '<base href="https://foreign.test/">' }), HOME);
  expect(inspected.canonicalUrls).toEqual(["https://foreign.test/"]);
});

test("meaningful fingerprints ignore asset builds and generated metadata but detect content updates", async () => {
  const original = page('<h1>Product photos</h1><p>Keep your product intact.</p><img src="/_next/image?url=%2Fproduct.png&amp;w=1200&amp;q=75" alt="Blue bottle"><a href="/pricing?utm_source=one">Pricing</a>', { head: '<script type="application/ld+json">{"@type":"Article","headline":"Product photos","dateModified":"2026-09-01"}</script>' });
  const rebuilt = page('<h1>Product photos</h1><p>Keep your product intact.</p><img src="/_next/image?url=%2Fproduct.png&amp;w=1600&amp;q=90" alt="Blue bottle"><a href="/pricing?utm_source=two">Pricing</a>', { header: "Navigation regenerated at 2026-10-03", footer: "Footer deployment BUILD2", script: "globalThis.buildId = 'BUILD2'", head: '<script type="application/ld+json">{"dateModified":"2026-10-03","headline":"Product photos","@type":"Article"}</script>' }).replace("style-BUILD.css", "style-BUILD2.css");
  const fingerprint = async (html: string) => {
    const result = await collectInventory({
      previousUrls: [], ...parsers,
      fetcher: async (input) => {
        if (String(input).endsWith("robots.txt")) return new Response("User-agent: *\nAllow: /", { headers: { "content-type": "text/plain" } });
        if (String(input).endsWith("sitemap.xml")) return new Response(xml("<url><loc>https://curvi.ai/</loc></url>"), { headers: { "content-type": "application/xml" } });
        return new Response(html, { headers: { "content-type": "text/html" } });
      },
    });
    return result.observations[0]?.fingerprint;
  };
  expect(await fingerprint(original)).toMatch(/^[a-f0-9]{64}$/);
  expect(await fingerprint(rebuilt)).toBe(await fingerprint(original));
  expect(await fingerprint(original.replace("Keep your product intact.", "Export a complete marketplace pack."))).not.toBe(await fingerprint(original));
  expect(await fingerprint(original.replace("Blue bottle", "Red bottle"))).not.toBe(await fingerprint(original));
  expect(await fingerprint(original.replace("product.png", "new-product.png"))).not.toBe(await fingerprint(original));
  expect(await fingerprint(original.replace('"headline":"Product photos"', '"headline":"A product tutorial"'))).not.toBe(await fingerprint(original));
});

test("parsing neither executes scripts nor requests HTML images, frames or stylesheet resources", async () => {
  let requestCount = 0;
  const server: Server = createServer((_request, response) => { requestCount += 1; response.end("unexpected request"); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing local fixture address");
  const local = `http://127.0.0.1:${address.port}`;
  try {
    const inspected = await parsers.inspectHtml(page(`<h1>Public content</h1><p>A static product description.</p><img src="${local}/image" onerror="document.title='executed'"><iframe src="${local}/frame"></iframe>`, { head: `<link rel="stylesheet" href="${local}/style">`, script: `document.title='executed'; fetch('${local}/script');` }), HOME);
    expect(JSON.parse(inspected.meaningfulContent).title).toBe("Curvi product photos");
    expect(requestCount).toBe(0);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("keeps noindex and maintenance visible while rejecting empty shells", async () => {
  const noindex = await parsers.inspectHtml(page("<h1>Private result</h1>", { head: '<meta name="robots" content="noindex">' }), HOME);
  expect(noindex.robots).toEqual(["noindex"]);
  expect((await parsers.inspectHtml('<html><head><title>Maintenance</title></head><body><main>Service temporarily unavailable.</main></body></html>', HOME)).maintenance).toBe(true);
  expect((await parsers.inspectHtml('<html><head><title>Curvi</title></head><body><script>renderEverything()</script></body></html>', HOME)).meaningfulContent).toBe("");
  const hidden = await parsers.inspectHtml(page('<h1>Visible heading</h1><p hidden>Hidden private text</p><script>privateCode()</script><style>body {color:red}</style>'), HOME);
  expect(hidden.meaningfulContent).not.toContain("private");
});
