import { describe, expect, it, vi } from "vitest";
import { creditCosts } from "@curvi/pipeline/seed";
import { estimatePackCredits } from "./pack-estimate";

// Once the seed marks video live, the same lines carry their seed price.
vi.mock("@curvi/pipeline/seed", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@curvi/pipeline/seed")>();
  return { ...actual, isShotMethodDeliverable: () => true };
});

/** Video is only planned, and held, when a video channel is picked. */
const WITH_VIDEO = ["amazon.main", "video.social_9x16"];

describe("estimatePackCredits once video ships", () => {
  it("prices entitled video per second from the seed", () => {
    const starter = estimatePackCredits(WITH_VIDEO, "listing", "starter");
    const growth = estimatePackCredits(WITH_VIDEO, "listing", "growth");
    const hero = growth.lines.find((l) => l.label.startsWith("Hero loop"));
    expect(hero).toEqual({ label: "Hero loop, 6 seconds", credits: 6 * creditCosts.generativeVideoPerSecondLite });
    expect(growth.total - starter.total).toBe(6 * creditCosts.generativeVideoPerSecondLite);
  });

  it("prices the UGC hook ad on pro", () => {
    const pro = estimatePackCredits(WITH_VIDEO, "listing", "pro");
    expect(pro.lines.find((l) => l.label === "UGC hook ad")?.credits).toBe(creditCosts.ugcAvatarAd);
  });

  it("holds no video for a pack that picks no video channel", () => {
    const pro = estimatePackCredits(["amazon.main"], "listing", "pro");
    expect(pro.lines.some((l) => /Hero loop|Lifestyle clip|UGC/.test(l.label))).toBe(false);
  });
});
