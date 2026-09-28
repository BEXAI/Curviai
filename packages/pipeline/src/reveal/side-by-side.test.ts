import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { renderSideBySide } from "./side-by-side";

async function solid(width: number, height: number, rgb: [number, number, number]): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: rgb[0], g: rgb[1], b: rgb[2] } } })
    .png()
    .toBuffer();
}

async function pixel(image: Buffer, x: number, y: number): Promise<[number, number, number]> {
  const { data, info } = await sharp(image).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const i = (y * info.width + x) * info.channels;
  return [data[i], data[i + 1], data[i + 2]];
}

function near(actual: [number, number, number], expected: [number, number, number], tolerance = 12): boolean {
  return actual.every((v, i) => Math.abs(v - expected[i]) <= tolerance);
}

describe("renderSideBySide", () => {
  it("puts the original on the left and the shot on the right, each in its own panel", async () => {
    const before = await solid(300, 200, [200, 40, 40]);
    const after = await solid(200, 300, [40, 40, 200]);
    const result = await renderSideBySide({ before, after, panel: 200, gap: 10, beforeLabel: "", afterLabel: "" });

    expect(result.width).toBe(200 * 2 + 10 * 3);
    expect(result.height).toBe(200 + 10 * 2);
    const meta = await sharp(result.buffer).metadata();
    expect(meta.format).toBe("jpeg");
    expect(meta.width).toBe(result.width);

    // Panel centers carry each picture's own color.
    expect(near(await pixel(result.buffer, 10 + 100, 10 + 100), [200, 40, 40])).toBe(true);
    expect(near(await pixel(result.buffer, 20 + 200 + 100, 10 + 100), [40, 40, 200])).toBe(true);
  });

  it("fits whole pictures without cropping: a wide photo is letterboxed, not cut", async () => {
    const before = await solid(400, 100, [200, 40, 40]);
    const after = await solid(100, 100, [40, 40, 200]);
    const result = await renderSideBySide({ before, after, panel: 200, gap: 0, beforeLabel: "", afterLabel: "" });
    // 400x100 fitted into 200x200 is 200x50, centered: the panel's top edge is background.
    expect(near(await pixel(result.buffer, 100, 5), [255, 255, 255])).toBe(true);
    expect(near(await pixel(result.buffer, 100, 100), [200, 40, 40])).toBe(true);
  });

  it("reads SVG input, as the demo previews are SVG", async () => {
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="#28a028"/></svg>',
    );
    const result = await renderSideBySide({ before: svg, after: svg, panel: 120, gap: 6, beforeLabel: "", afterLabel: "" });
    expect(near(await pixel(result.buffer, 6 + 60, 6 + 60), [40, 160, 40])).toBe(true);
  });

  it("draws labels from the bundled font when it is present", async () => {
    const before = await solid(100, 100, [255, 255, 255]);
    const result = await renderSideBySide({ before, after: before, panel: 400, gap: 0, beforeLabel: "Before", afterLabel: "After" });
    // The font ships with the package in this repo, so labels render.
    expect(result.labeled).toBe(true);
    // The label pill darkens the top left corner of the left panel.
    const corner = await pixel(result.buffer, Math.round(400 / 36) + 4, Math.round(400 / 36) + 4);
    expect(corner[0]).toBeLessThan(200);
  });

  it("rejects input that is not an image", async () => {
    await expect(
      renderSideBySide({ before: Buffer.from("not an image"), after: Buffer.from("nope"), panel: 100 }),
    ).rejects.toThrow();
  });
});
