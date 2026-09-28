import type { MetadataRoute } from "next";

/**
 * AI search crawlers, AI training crawlers and AI usage control tokens
 * (Google-Extended and Applebot-Extended never crawl; they only govern model
 * use). The wildcard rule already allows all of them; naming them records
 * that Curvi opts in to AI search citation and model training. User triggered
 * fetchers such as ChatGPT-User and Perplexity-User may not read robots.txt.
 * A crawler that matches a named group ignores the wildcard group, so each
 * group repeats the same disallow list. Tokens checked against each
 * operator's docs on 2026-09-28 (docs/verification.md).
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
  "meta-webindexer",
  "meta-externalagent",
  "DuckAssistBot",
  "CCBot",
];

const DISALLOW = ["/app/", "/api/"];

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      { userAgent: "*", allow: "/", disallow: DISALLOW },
      { userAgent: AI_CRAWLERS, allow: "/", disallow: DISALLOW },
    ],
    sitemap: "https://curvi.ai/sitemap.xml",
  };
}
