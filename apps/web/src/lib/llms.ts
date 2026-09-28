import { creditCosts, tiers } from "@curvi/pipeline/seed";
import { categories } from "@/components/marketing/categories";
import { imageSpecs, specDisplayName, specSlug } from "@/components/marketing/spec-slug";
import { isStripeConfigured, siteUrl } from "@/lib/env";
import { SITE_DESCRIPTION, SITE_FEATURES, SITE_SUMMARY } from "@/lib/seo";

/**
 * llms.txt (llmstxt.org): a plain markdown map of the site for AI answer and
 * generative engines. The format allows lists and paragraphs only before the
 * first H2; every H2 section must be a list of [name](url) links. Prices and
 * channels come from the seeds and the spec registry, so this file never
 * drifts from the pricing page.
 */
export function buildLlmsTxt(): string {
  const url = (path: string) => new URL(path, siteUrl()).toString();
  const tierName = (key: string) => key.charAt(0).toUpperCase() + key.slice(1);
  const free = tiers.find((tier) => tier.key === "free");
  const paid = tiers.filter((tier) => tier.monthlyUsd > 0);

  const lines = [
    "# Curvi",
    "",
    `> ${SITE_SUMMARY}`,
    "",
    SITE_DESCRIPTION,
    "",
    "Curvi is for e-commerce professionals who post products on Shopify, Amazon and other marketplaces. Upload one product photo and Curvi builds the listing images each channel needs. The product is masked first, and the pixels inside the mask are never regenerated, so labels, logos and textures stay identical to the original photo.",
    "",
    "What Curvi does:",
    "",
    ...SITE_FEATURES.map((feature) => `- ${feature}`),
    "",
    "Pricing:",
    "",
    ...(free ? [`- Free: ${free.creditsOnce} credits once, no card needed`] : []),
    ...paid.map(
      (tier) =>
        `- ${tierName(tier.key)}: $${tier.monthlyUsd} per month, or $${tier.annualUsdPerMonth} per month billed annually, for ${tier.creditsPerMonth} credits per month`,
    ),
    ...(isStripeConfigured() ? [] : ["- Paid plans cannot be bought yet. Start on the free plan."]),
    `- Credits: ${creditCosts.deterministic} credit for a white background main image, cutout, resize or sweep; ${creditCosts.generativeStill} credit for a generative still up to 2K`,
    "",
    "## Pages",
    "",
    `- [Home](${url("/")}): what Curvi is and how the pack works`,
    `- [Pricing](${url("/pricing")}): plans, credits and top ups`,
    `- [Help center](${url("/help")}): uploads, credits, compliance reports, brand kits and channels`,
    `- [Gallery](${url("/gallery")}): before and after product photo makeovers`,
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
        `- [${specDisplayName(spec.id)} requirements](${url(`/channels/${specSlug(spec.id)}/image-requirements`)})`,
    ),
    "",
    "## AI product photos by category",
    "",
    ...categories.map((category) => `- [${category.name}](${url(`/for/${category.slug}`)}): ${category.headline}`),
    "",
  ];
  return lines.join("\n");
}
