import { describe, expect, it } from "vitest";
import { isPageNavigation, packZipEntries, packZipRefusalCopy, packZipRefusalPath } from "./pack-zip";

describe("packZipEntries (Update.md 6.5)", () => {
  it("names every entry exactly as stored, in one folder per channel, with the report at the root", () => {
    const entries = packZipEntries(
      [
        { r2Key: "ws/w/jobs/j/files/shopify/mug-1.jpg", filename: "mug-1.jpg", channelSpecId: "shopify.product" },
        { r2Key: "ws/w/jobs/j/files/amazon/MUG1.MAIN.jpg", filename: "MUG1.MAIN.jpg", channelSpecId: "amazon.main" },
        { r2Key: "ws/w/jobs/j/files/amazon/MUG1.PT01.jpg", filename: "MUG1.PT01.jpg", channelSpecId: "amazon.secondary" },
      ],
      { r2Key: "ws/w/jobs/j/pack/compliance-report.json", filename: "compliance-report.json" },
    );
    expect(entries.map((e) => e.name)).toEqual([
      "amazon/MUG1.MAIN.jpg",
      "amazon/MUG1.PT01.jpg",
      "shopify/mug-1.jpg",
      "compliance-report.json",
    ]);
    expect(entries.find((e) => e.name === "amazon/MUG1.MAIN.jpg")?.r2Key).toBe("ws/w/jobs/j/files/amazon/MUG1.MAIN.jpg");
  });

  it("never lets two files overwrite each other", () => {
    const entries = packZipEntries(
      [
        { r2Key: "k1", filename: "photo.jpg", channelSpecId: "meta.feed_1x1" },
        { r2Key: "k2", filename: "photo.jpg", channelSpecId: "meta.feed_4x5" },
      ],
      null,
    );
    expect(new Set(entries.map((e) => e.name)).size).toBe(2);
    expect(entries.map((e) => e.name)).toEqual(["meta/photo.jpg", "meta/photo-2.jpg"]);
  });

  it("keeps entry names inside their folder", () => {
    const entries = packZipEntries([{ r2Key: "k", filename: "../../etc/passwd", channelSpecId: "amazon.main" }], null);
    expect(entries[0].name.startsWith("amazon/")).toBe(true);
    expect(entries[0].name).not.toContain("..");
    expect(entries[0].name).toBe("amazon/etc/passwd");
  });

  it("keeps the carousel and ads folders of the ads formats (PHASE_16 workstream 3)", () => {
    const entries = packZipEntries(
      [
        { r2Key: "k1", filename: "carousel/01.jpg", channelSpecId: "meta.feed_4x5" },
        { r2Key: "k2", filename: "ads/ad_9x16/v1.jpg", channelSpecId: "tiktok.ad_9x16" },
        { r2Key: "k3", filename: "carousel//./02.jpg", channelSpecId: "meta.feed_4x5" },
      ],
      null,
    );
    expect(entries.map((e) => e.name).sort()).toEqual([
      "meta/carousel/01.jpg",
      "meta/carousel/02.jpg",
      "tiktok/ads/ad_9x16/v1.jpg",
    ]);
  });
});

describe("pack zip refusals reach the seller as plain copy, never raw JSON", () => {
  const JOB = "00000000-0000-4000-8000-000000000abc";

  it("sends a refused navigation back to the job page's files", () => {
    expect(packZipRefusalPath(JOB, "not_finished")).toBe(`/app/jobs/${JOB}?pack_zip=not_finished#your-files`);
  });

  it("tells a page navigation from a fetch", () => {
    const req = (headers: Record<string, string>) => new Request("https://curvi.ai/api/jobs/x/pack", { headers });
    expect(isPageNavigation(req({ "sec-fetch-mode": "navigate" }))).toBe(true);
    expect(isPageNavigation(req({ "sec-fetch-mode": "cors", accept: "text/html" }))).toBe(false);
    expect(isPageNavigation(req({ accept: "text/html,application/xhtml+xml" }))).toBe(true);
    expect(isPageNavigation(req({ accept: "application/json" }))).toBe(false);
  });

  it("has plain copy for each code and none for an unknown one", () => {
    for (const code of ["not_finished", "no_files", "missing_files"]) {
      const copy = packZipRefusalCopy(code);
      expect(copy, code).toBeTruthy();
      expect(copy, code).not.toMatch(/[\u2012-\u2015\u2190-\u21ff]|\p{Extended_Pictographic}/u);
      expect(copy, code).not.toContain(" - ");
    }
    expect(packZipRefusalCopy("toString")).toBeNull();
    expect(packZipRefusalCopy("<script>")).toBeNull();
    expect(packZipRefusalCopy(null)).toBeNull();
  });
});
