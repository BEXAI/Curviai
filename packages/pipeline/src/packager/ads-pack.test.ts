/**
 * PHASE_16 workstream 3: carousels ship as a numbered folder, ad variants
 * grouped by placement, and every zip with ads carries a CSV of the
 * headlines and calls to action.
 */
import { describe, expect, it } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { encodeJpeg } from "../raw";
import { paintRect, rawCanvas } from "../testutil";
import { ADS_CSV_NAME, adsCsv, buildPack, groupedFileName, packGroupFor, type PackAsset } from "./index";

const execFileAsync = promisify(execFile);

async function jpeg(width: number, height: number): Promise<Buffer> {
  const raw = rawCanvas(width, height, 236, 236, 238);
  paintRect(raw, { left: 20, top: 20, width: 40, height: 40 }, 30, 110, 170);
  return encodeJpeg(raw);
}

describe("ads files in the pack", () => {
  it("names grouped files by folder", () => {
    expect(groupedFileName("meta.feed_4x5", { kind: "carousel", carouselId: "c1", slideIndex: 3 }, "jpeg")).toBe(
      "carousel/03.jpg",
    );
    expect(groupedFileName("meta.feed_4x5", { kind: "carousel", carouselId: "c2", slideIndex: 10 }, "png")).toBe(
      "carousel-c2/10.png",
    );
    expect(
      groupedFileName("tiktok.ad_9x16", { kind: "ad", variantKey: "v2", headline: "x", cta: "y" }, "jpg"),
    ).toBe("ads/ad_9x16/v2.jpg");
    expect(groupedFileName("meta.feed_4x5", undefined, "jpg")).toBeNull();
    expect(
      groupedFileName("meta.feed_4x5", { kind: "ad", variantKey: "../../v1", headline: "", cta: "" }, "jpg"),
    ).toBe("ads/feed_4x5/v1.jpg");
  });

  it("reads the group from a planned shot", () => {
    expect(packGroupFor({ type: "carousel_slide", carouselId: "c1", slideIndex: 2 })).toEqual({
      kind: "carousel",
      carouselId: "c1",
      slideIndex: 2,
    });
    expect(packGroupFor({ type: "ad_variant", variantKey: "v1", headline: "Mug", cta: "Shop now" })).toEqual({
      kind: "ad",
      variantKey: "v1",
      headline: "Mug",
      cta: "Shop now",
    });
    expect(packGroupFor({ type: "social_4x5" })).toBeUndefined();
  });

  it("writes a CSV that quotes commas and never reads as a formula", () => {
    expect(
      adsCsv([
        { specId: "meta.feed_1x1", file: "ads/feed_1x1/v1.jpg", headline: "Hot, all morning", cta: "Shop now" },
        { specId: "meta.feed_1x1", file: "ads/feed_1x1/v2.jpg", headline: "=HYPERLINK(1)", cta: 'Say "hi"' },
      ]),
    ).toBe(
      [
        "placement,file,headline,call_to_action",
        'meta.feed_1x1,ads/feed_1x1/v1.jpg,"Hot, all morning",Shop now',
        `meta.feed_1x1,ads/feed_1x1/v2.jpg,'=HYPERLINK(1),"Say ""hi"""`,
        "",
      ].join("\n"),
    );
  });

  it("ships the carousel as a numbered folder and ads by placement, with the ads CSV", async () => {
    const outDir = await mkdtemp(path.join(tmpdir(), "curvi-ads-pack-"));
    const assets: PackAsset[] = [];
    for (const slideIndex of [1, 2, 3]) {
      assets.push({
        specId: "meta.feed_4x5",
        buffer: await jpeg(108, 135),
        format: "jpg",
        ref: `s0${slideIndex}_carousel_slide`,
        group: { kind: "carousel", carouselId: "c1", slideIndex },
      });
    }
    for (const specId of ["meta.feed_1x1", "meta.story_9x16", "tiktok.ad_9x16"]) {
      for (const variantKey of ["v1", "v2"]) {
        assets.push({
          specId,
          buffer: await jpeg(108, 108),
          format: "jpg",
          ref: `${variantKey}_ad_variant`,
          group: { kind: "ad", variantKey, headline: `Headline ${variantKey}`, cta: "Shop now" },
        });
      }
    }
    const result = await buildPack(assets, ["meta", "tiktok"], { outDir, writeFiles: true });
    const meta = result.zips.find((z) => z.channel === "meta")!;
    expect(meta.files).toEqual([
      "carousel/01.jpg",
      "carousel/02.jpg",
      "carousel/03.jpg",
      "ads/feed_1x1/v1.jpg",
      "ads/feed_1x1/v2.jpg",
      "ads/story_9x16/v1.jpg",
      "ads/story_9x16/v2.jpg",
    ]);
    const tiktok = result.zips.find((z) => z.channel === "tiktok")!;
    expect(tiktok.files).toEqual(["ads/ad_9x16/v1.jpg", "ads/ad_9x16/v2.jpg"]);
    const { stdout } = await execFileAsync("unzip", ["-l", meta.path]);
    expect(stdout).toContain("carousel/01.jpg");
    expect(stdout).toContain(ADS_CSV_NAME);
    const { stdout: csv } = await execFileAsync("unzip", ["-p", meta.path, ADS_CSV_NAME]);
    expect(csv.trim().split("\n")).toEqual([
      "placement,file,headline,call_to_action",
      "meta.feed_1x1,ads/feed_1x1/v1.jpg,Headline v1,Shop now",
      "meta.feed_1x1,ads/feed_1x1/v2.jpg,Headline v2,Shop now",
      "meta.story_9x16,ads/story_9x16/v1.jpg,Headline v1,Shop now",
      "meta.story_9x16,ads/story_9x16/v2.jpg,Headline v2,Shop now",
    ]);
    // Loose files keep the same folders, for the per file downloads.
    expect((await readFile(path.join(outDir, "files", "meta", "carousel", "02.jpg"))).length).toBeGreaterThan(0);
    // The report carries each file's group.
    expect(result.report.files.find((f) => f.file === "carousel/02.jpg")?.group).toEqual({
      kind: "carousel",
      carouselId: "c1",
      slideIndex: 2,
    });
    // No CSV in a zip without ads.
    const onlyCarousel = await buildPack(assets.slice(0, 3), ["meta"], {
      outDir: await mkdtemp(path.join(tmpdir(), "curvi-ads-pack-")),
    });
    const { stdout: list } = await execFileAsync("unzip", ["-l", onlyCarousel.zips[0]!.path]);
    expect(list).not.toContain(ADS_CSV_NAME);
  });
});
