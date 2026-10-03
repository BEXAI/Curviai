import { describe, expect, it, vi } from "vitest";
import { TOKEN_PATH_PREFIXES } from "../../src/lib/token-paths";
import { collectInventory, isPublicCandidateUrl, type HtmlInspection, type SitemapEntry } from "./inventory";

const BASE = "https://curvi.ai";
const HOME = `${BASE}/`;
const PRICING = `${BASE}/pricing`;
const GALLERY = `${BASE}/s/public-gallery-example`;
const publicInspection = (url: string): HtmlInspection => ({ canonicalUrls: [url], robots: [], meaningfulContent: "Stable public content", maintenance: false });

function setup(options: {
  entries?: SitemapEntry[];
  robots?: string;
  inspections?: Record<string, Partial<HtmlInspection>>;
  responses?: Record<string, () => Response>;
  xml?: string;
} = {}) {
  const fetcher = vi.fn<typeof fetch>(async (input) => {
    const url = String(input);
    if (options.responses?.[url]) return options.responses[url]!();
    if (url === `${BASE}/robots.txt`) return new Response(options.robots ?? "User-agent: *\nAllow: /\nDisallow: /app/\nDisallow: /api/", { headers: { "content-type": "text/plain; charset=utf-8" } });
    if (url === `${BASE}/sitemap.xml`) return new Response(options.xml ?? "<fixture/>", { headers: { "content-type": "application/xml" } });
    return new Response("<main>Public content</main>", { headers: { "content-type": "text/html" } });
  });
  const inspectHtml = vi.fn(async (_html: string, url: string): Promise<HtmlInspection> => ({ ...publicInspection(url), ...options.inspections?.[url] }));
  const parseSitemap = vi.fn(async () => options.entries ?? [{ url: HOME }, { url: PRICING }]);
  return { fetcher, inspectHtml, parseSitemap };
}

describe("public URL policy", () => {
  it.each(TOKEN_PATH_PREFIXES.filter((prefix) => prefix !== "/s/"))("rejects centralized bearer path %s before inventory use", (prefix) => {
    for (const path of [prefix, `${prefix}example-token`, prefix.toUpperCase()]) {
      expect(isPublicCandidateUrl(`${BASE}${path}`)).toBe(false);
    }
  });

  it.each(["/", "/pricing", "/signup", "/login", "/gallery", "/s/public-example", "/tools/store-image-audit", "/for/beauty", "/application"]) ("allows sitemap-eligible public path %s", (path) => {
    expect(isPublicCandidateUrl(`${BASE}${path}`)).toBe(true);
  });

  it.each([
    "http://curvi.ai/", "https://www.curvi.ai/", "https://evil.test/", "https://curvi.ai.evil.test/", "https://user:password@curvi.ai/",
    "https://curvi.ai:444/", "https://curvi.ai:443/", "https://CURVI.AI/", "https://curvi.ai", `${BASE}/?token=secret`, `${BASE}/#secret`, `${BASE}/?`,
    `${BASE}/app`, `${BASE}/app/`, `${BASE}/api`, `${BASE}/APP`, `${BASE}/auth/callback`, `${BASE}/oauth/consent`, `${BASE}/feedback/token`, `${BASE}/invite`, `${BASE}/invite/private-token`,
    `${BASE}/email/unsubscribe`, `${BASE}/r/token`, `${BASE}/monitoring`, `${BASE}/welcome`, `${BASE}/account-deleted`, `${BASE}/forgot-password`,
    `${BASE}/reset-password`, `${BASE}/password`, `${BASE}/forgot`, `${BASE}/reset`, `${BASE}/%61pp`, `${BASE}/foo%2fapp`, `${BASE}/foo%5capp`,
    `${BASE}/foo/../app`, `${BASE}/./pricing`, `${BASE}//api`, `${BASE}/%2e%2e/api`, `${BASE}/foo\\api`, `${BASE}/foo\napi`, `${BASE}/foo bar`,
  ])("rejects unsafe or private URL %s", (url) => {
    expect(isPublicCandidateUrl(url)).toBe(false);
  });
});

describe("public inventory", () => {
  it("returns stable SHA256 page observations and honest optional lastmod metadata", async () => {
    const dependencies = setup({ entries: [{ url: HOME }, { url: PRICING, lastmod: "2026-09-27" }, { url: GALLERY }] });
    const result = await collectInventory({ previousUrls: [], ...dependencies });
    expect(result.excluded).toEqual([]);
    expect(result.observations).toHaveLength(3);
    expect(result.observations[0]).toEqual({ url: HOME, kind: "page", fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(result.observations[1]?.lastmod).toBe("2026-09-27");
    for (const [url, init] of dependencies.fetcher.mock.calls) {
      expect(String(url).startsWith(`${BASE}/`)).toBe(true);
      expect(init).toMatchObject({ method: "GET", redirect: "error", credentials: "omit", cache: "no-store" });
      expect(init?.headers).toEqual(expect.objectContaining({ "user-agent": "CurviIndexNowBot/1.0 (+https://curvi.ai)" }));
      expect(init?.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it("does not fingerprint lastmod and changes only when parsed content changes", async () => {
    const first = await collectInventory({ previousUrls: [], ...setup({ entries: [{ url: HOME, lastmod: "2026-09-01" }] }) });
    const unchanged = await collectInventory({ previousUrls: [HOME], ...setup({ entries: [{ url: HOME, lastmod: "2026-10-01T12:30:00Z" }] }) });
    const changed = await collectInventory({ previousUrls: [HOME], ...setup({ entries: [{ url: HOME }], inspections: { [HOME]: { meaningfulContent: "Changed useful page content" } } }) });
    expect(first.observations[0]?.fingerprint).toBe(unchanged.observations[0]?.fingerprint);
    expect(first.observations[0]?.fingerprint).not.toBe(changed.observations[0]?.fingerprint);
  });

  it.each(["2026-02-30", "not-a-date", "2026-10-01T25:00:00Z", "2026-10-01T01:00:00", ""]) ("rejects invalid sitemap lastmod %s", async (lastmod) => {
    const dependencies = setup({ entries: [{ url: HOME, lastmod }] });
    await expect(collectInventory({ previousUrls: [], ...dependencies })).rejects.toThrow("lastmod");
    expect(dependencies.fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([
    [{ url: HOME }, { url: HOME }], [{ url: `${BASE}/api/private` }], [{ url: `${BASE}/invite/private-token` }], [{ url: `${BASE}/s/example?token=secret` }], [{ url: "https://elsewhere.test/" }],
  ])("fails closed before page requests on unsafe or duplicate sitemap entries", async (...entries) => {
    const dependencies = setup({ entries });
    await expect(collectInventory({ previousUrls: [], ...dependencies })).rejects.toThrow("unsafe or duplicate");
    expect(dependencies.fetcher).toHaveBeenCalledTimes(2);
  });

  it("rejects oversized inventories before requesting pages", async () => {
    const dependencies = setup({ entries: Array.from({ length: 1_001 }, (_, i) => ({ url: `${BASE}/help/page-${i}` })) });
    await expect(collectInventory({ previousUrls: [], ...dependencies })).rejects.toThrow("1000 URL");
    expect(dependencies.fetcher).toHaveBeenCalledTimes(2);
  });

  it("validates previous URLs before any fetch, without printing token-bearing input", async () => {
    const dependencies = setup();
    await expect(collectInventory({ previousUrls: [`${BASE}/api/private?token=do-not-print`], ...dependencies })).rejects.toThrow(/^Invalid previous public URL inventory$/);
    expect(dependencies.fetcher).not.toHaveBeenCalled();
  });

  it.each(["<!DOCTYPE urlset [<!ENTITY x SYSTEM 'file:///private'>]><urlset/>", "<!ENTITY x SYSTEM 'https://other.test/'>"]) ("rejects DTD or entity input before parser execution", async (xml) => {
    const dependencies = setup({ xml });
    await expect(collectInventory({ previousUrls: [], ...dependencies })).rejects.toThrow("Unsafe sitemap");
    expect(dependencies.parseSitemap).not.toHaveBeenCalled();
  });

  it("honors robots wildcard, terminal match, longest match and equal-length Allow", async () => {
    const entries = ["/pricing", "/pricing-pro", "/help/private-one", "/help/public", "/gallery"].map((path) => ({ url: `${BASE}${path}` }));
    const dependencies = setup({ entries, robots: "User-agent: *\nDisallow: /pricing$\nDisallow: /help/*\nAllow: /help/public\nDisallow: /gallery\nAllow: /gallery" });
    const result = await collectInventory({ previousUrls: [], ...dependencies });
    expect(result.observations.map(({ url }) => url)).toEqual([`${BASE}/pricing-pro`, `${BASE}/help/public`, `${BASE}/gallery`]);
    expect(result.excluded).toEqual([{ url: PRICING, reason: "robots-disallow" }, { url: `${BASE}/help/private-one`, reason: "robots-disallow" }]);
    expect(dependencies.fetcher.mock.calls.map(([url]) => url)).not.toContain(PRICING);
  });

  it("honors Bingbot-specific and inventory-agent-specific rules without merging wildcard rules", async () => {
    const dependencies = setup({ robots: "User-agent: *\nDisallow:\nUser-agent: Bingbot\nDisallow: /pricing\nUser-agent: CurviIndexNow\nDisallow: /$" });
    const result = await collectInventory({ previousUrls: [], ...dependencies });
    expect(result.observations).toEqual([]);
    expect(result.excluded).toHaveLength(2);
    expect(dependencies.fetcher).toHaveBeenCalledTimes(2);
  });

  it("combines matching groups and respects an Allow exception", async () => {
    const dependencies = setup({ robots: "User-agent: *\nDisallow: /\nUser-agent: Bingbot\nDisallow: /pricing\nUser-agent: Bingbot\nAllow: /pricing\nUser-agent: CurviIndexNow\nAllow: /" });
    const result = await collectInventory({ previousUrls: [], ...dependencies });
    expect(result.excluded).toEqual([]);
    expect(result.observations).toHaveLength(2);
  });

  it("matches repeated robots wildcards without exponential regular-expression backtracking", async () => {
    const url = `${BASE}/${"a".repeat(100)}`;
    const result = await collectInventory({ previousUrls: [], ...setup({ entries: [{ url }], robots: `User-agent: *\nDisallow: /${"a*".repeat(50)}b$` }) });
    expect(result.observations[0]?.url).toBe(url);
  });

  it.each(["User-agent: *\nDisallow: https://elsewhere.test/", "User-agent:\nDisallow: /", "User-agent: *\nDisallow: /%70ricing"]) ("aborts on unsupported robots directives", async (robots) => {
    await expect(collectInventory({ previousUrls: [], ...setup({ robots }) })).rejects.toThrow("robots.txt");
  });

  it.each(["noindex, nofollow", "NONE", "bingbot: noindex", "NOINDEX"]) ("excludes header directive %s without parsing the page", async (directive) => {
    const dependencies = setup({ entries: [{ url: HOME }], responses: { [HOME]: () => new Response("private", { headers: { "content-type": "text/html", "x-robots-tag": directive } }) } });
    expect(await collectInventory({ previousUrls: [HOME], ...dependencies })).toEqual({ observations: [], excluded: [{ url: HOME, reason: "header-noindex" }] });
    expect(dependencies.inspectHtml).not.toHaveBeenCalled();
  });

  it.each(["noindex", "none", "follow, NOINDEX"]) ("excludes meta directive %s", async (directive) => {
    const result = await collectInventory({ previousUrls: [], ...setup({ entries: [{ url: HOME }], inspections: { [HOME]: { robots: [directive] } } }) });
    expect(result.observations).toEqual([]);
    expect(result.excluded[0]?.reason).toBe("meta-noindex");
  });

  it.each([[], ["https://elsewhere.test/"], ["/pricing"], ["/?secret=value"], [HOME, HOME], [""]])("excludes nonexact or ambiguous canonicals", async (...canonicalUrls) => {
    const result = await collectInventory({ previousUrls: [], ...setup({ entries: [{ url: HOME }], inspections: { [HOME]: { canonicalUrls } } }) });
    expect(result.observations).toEqual([]);
    expect(result.excluded[0]?.reason).toBe("canonical-mismatch-or-missing");
  });

  it("resolves a single relative canonical against the page URL", async () => {
    const result = await collectInventory({ previousUrls: [], ...setup({ entries: [{ url: PRICING }], inspections: { [PRICING]: { canonicalUrls: ["/pricing"] } } }) });
    expect(result.observations[0]?.url).toBe(PRICING);
  });

  it("does not invent a fingerprint for an empty shell", async () => {
    const result = await collectInventory({ previousUrls: [], ...setup({ entries: [{ url: HOME }], inspections: { [HOME]: { meaningfulContent: "" } } }) });
    expect(result.excluded[0]?.reason).toBe("missing-main-content");
    expect(result.observations).toEqual([]);
  });

  it.each([404, 410])("records stable confirmed %i deletion only for previously public URLs", async (status) => {
    const responses = { [GALLERY]: () => new Response("Gone", { status }) };
    const deleted = await collectInventory({ previousUrls: [GALLERY], ...setup({ entries: [], responses }) });
    const repeated = await collectInventory({ previousUrls: [GALLERY], ...setup({ entries: [], responses }) });
    const new404 = await collectInventory({ previousUrls: [], ...setup({ entries: [{ url: GALLERY }], responses }) });
    expect(deleted.observations).toEqual([{ url: GALLERY, kind: "deleted", fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) }]);
    expect(repeated.observations).toEqual(deleted.observations);
    expect(new404.observations).toEqual([]);
    expect(new404.excluded[0]?.reason).toBe("not-found-without-public-history");
  });

  it("does not submit an unlisted surviving share as changed or deleted", async () => {
    const result = await collectInventory({ previousUrls: [GALLERY], ...setup({ entries: [] }) });
    expect(result).toEqual({ observations: [], excluded: [{ url: GALLERY, reason: "not-in-public-sitemap" }] });
  });

  it.each([404, 410])("recognizes a prior public deletion even when its %i response is noindex", async (status) => {
    const result = await collectInventory({ previousUrls: [GALLERY], ...setup({ entries: [], responses: {
      [GALLERY]: () => new Response("Gone", { status, headers: { "x-robots-tag": "noindex" } }),
    } }) });
    expect(result.observations).toEqual([{ url: GALLERY, kind: "deleted", fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) }]);
  });

  it("does not leak a robots-excluded previous URL through deletion detection", async () => {
    const dependencies = setup({ entries: [], robots: "User-agent: *\nDisallow: /s/", responses: { [GALLERY]: () => new Response("Gone", { status: 410 }) } });
    expect(await collectInventory({ previousUrls: [GALLERY], ...dependencies })).toEqual({ observations: [], excluded: [{ url: GALLERY, reason: "robots-disallow" }] });
    expect(dependencies.fetcher).toHaveBeenCalledTimes(2);
  });

  it("does not submit noindex previous pages as deletion", async () => {
    const result = await collectInventory({ previousUrls: [GALLERY], ...setup({ entries: [], inspections: { [GALLERY]: { robots: ["noindex"] } } }) });
    expect(result).toEqual({ observations: [], excluded: [{ url: GALLERY, reason: "meta-noindex" }] });
  });

  it.each([301, 302, 307, 308, 401, 403, 429, 500, 502, 503])("fails the whole scan on HTTP %i rather than returning partial deletions", async (status) => {
    const dependencies = setup({ entries: [{ url: HOME }], responses: { [GALLERY]: () => new Response("Unavailable", { status }) } });
    await expect(collectInventory({ previousUrls: [GALLERY], ...dependencies })).rejects.toThrow(`retrieval failed (${status})`);
  });

  it("propagates transport failure without manufacturing missing pages", async () => {
    const dependencies = setup();
    dependencies.fetcher.mockRejectedValueOnce(new Error("connection failed with private provider details"));
    await expect(collectInventory({ previousUrls: [HOME], ...dependencies })).rejects.toThrow(/^Public robots request failed or timed out; inventory not changed$/);
  });

  it("rejects a fetch implementation that followed a redirect", async () => {
    const response = new Response("<main>Foreign</main>", { headers: { "content-type": "text/html" } });
    Object.defineProperty(response, "url", { value: "https://foreign.test/" });
    await expect(collectInventory({ previousUrls: [], ...setup({ responses: { [HOME]: () => response } }) })).rejects.toThrow("retrieval failed");
  });

  it("rejects unexpected response content type", async () => {
    await expect(collectInventory({ previousUrls: [], ...setup({ responses: { [HOME]: () => new Response('{"private":"data"}', { headers: { "content-type": "application/json" } }) } }) })).rejects.toThrow("content type");
  });

  it("aborts maintenance responses even for URLs removed from the sitemap", async () => {
    await expect(collectInventory({ previousUrls: [GALLERY], ...setup({ entries: [], inspections: { [GALLERY]: { maintenance: true } } }) })).rejects.toThrow("maintenance");
  });

  it("rejects a body exceeding its limit even without Content-Length", async () => {
    const dependencies = setup({ responses: { [HOME]: () => new Response("a".repeat(2_000_001), { headers: { "content-type": "text/html" } }) } });
    await expect(collectInventory({ previousUrls: [], ...dependencies })).rejects.toThrow("byte limit");
    expect(dependencies.inspectHtml).not.toHaveBeenCalled();
  });

  it("checks Content-Length before reading a large body", async () => {
    const dependencies = setup({ responses: { [HOME]: () => new Response("small fixture", { headers: { "content-type": "text/html", "content-length": "9000000" } }) } });
    await expect(collectInventory({ previousUrls: [], ...dependencies })).rejects.toThrow("byte limit");
  });

  it("cancels rejected responses and hides transport exception contents", async () => {
    const cancel = vi.fn();
    const dependencies = setup({ responses: { [HOME]: () => new Response(new ReadableStream({ cancel }), { status: 503 }) } });
    await expect(collectInventory({ previousUrls: [], ...dependencies })).rejects.toThrow("retrieval failed (503)");
    expect(cancel).toHaveBeenCalledOnce();
  });

  it.each([404, 410])("does not expose underlying stream cancellation errors for %i", async (status) => {
    const dependencies = setup({ entries: [], responses: { [GALLERY]: () => new Response(new ReadableStream({ cancel: () => Promise.reject(new Error("private transport detail")) }), { status }) } });
    const result = await collectInventory({ previousUrls: [GALLERY], ...dependencies });
    expect(result.observations[0]?.kind).toBe("deleted");
  });

  it("does not expose underlying stream cancellation errors for noindex pages", async () => {
    const dependencies = setup({ entries: [{ url: HOME }], responses: { [HOME]: () => new Response(new ReadableStream({ cancel: () => Promise.reject(new Error("private transport detail")) }), { headers: { "content-type": "text/html", "x-robots-tag": "noindex" } }) } });
    const result = await collectInventory({ previousUrls: [], ...dependencies });
    expect(result.excluded).toEqual([{ url: HOME, reason: "header-noindex" }]);
  });

  it("bounds the combined current and previous public inventory", async () => {
    const previousUrls = Array.from({ length: 600 }, (_, i) => `${BASE}/old-${i}`);
    const dependencies = setup({ entries: Array.from({ length: 600 }, (_, i) => ({ url: `${BASE}/new-${i}` })) });
    await expect(collectInventory({ previousUrls, ...dependencies })).rejects.toThrow("Combined public inventory");
    expect(dependencies.fetcher).toHaveBeenCalledTimes(2);
  });

  it("stops the scan at the overall deadline instead of requesting more pages", async () => {
    const now = vi.spyOn(Date, "now");
    const dependencies = setup();
    dependencies.parseSitemap.mockImplementation(async () => {
      now.mockReturnValue(300_001);
      return [{ url: HOME }];
    });
    now.mockReturnValue(0);
    try {
      await expect(collectInventory({ previousUrls: [], ...dependencies })).rejects.toThrow("five minute scan limit");
      expect(dependencies.fetcher).toHaveBeenCalledTimes(2);
    } finally { now.mockRestore(); }
  });
});
