import type { MetadataRoute } from "next";

/**
 * AI search crawlers, AI training crawlers and AI usage control tokens
 * (Google-Extended and Applebot-Extended never crawl; they only govern model
 * use). The wildcard rule already allows all of them; naming them records
 * that Curvi opts in to AI search citation and model training. User triggered
 * fetchers such as ChatGPT-User and Perplexity-User may not read robots.txt.
 * A crawler that matches a named group ignores the wildcard group, so each
 * group repeats the same disallow list. Tokens checked against each
 * operator's docs on 2026-09-28, and the Amazon, Meta user fetcher and
 * Mistral tokens added on 2026-09-29 (docs/verification.md).
 */
const AI_CRAWLERS = [
  "GPTBot",
  "OAI-SearchBot",
  "ChatGPT-User",
  "ClaudeBot",
  "Claude-SearchBot",
  "Claude-User",
  "PerplexityBot",
  "Perplexity-User",
  "Google-Extended",
  "Applebot",
  "Applebot-Extended",
  "Amazonbot",
  "Amzn-SearchBot",
  "Amzn-User",
  "meta-webindexer",
  "meta-externalagent",
  "meta-externalfetcher",
  "MistralAI-User",
  "MistralAI-Index",
  "MistralAI-Training",
  "DuckAssistBot",
  "CCBot",
];

// A trailing slash alone misses the namespace root (/app), including its
// query-string variants. Keep the boundary explicit so public names such
// as /application are not accidentally excluded. RFC 9309 section 2.2.3.
const DISALLOW = ["/app$", "/app?", "/app/", "/api$", "/api?", "/api/"];

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      { userAgent: "*", allow: "/", disallow: DISALLOW },
      { userAgent: AI_CRAWLERS, allow: "/", disallow: DISALLOW },
    ],
    sitemap: "https://curvi.ai/sitemap.xml",
  };
}
