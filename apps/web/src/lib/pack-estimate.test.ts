import { describe, expect, it } from "vitest";
import { creditCosts } from "@curvi/pipeline/seed";
import { estimatePackCredits } from "./pack-estimate";

describe("estimatePackCredits", () => {
  it("returns zero for no channels", () => {
    expect(estimatePackCredits([], "listing", "growth").total).toBe(0);
  });

  it("adds marketplace assets when amazon is selected", () => {
    const withoutAmazon = estimatePackCredits(["meta.feed_1x1"], "listing", "starter");
    const withAmazon = estimatePackCredits(["meta.feed_1x1", "amazon.main"], "listing", "starter");
    expect(withAmazon.total).toBeGreaterThan(withoutAmazon.total);
  });

  it("drops marketplace only assets in concept mode", () => {
    const listing = estimatePackCredits(["amazon.main", "shopify.product"], "listing", "starter");
    const concept = estimatePackCredits(["amazon.main", "shopify.product"], "concept", "starter");
    expect(concept.total).toBeLessThan(listing.total);
    expect(concept.lines.some((l) => l.label.includes("Amazon"))).toBe(false);
  });

  it("includes generative video only from growth up, priced per second from seed", () => {
    const starter = estimatePackCredits(["amazon.main"], "listing", "starter");
    const growth = estimatePackCredits(["amazon.main"], "listing", "growth");
    const heroLine = growth.lines.find((l) => l.label.includes("Hero loop"));
    expect(starter.lines.some((l) => l.label.includes("Hero loop"))).toBe(false);
    expect(heroLine?.credits).toBe(6 * creditCosts.generativeVideoPerSecondLite);
  });

  it("adds the UGC hook ad only on pro and agency", () => {
    const growth = estimatePackCredits(["amazon.main"], "listing", "growth");
    const pro = estimatePackCredits(["amazon.main"], "listing", "pro");
    expect(growth.lines.some((l) => l.label.includes("UGC"))).toBe(false);
    const ugc = pro.lines.find((l) => l.label.includes("UGC"));
    expect(ugc?.credits).toBe(creditCosts.ugcAvatarAd);
  });
});
