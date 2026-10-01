import { creditCosts, tiers } from "@curvi/pipeline/seed";
import { categories } from "@/components/marketing/categories";
import { AGENT_HELP_SLUG, structuredHelpArticles } from "@/components/marketing/help-articles";
import { homeFaqs } from "@/components/marketing/home-copy";
import { answerFaqs, pillarPages, type PillarPage } from "@/components/marketing/pillar-copy";
import { imageSpecs, specDisplayName, specSlug } from "@/components/marketing/spec-slug";
import { isStripeConfigured, siteUrl } from "@/lib/env";
import {
  amazonMainRules,
  comingSoonFeatures,
  comingSoonFileNames,
  isLive,
  joinList,
  liveChannelNames,
  packsForCredits,
  specAvailability,
  tierDisplayName,
  typicalPackCredits,
} from "@/lib/marketing-facts";
import { SITE_CATEGORY, SITE_DESCRIPTION, SITE_FEATURES, SITE_POSITIONING, SITE_SUMMARY } from "@/lib/seo";

/**
 * llms.txt (llmstxt.org): a plain markdown map of the site for AI answer and
 * generative engines. The format allows lists and paragraphs only before the
 * first H2; every H2 section must be a list of [name](url) links, and the
 * section named "Optional" holds links an agent can skip. Prices and
 * channels come from the seeds and the spec registry, so this file never
 * drifts from the pricing page.
 *
 * /llms-full.txt is not part of the llmstxt.org proposal; it is a common
 * companion file that puts the full text of the key pages in one document,
 * so an assistant can read every answer without following links.
 */

function url(path: string): string {
  return new URL(path, siteUrl()).toString();
}

/** The short FAQ both files carry: the questions people ask assistants. */
const assistantFaqs = Object.values(answerFaqs);

/**
 * The API, MCP server, CLI and skill line (PHASE_16 workstream 5), worded
 * from their availability flags so it says coming soon until each ships.
 */
function agentAccessSummary(): string {
  const parts = [
    { key: "agentApi", text: "the Curvi API" },
    { key: "agentApi", text: "the MCP server" },
    { key: "agentSkill", text: "the curvi command line tool" },
    { key: "agentSkill", text: "the Curvi skill" },
  ] as const;
  const live = parts.filter((part) => isLive(part.key)).map((part) => part.text);
  const soon = parts.filter((part) => !isLive(part.key)).map((part) => part.text);
  return [
    ...(live.length > 0 ? [`make packs from AI agents with ${joinList(live)}`] : []),
    ...(soon.length > 0 ? [`${joinList(soon)} are coming soon`] : []),
  ].join("; ");
}

/** Everything before the first H2: summary, positioning, facts, pricing and FAQ. */
function introLines(): string[] {
  const free = tiers.find((tier) => tier.key === "free");
  const paid = tiers.filter((tier) => tier.monthlyUsd > 0);
  const main = amazonMainRules();

  return [
    "# Curvi",
    "",
    `> ${SITE_SUMMARY}`,
    "",
    SITE_DESCRIPTION,
    "",
    "Curvi is for e-commerce professionals who post products on Shopify, Amazon and other marketplaces. Upload one product photo and Curvi builds the listing images each channel needs. The product is masked first, and the pixels inside the mask are never regenerated, so labels, logos and textures are never redrawn by AI. Every finished file is measured for color change inside the product before it ships.",
    "",
    `Positioning: Curvi is an ${SITE_CATEGORY}. ${SITE_POSITIONING} Other e-commerce photo tools also start from the seller's photo; Curvi adds automated channel compliance: every file is measured against the channel's image rules, a whole listing pack is compiled from one photo in one run, and a shot that still fails its checks is marked for review and not charged.`,
    "",
    "Key facts:",
    "",
    "- Category: AI e-commerce, AI product images, AI images for online stores",
    "- Input: one product photo; a phone photo works",
    "- Product fidelity: product pixels are never regenerated in listing images, and tests in the code enforce it",
    `- Amazon main image: pure white background RGB ${main.rgb.join(", ")}, measured for a product fill of ${main.fillMinPercent} to ${main.fillMaxPercent} percent, longest side at least ${main.minLongSide} pixels`,
    `- Channels with files today: ${joinList(liveChannelNames())}`,
    "- Output: a pack of still images grouped by channel, each with a compliance report",
    "",
    "What Curvi does:",
    "",
    ...SITE_FEATURES.map((feature) => `- ${feature}`),
    "",
    "Coming soon, not available on any plan yet:",
    "",
    ...comingSoonFeatures().map((feature) => `- ${feature.label}`),
    ...(comingSoonFileNames().length > 0 ? [`- ${joinList(comingSoonFileNames())}`] : []),
    "",
    "Pricing:",
    "",
    ...(free ? [`- Free: ${free.creditsOnce} credits once, no card needed`] : []),
    ...paid.map(
      (tier) =>
        `- ${tierDisplayName(tier.key)}: $${tier.monthlyUsd} per month, or $${tier.annualUsdPerMonth} per month billed annually, for ${tier.creditsPerMonth} credits per month, about ${packsForCredits(tier.creditsPerMonth)} listing packs`,
    ),
    ...(isStripeConfigured() ? [] : ["- Paid plans cannot be bought yet. Start on the free plan."]),
    `- Credits: ${creditCosts.deterministic} credit for a white background main image, cutout, resize or sweep; ${creditCosts.generativeStill} credit for a generative still up to 2K`,
    `- A typical listing pack of still images uses about ${typicalPackCredits()} credits, and only files that pass their checks are charged`,
    "",
    "Common questions:",
    "",
    ...assistantFaqs.flatMap((faq) => [`Q: ${faq.q}`, "", `A: ${faq.a}`, ""]),
  ];
}

export function buildLlmsTxt(): string {
  const lines = [
    ...introLines(),
    "## Guides",
    "",
    ...pillarPages.map((page) => `- [${page.h1}](${url(page.path)}): ${page.summary.split(". ")[0]}.`),
    "",
    "## Pages",
    "",
    `- [Home](${url("/")}): what Curvi is and how the pack works`,
    `- [Pricing](${url("/pricing")}): plans, credits and top ups`,
    `- [Help center](${url("/help")}): uploads, credits, compliance reports, brand kits and channels`,
    `- [Gallery](${url("/gallery")}): illustrated before and after examples of the pack format`,
    `- [Curvi for AI agents](${url(`/help#${AGENT_HELP_SLUG}`)}): ${agentAccessSummary()}`,
    "",
    "## Free tools",
    "",
    `- [Amazon main image checker](${url("/tools/main-image-checker")}): measures background whiteness, product fill and resolution in the browser`,
    `- [White background fixer](${url("/tools/white-background-fixer")}): turns an off white background into pure white, preview quality`,
    `- [Marketplace image resizer](${url("/tools/marketplace-resizer")}): resizes one photo for each marketplace with the expected file names`,
    "",
    "## Marketplace image requirements",
    "",
    ...imageSpecs().map(
      (spec) =>
        `- [${specDisplayName(spec.id)} requirements](${url(`/channels/${specSlug(spec.id)}/image-requirements`)})${
          specAvailability(spec.id) === "live" ? "" : ": the rules only, Curvi files for it are coming soon"
        }`,
    ),
    "",
    "## AI product photos by category",
    "",
    ...categories.map((category) => `- [${category.name}](${url(`/for/${category.slug}`)}): ${category.headline}`),
    "",
    "## Optional",
    "",
    `- [Full text](${url("/llms-full.txt")}): the guides, home page answers and help center in one plain text file`,
    "",
  ];
  return lines.join("\n");
}

function pillarPageText(page: PillarPage): string[] {
  const table = page.table;
  return [
    `## ${page.h1}`,
    "",
    `Source: ${url(page.path)}`,
    "",
    page.summary,
    "",
    ...page.sections.flatMap((section) => [
      `### ${section.heading}`,
      "",
      ...section.paragraphs.flatMap((paragraph) => [paragraph, ""]),
      ...(section.bullets ? [...section.bullets.map((bullet) => `- ${bullet}`), ""] : []),
    ]),
    ...(table
      ? [
          `### ${table.caption}`,
          "",
          // Rows as lists rather than a markdown table: one line per row,
          // each cell named by its column.
          ...table.rows.map(
            (row) =>
              `- ${row[0]}: ${row
                .slice(1)
                .map((cell, index) => `${table.columns[index + 1]}: ${cell}`)
                .join("; ")}`,
          ),
          "",
          ...(table.note ? [table.note, ""] : []),
          ...(table.sources
            ? [`Sources: ${table.sources.map((source) => `${source.name} (${source.url})`).join(", ")}`, ""]
            : []),
        ]
      : []),
    ...page.faqs.flatMap((faq) => [`### ${faq.q}`, "", faq.a, ""]),
  ];
}

export function buildLlmsFullTxt(): string {
  const lines = [
    ...introLines(),
    ...pillarPages.flatMap(pillarPageText),
    "## Home page questions",
    "",
    `Source: ${url("/")}`,
    "",
    ...homeFaqs.flatMap((faq) => [`### ${faq.q}`, "", faq.a, ""]),
    "## Help center",
    "",
    `Source: ${url("/help")}`,
    "",
    ...structuredHelpArticles().flatMap((article) => [
      `### ${article.title}`,
      "",
      ...article.body.flatMap((paragraph) => [paragraph, ""]),
    ]),
  ];
  return lines.join("\n");
}
