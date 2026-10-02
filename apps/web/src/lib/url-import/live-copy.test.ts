import { describe, expect, it } from "vitest";
import { helpArticles } from "@/components/marketing/help-articles";
import { buildLlmsTxt } from "@/lib/llms";
import { FEATURES, comingSoonFeatures, isLive, unqualifiedClaims } from "@/lib/marketing-facts";
import { SITE_FEATURES } from "@/lib/seo";

// P18-11: the product link import's copy (claim C-17 in docs/marketing.md)
// follows FEATURES.urlImport. It stays coming_soon until one production
// import each of a Shopify and an Amazon product works (a founder step);
// the flip is then the one line in marketing-facts.ts, and these tests check
// whichever state the flag is in.

const live = isLive("urlImport");

describe(`URL import copy while the flag is ${FEATURES.urlImport.status}`, () => {
  it("is coming soon until the production imports are checked", () => {
    expect(FEATURES.urlImport.status).toBe(live ? "live" : "coming_soon");
    if (live) {
      expect(comingSoonFeatures()).not.toContainEqual(FEATURES.urlImport);
    } else {
      expect(comingSoonFeatures()).toContainEqual(FEATURES.urlImport);
    }
  });

  it("lets copy say paste a product link only while live", () => {
    const claims = unqualifiedClaims("Paste a product link from Shopify or Amazon to start.");
    expect(claims.length === 0).toBe(live);
  });

  it("lists it as coming soon in llms.txt only while it is", () => {
    const text = buildLlmsTxt();
    const soon = text.slice(text.indexOf("Coming soon, not available on any plan yet:"), text.indexOf("Pricing:"));
    expect(soon.includes(FEATURES.urlImport.label)).toBe(!live);
  });

  it("names it in the site features and the photo help article only while live", () => {
    expect(SITE_FEATURES.some((feature) => /Shopify or Amazon product link/.test(feature))).toBe(live);
    const photo = helpArticles.find((article) => article.slug === "what-photo-should-i-upload");
    expect(photo?.body.join(" ").includes("paste the product's link from your Shopify store or from Amazon")).toBe(live);
  });
});
