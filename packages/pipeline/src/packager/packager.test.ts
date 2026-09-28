import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getSpec } from "@curvi/specs";
import { encodeJpeg, encodePng } from "../raw";
import { paintRect, rawCanvas, rectMask } from "../testutil";
import { buildPack, channelOf, type PackAsset } from "./index";

const execFileAsync = promisify(execFile);

async function whiteMainAsset(): Promise<PackAsset> {
  const raw = rawCanvas(256, 256, 255, 255, 255);
  const box = { left: 12, top: 12, width: 224, height: 224 };
  paintRect(raw, box, 60, 60, 160);
  return {
    specId: "amazon.main",
    buffer: await encodeJpeg(raw),
    format: "jpg",
    raw,
    mask: rectMask(256, 256, box),
    sku: "ABC123",
    edgeMarginPx: 8,
  };
}

async function secondaryAsset(n: number): Promise<PackAsset> {
  const raw = rawCanvas(256, 256, 240, 240, 240);
  paintRect(raw, { left: 40, top: 40, width: 160, height: 160 }, 160, 60, 60);
  return {
    specId: "amazon.secondary",
    buffer: await encodeJpeg(raw),
    format: "jpg",
    sku: "ABC123",
    n,
  };
}

describe("buildPack", () => {
  it("names files per spec and zips per channel with a compliance report", async () => {
    const outDir = await mkdtemp(path.join(tmpdir(), "curvi-pack-test-"));
    const shopifyRaw = rawCanvas(256, 256, 250, 250, 250);
    paintRect(shopifyRaw, { left: 60, top: 60, width: 120, height: 120 }, 30, 120, 60);
    const result = await buildPack(
      [
        await whiteMainAsset(),
        await secondaryAsset(1),
        await secondaryAsset(2),
        {
          specId: "shopify.product",
          buffer: await encodeJpeg(shopifyRaw),
          format: "jpg",
          seoSlug: "ceramic-pour-over-mug",
          n: 1,
        },
      ],
      ["amazon", "shopify"],
      { outDir },
    );

    const amazonZip = result.zips.find((z) => z.channel === "amazon");
    const shopifyZip = result.zips.find((z) => z.channel === "shopify");
    expect(amazonZip?.files).toContain("ABC123.MAIN.jpg");
    expect(amazonZip?.files).toContain("ABC123.PT01.jpg");
    expect(amazonZip?.files).toContain("ABC123.PT02.jpg");
    expect(shopifyZip?.files).toContain("ceramic-pour-over-mug-1.jpg");

    for (const zip of result.zips) {
      const info = await stat(zip.path);
      expect(info.size).toBeGreaterThan(0);
      // The zip actually contains the named entries plus the channel report.
      const { stdout } = await execFileAsync("unzip", ["-l", zip.path]);
      for (const file of zip.files) {
        expect(stdout).toContain(file);
      }
      expect(stdout).toContain("compliance-report.json");
    }

    const report = JSON.parse(await readFile(result.reportPath, "utf8"));
    expect(report.files).toHaveLength(4);
    const mainEntry = report.files.find((f: { file: string }) => f.file === "ABC123.MAIN.jpg");
    expect(mainEntry.specId).toBe("amazon.main");
    expect(Array.isArray(mainEntry.checks)).toBe(true);
    expect(mainEntry.checks.length).toBeGreaterThan(0);
    expect(mainEntry.measured.backgroundWhiteShare).toBe(1);
    for (const check of mainEntry.checks) {
      expect(check).toHaveProperty("name");
      expect(check).toHaveProperty("pass");
      expect(check).toHaveProperty("measured");
      expect(check).toHaveProperty("limit");
    }
  });

  it("never applies a badge to marketplace bound files", async () => {
    const asset = await whiteMainAsset();
    asset.badge = true;
    const result = await buildPack([asset], ["amazon"]);
    const entry = result.report.files[0];
    expect(entry.badge).toBe(false);
    expect(entry.notes.join(" ")).toMatch(/badge suppressed/);
  });

  it("allows a badge only where the spec says badgeAllowed", async () => {
    const raw = rawCanvas(128, 128, 250, 250, 250);
    const social: PackAsset = {
      specId: "meta.feed_1x1",
      buffer: await encodePng(raw),
      format: "png",
      badge: true,
    };
    const result = await buildPack([social], ["meta"]);
    expect(result.report.files[0].badge).toBe(true);
    // Sanity: the registry agrees meta social allows badges and amazon does not.
    expect(getSpec("meta.feed_1x1").badgeAllowed).toBe(true);
    expect(getSpec("amazon.main").badgeAllowed).toBeUndefined();
  });

  it("skips assets whose channel was not requested", async () => {
    const result = await buildPack([await whiteMainAsset()], ["shopify"]);
    expect(result.zips).toHaveLength(0);
    expect(result.report.files).toHaveLength(0);
  });

  it("derives the channel family from the spec id", () => {
    expect(channelOf("amazon.main")).toBe("amazon");
    expect(channelOf("google.merchant.main")).toBe("google");
    expect(channelOf("meta.feed_1x1")).toBe("meta");
  });
});

describe("withExtension", () => {
  it("names files after their real format", async () => {
    const { withExtension } = await import("./index");
    expect(withExtension("SKU1.MAIN.jpg", "png")).toBe("SKU1.MAIN.png");
    expect(withExtension("SKU1.PT01.jpg", "jpeg")).toBe("SKU1.PT01.jpg");
    expect(withExtension("slug-1.jpg", "jpg")).toBe("slug-1.jpg");
    expect(withExtension("noext", "png")).toBe("noext.png");
  });
});
