import { describe, expect, it } from "vitest";
import { packZipEntries } from "./pack-zip";

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
    expect(entries[0].name.slice("amazon/".length)).not.toContain("/");
  });
});
