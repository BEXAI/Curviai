import { createHash } from "node:crypto";
import type { Browser } from "@playwright/test";
import { tokenPathPrefix } from "../../src/lib/token-paths";

const ORIGIN = "https://curvi.ai";
const MAX_URLS = 1_000;
const MAX_XML_BYTES = 1_000_000;
const MAX_HTML_BYTES = 2_000_000;
const USER_AGENT = "CurviIndexNowBot/1.0 (+https://curvi.ai)";
const MAX_SCAN_MS = 5 * 60_000;
const DELETED_FINGERPRINT = createHash("sha256").update("curvi-indexnow:deleted:v1").digest("hex");

export type Observation = { url: string; kind: "page" | "deleted"; fingerprint: string; lastmod?: string };
export type Inventory = { observations: Observation[]; excluded: Array<{ url: string; reason: string }> };
export type SitemapEntry = { url: string; lastmod?: string };
export type HtmlInspection = {
  canonicalUrls: string[];
  robots: string[];
  meaningfulContent: string;
  maintenance: boolean;
};
export type InventoryOptions = {
  previousUrls: readonly string[];
  fetcher?: typeof fetch;
  inspectHtml?: (html: string, url: string) => Promise<HtmlInspection>;
  parseSitemap?: (xml: string) => Promise<SitemapEntry[]>;
};

/** A deliberately narrower policy than URL() accepts; never repair an unsafe URL. */
export function isPublicCandidateUrl(value: string): boolean {
  if (value.length > 2_048 || !/^https:\/\/curvi\.ai\/[A-Za-z0-9_/.~-]*$/.test(value)) return false;
  try {
    const url = new URL(value);
    if (url.href !== value || url.origin !== ORIGIN || url.search || url.hash || url.username || url.password) return false;
    if (url.pathname.includes("//") || url.pathname.split("/").some((part) => part === "." || part === "..")) return false;
    const pathname = url.pathname.toLowerCase();
    const tokenPrefix = tokenPathPrefix(pathname);
    // A share is eligible only through the owner-approved public sitemap and
    // the canonical/indexability checks below. Other known bearer paths never
    // reach a request, the state file, or command output.
    if (tokenPrefix !== null && tokenPrefix !== "/s/") return false;
    const root = pathname.split("/")[1]!;
    return !/^(?:app|api|auth|oauth|invite|feedback|email|r|monitoring|welcome|account-deleted|forgot(?:-password)?|reset(?:-password)?|password|callback|logout|verify)$/.test(root);
  } catch {
    return false;
  }
}

function validLastmod(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))?$/.test(value)) return false;
  const day = value.slice(0, 10);
  const parsedDay = new Date(`${day}T00:00:00Z`);
  return Number.isFinite(Date.parse(value)) && Number.isFinite(parsedDay.valueOf()) && parsedDay.toISOString().slice(0, 10) === day;
}

function validateEntries(entries: SitemapEntry[]): SitemapEntry[] {
  if (entries.length > MAX_URLS) throw new Error("Sitemap exceeds the 1000 URL inventory limit");
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!isPublicCandidateUrl(entry.url) || seen.has(entry.url)) throw new Error("Sitemap contains an unsafe or duplicate URL");
    if (entry.lastmod !== undefined && !validLastmod(entry.lastmod)) throw new Error("Sitemap has an invalid lastmod date");
    seen.add(entry.url);
  }
  return entries;
}

/** Detached DOM parsing, no page navigation, scripts, cookies or resource requests. */
export async function createOfflineParsers(): Promise<{
  parseSitemap: NonNullable<InventoryOptions["parseSitemap"]>;
  inspectHtml: NonNullable<InventoryOptions["inspectHtml"]>;
  close: () => Promise<void>;
}> {
  const { chromium } = await import("@playwright/test");
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ headless: true, timeout: 15_000 });
    const context = await browser.newContext({ javaScriptEnabled: false, serviceWorkers: "block", userAgent: USER_AGENT });
    await context.route("**/*", (route) => route.abort());
    const page = await context.newPage();
    // tsx preserves function names using an esbuild helper. Serialized DOM
    // callbacks need that fixed helper in the otherwise empty offline world.
    // This is tool-owned code; fetched HTML remains inert DOMParser input.
    await page.evaluate("globalThis.__name = (value) => value");
    return {
      close: () => browser!.close(),
      parseSitemap: async (xml) => {
        if (Buffer.byteLength(xml) > MAX_XML_BYTES || /<!\s*(?:DOCTYPE|ENTITY)/i.test(xml)) throw new Error("Unsafe or oversized sitemap XML");
        const entries = await page.evaluate((source) => {
          const document = new DOMParser().parseFromString(source, "application/xml");
          const root = document.documentElement;
          const ns = "http://www.sitemaps.org/schemas/sitemap/0.9";
          if (document.querySelector("parsererror") || root.localName !== "urlset" || root.namespaceURI !== ns) throw new Error("Expected a single valid sitemap urlset");
          if (root.children.length > 1_000) throw new Error("Sitemap exceeds the 1000 URL inventory limit");
          return Array.from(root.children).map((entry) => {
            if (entry.localName !== "url" || entry.namespaceURI !== ns) throw new Error("Unexpected sitemap element");
            const children = Array.from(entry.children);
            if (children.some((child) => child.namespaceURI !== ns || !["loc", "lastmod", "changefreq", "priority"].includes(child.localName) || child.children.length > 0)) throw new Error("Unexpected sitemap URL fields");
            const loc = children.filter((child) => child.localName === "loc");
            const lastmod = children.filter((child) => child.localName === "lastmod");
            if (loc.length !== 1 || lastmod.length > 1) throw new Error("Ambiguous sitemap URL fields");
            return { url: loc[0]!.textContent?.trim() ?? "", ...(lastmod.length ? { lastmod: lastmod[0]!.textContent?.trim() ?? "" } : {}) };
          });
        }, xml);
        return validateEntries(entries);
      },
      inspectHtml: async (html, url) => {
        if (Buffer.byteLength(html) > MAX_HTML_BYTES) throw new Error("Oversized public HTML page");
        return page.evaluate(({ source, pageUrl }) => {
          const document = new DOMParser().parseFromString(source, "text/html");
          if (document.querySelectorAll("*").length > 50_000) throw new Error("Public HTML exceeds the DOM node limit");
          const normalize = (value: string | null) => (value ?? "").replace(/\s+/g, " ").trim();
          let effectiveBase = pageUrl;
          const baseHref = document.querySelector("base[href]")?.getAttribute("href");
          try { if (baseHref !== undefined && baseHref !== null) effectiveBase = new URL(baseHref, pageUrl).href; } catch { effectiveBase = ""; }
          const canonicalUrls = Array.from(document.querySelectorAll("link[rel]"))
            .filter((link) => (link.getAttribute("rel") ?? "").toLowerCase().split(/\s+/).includes("canonical"))
            .map((link) => {
              const href = link.getAttribute("href");
              if (!href) return "";
              try { return new URL(href, effectiveBase).href; } catch { return ""; }
            });
          const robots = Array.from(document.querySelectorAll("meta[name]"))
            .filter((meta) => ["robots", "bingbot", "curviindexnow", "curviindexnowbot"].includes((meta.getAttribute("name") ?? "").toLowerCase()))
            .map((meta) => meta.getAttribute("content") ?? "");
          const title = normalize(document.querySelector("title")?.textContent ?? "");
          const description = Array.from(document.querySelectorAll("meta[name]"))
            .filter((meta) => meta.getAttribute("name")?.toLowerCase() === "description")
            .map((meta) => normalize(meta.getAttribute("content")));
          const main = document.querySelector("main") ?? document.querySelector("article");
          if (!main) return { canonicalUrls, robots, meaningfulContent: "", maintenance: /maintenance|service unavailable/i.test(title) };
          const content = main.cloneNode(true) as Element;
          content.querySelectorAll("script,style,noscript,template,svg,header,footer,nav,[hidden],[aria-hidden='true'],[inert],[data-indexnow-ignore]").forEach((node) => node.remove());
          const textNodes = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
          const pieces: string[] = [];
          while (textNodes.nextNode()) pieces.push(textNodes.currentNode.textContent ?? "");
          const text = normalize(pieces.join(" "));
          const maintenance = /^(?:(?:curvi(?:\.ai)?)[\s:|–-]+)?(?:maintenance|service unavailable|temporarily unavailable)(?:[\s:|–-]+curvi(?:\.ai)?)?$/i.test(title) || /^(?:the site is (?:under|down for) maintenance|service temporarily unavailable)[.!]?$/i.test(text);
          const stableUrl = (raw: string | null, image = false): string => {
            if (!raw) return "";
            try {
              let target = new URL(raw, effectiveBase);
              if (image && target.origin === new URL(pageUrl).origin && target.pathname === "/_next/image") target = new URL(target.searchParams.get("url") ?? "", effectiveBase);
              if (!["https:", "http:"].includes(target.protocol) || target.username || target.password || target.pathname.startsWith("/_next/static/")) return "";
              target.search = "";
              target.hash = "";
              return target.href;
            } catch { return ""; }
          };
          const images = Array.from(content.querySelectorAll("img")).map((image) => ({ src: stableUrl(image.getAttribute("src"), true), alt: normalize(image.getAttribute("alt")) }));
          const links = Array.from(content.querySelectorAll("a[href]")).map((link) => ({ href: stableUrl(link.getAttribute("href")), text: normalize(link.textContent) }));
          // Dates are already represented when shown in visible content. Generated
          // JSON-LD dates alone must not announce an unrelated deployment as new content.
          const stableJson = (value: unknown): unknown => {
            if (Array.isArray(value)) return value.map(stableJson);
            if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).filter(([key]) => !["dateModified", "dateCreated", "datePublished"].includes(key)).map(([key, child]) => [key, stableJson(child)]));
            return value;
          };
          const jsonLd = Array.from(document.querySelectorAll("script[type='application/ld+json']")).flatMap((script) => {
            try { return [stableJson(JSON.parse(script.textContent ?? ""))]; } catch { return []; }
          });
          return { canonicalUrls, robots, maintenance, meaningfulContent: text ? JSON.stringify({ title, description, text, images, links, jsonLd }) : "" };
        }, { source: html, pageUrl: url });
      },
    };
  } catch (error) {
    await browser?.close();
    throw error;
  }
}

type RobotsRule = { allow: boolean; pattern: string };
type RobotsGroup = { agents: string[]; rules: RobotsRule[] };

function parseRobots(source: string): RobotsGroup[] {
  const groups: RobotsGroup[] = [];
  let group: RobotsGroup | undefined;
  let sawDirective = false;
  for (const raw of source.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const line = raw.split("#", 1)[0]!.trim();
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    const field = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (field === "user-agent") {
      if (!value) throw new Error("Invalid robots.txt user agent");
      if (!group || sawDirective) { group = { agents: [], rules: [] }; groups.push(group); sawDirective = false; }
      group.agents.push(value.toLowerCase());
    } else if ((field === "allow" || field === "disallow") && group) {
      sawDirective = true;
      if (value) {
        // The inventory deliberately accepts only unencoded public URLs.
        // Fail closed on encoded robot rules rather than misapplying octet equivalence.
        if (!value.startsWith("/") || value.length > 2_048 || value.includes("%")) throw new Error("Unsupported robots.txt path directive");
        group.rules.push({ allow: field === "allow", pattern: value });
      }
    }
  }
  return groups;
}

// Greedy wildcard matching avoids compiling a remote robots pattern into a
// potentially exponential regular expression. Only '*' and a terminal '$'
// are special; all other characters are literal path bytes.
function matchesRobotsPath(pattern: string, path: string, terminal: boolean): boolean {
  let patternIndex = 0;
  let pathIndex = 0;
  let star = -1;
  let starMatch = 0;
  while (pathIndex < path.length) {
    if (patternIndex === pattern.length && !terminal) return true;
    if (pattern[patternIndex] === "*") {
      star = patternIndex++;
      starMatch = pathIndex;
    } else if (pattern[patternIndex] === path[pathIndex]) {
      patternIndex += 1;
      pathIndex += 1;
    } else if (star >= 0) {
      patternIndex = star + 1;
      pathIndex = ++starMatch;
    } else return false;
  }
  while (pattern[patternIndex] === "*") patternIndex += 1;
  return patternIndex === pattern.length;
}

function robotsAllows(groups: RobotsGroup[], url: string, agent: string): boolean {
  const matches = groups.map((group) => ({ group, length: Math.max(-1, ...group.agents.map((name) => name === "*" ? 0 : agent.toLowerCase().startsWith(name) ? name.length : -1)) }));
  const specificity = Math.max(-1, ...matches.map((match) => match.length));
  const path = new URL(url).pathname;
  let winning: { length: number; allow: boolean } | undefined;
  for (const { group, length } of matches) {
    if (length < 0 || length !== specificity) continue;
    for (const rule of group.rules) {
      const terminal = rule.pattern.endsWith("$");
      const pattern = terminal ? rule.pattern.slice(0, -1) : rule.pattern;
      if (!matchesRobotsPath(pattern, path, terminal)) continue;
      const ruleLength = pattern.replace(/\*/g, "").length;
      if (!winning || ruleLength > winning.length || (ruleLength === winning.length && rule.allow)) winning = { length: ruleLength, allow: rule.allow };
    }
  }
  return winning?.allow ?? true;
}

function forbidsIndexing(value: string): boolean {
  return /(?:^|[\s,:;])(?:noindex|none)(?=$|[\s,;])/i.test(value);
}

async function boundedText(response: Response, maximum: number): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && (!/^\d+$/.test(contentLength) || Number(contentLength) > maximum)) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("Public response exceeds the byte limit");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      let next: ReadableStreamReadResult<Uint8Array>;
      try { next = await reader.read(); } catch { throw new Error("Public response body read failed; inventory not changed"); }
      if (next.done) break;
      length += next.value.byteLength;
      if (length > maximum) throw new Error("Public response exceeds the byte limit");
      chunks.push(next.value);
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/** Scan completely before returning. Any transport/server failure discards the scan. */
export async function collectInventory(options: InventoryOptions): Promise<Inventory> {
  if (options.previousUrls.length > MAX_URLS || options.previousUrls.some((url) => !isPublicCandidateUrl(url)) || new Set(options.previousUrls).size !== options.previousUrls.length) throw new Error("Invalid previous public URL inventory");
  const fetcher = options.fetcher ?? fetch;
  const scanDeadline = Date.now() + MAX_SCAN_MS;
  const scanSignal = AbortSignal.timeout(MAX_SCAN_MS);
  const request = async (url: string, kind: "robots" | "sitemap" | "page"): Promise<Response> => {
    if (Date.now() >= scanDeadline || scanSignal.aborted) throw new Error("Public inventory exceeded the five minute scan limit");
    let response: Response;
    try {
      response = await fetcher(url, {
        method: "GET", redirect: "error", credentials: "omit", cache: "no-store",
        signal: AbortSignal.any([scanSignal, AbortSignal.timeout(15_000)]), headers: { "user-agent": USER_AGENT, accept: kind === "page" ? "text/html" : kind === "sitemap" ? "application/xml,text/xml" : "text/plain" },
      });
    } catch { throw new Error(`Public ${kind} request failed or timed out; inventory not changed`); }
    if (scanSignal.aborted || response.redirected || (response.url && response.url !== url) || response.status >= 500 || response.status === 429 || (response.status !== 200 && !(kind === "page" && [404, 410].includes(response.status)))) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`Public ${kind} retrieval failed (${response.status}); inventory not changed`);
    }
    if (response.status === 200) {
      const contentType = (response.headers.get("content-type") ?? "").split(";", 1)[0]!.trim().toLowerCase();
      const expected = kind === "page" ? ["text/html", "application/xhtml+xml"] : kind === "sitemap" ? ["application/xml", "text/xml"] : ["text/plain"];
      if (!expected.includes(contentType)) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error(`Unexpected public ${kind} content type`);
      }
    }
    return response;
  };
  let parsers: Awaited<ReturnType<typeof createOfflineParsers>> | undefined;
  try {
    const robots = parseRobots(await boundedText(await request(`${ORIGIN}/robots.txt`, "robots"), 100_000));
    const xml = await boundedText(await request(`${ORIGIN}/sitemap.xml`, "sitemap"), MAX_XML_BYTES);
    if (/<!\s*(?:DOCTYPE|ENTITY)/i.test(xml)) throw new Error("Unsafe sitemap XML");
    if (!options.parseSitemap || !options.inspectHtml) parsers = await createOfflineParsers();
    const entries = validateEntries(await (options.parseSitemap ?? parsers!.parseSitemap)(xml));
    const inspectHtml = options.inspectHtml ?? parsers!.inspectHtml;
    const sitemapUrls = new Set(entries.map(({ url }) => url));
    const previousUrls = new Set(options.previousUrls);
    const candidates: SitemapEntry[] = [...entries, ...options.previousUrls.filter((url) => !sitemapUrls.has(url)).map((url) => ({ url }))];
    if (candidates.length > MAX_URLS) throw new Error("Combined public inventory exceeds the 1000 URL scan limit");
    const result: Inventory = { observations: [], excluded: [] };
    for (const entry of candidates) {
      const { url } = entry;
      if (!["bingbot", "curviindexnowbot"].every((agent) => robotsAllows(robots, url, agent))) {
        result.excluded.push({ url, reason: "robots-disallow" });
        continue;
      }
      const response = await request(url, "page");
      if ([404, 410].includes(response.status)) {
        await response.body?.cancel().catch(() => undefined);
        if (previousUrls.has(url)) result.observations.push({ url, kind: "deleted", fingerprint: DELETED_FINGERPRINT });
        else result.excluded.push({ url, reason: "not-found-without-public-history" });
        continue;
      }
      if (forbidsIndexing(response.headers.get("x-robots-tag") ?? "")) {
        await response.body?.cancel().catch(() => undefined);
        result.excluded.push({ url, reason: "header-noindex" });
        continue;
      }
      const inspected = await inspectHtml(await boundedText(response, MAX_HTML_BYTES), url);
      if (inspected.maintenance) throw new Error("Public site reports maintenance; inventory not changed");
      if (inspected.robots.some(forbidsIndexing)) { result.excluded.push({ url, reason: "meta-noindex" }); continue; }
      // Losing public sitemap membership may be an owner changing visibility.
      // A surviving URL must never be submitted as a deletion or rediscovered.
      if (!sitemapUrls.has(url)) {
        result.excluded.push({ url, reason: "not-in-public-sitemap" });
        continue;
      }
      let canonical: string | undefined;
      try { if (inspected.canonicalUrls.length === 1 && inspected.canonicalUrls[0]) canonical = new URL(inspected.canonicalUrls[0], url).href; } catch { /* invalid canonical is excluded */ }
      if (canonical !== url || !isPublicCandidateUrl(canonical)) { result.excluded.push({ url, reason: "canonical-mismatch-or-missing" }); continue; }
      if (!inspected.meaningfulContent) { result.excluded.push({ url, reason: "missing-main-content" }); continue; }
      result.observations.push({ url, kind: "page", fingerprint: createHash("sha256").update(`curvi-indexnow:content:v1\n${inspected.meaningfulContent}`).digest("hex"), ...(entry.lastmod ? { lastmod: entry.lastmod } : {}) });
    }
    if (Date.now() >= scanDeadline || scanSignal.aborted) throw new Error("Public inventory exceeded the five minute scan limit");
    return result;
  } finally {
    await parsers?.close();
  }
}
