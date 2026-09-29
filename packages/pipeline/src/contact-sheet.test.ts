import { describe, expect, it } from "vitest";
import { renderContactSheet } from "./contact-sheet";
import { analyzeInventory, pickerNumbering } from "./inventory";
import { decodeToRgba, type RawImage } from "./raw";

/** A transparent 200 x 100 cutout: a blue bar on the right, a red one on the
 * left, 4 px apart so each piece's margin reaches into the other. */
function twoPieces(): RawImage {
  const width = 200;
  const height = 100;
  const data = Buffer.alloc(width * height * 4, 0);
  const fill = (x0: number, x1: number, rgb: [number, number, number]) => {
    for (let y = 10; y < 90; y++) {
      for (let x = x0; x < x1; x++) {
        const o = (y * width + x) * 4;
        data[o] = rgb[0];
        data[o + 1] = rgb[1];
        data[o + 2] = rgb[2];
        data[o + 3] = 255;
      }
    }
  };
  fill(40, 96, [210, 20, 20]);
  fill(100, 160, [20, 30, 210]);
  return { data, width, height, channels: 4 };
}

function colorsIn(img: RawImage, rect: { left: number; top: number; width: number; height: number }) {
  let red = 0;
  let blue = 0;
  let dark = 0;
  for (let y = rect.top; y < rect.top + rect.height; y++) {
    for (let x = rect.left; x < rect.left + rect.width; x++) {
      const o = (y * img.width + x) * 4;
      const [r, g, b] = [img.data[o], img.data[o + 1], img.data[o + 2]];
      if (r > 150 && g < 90 && b < 90) red++;
      if (b > 150 && r < 90 && g < 90) blue++;
      if (r < 60 && g < 60 && b < 60) dark++;
    }
  }
  return { red, blue, dark };
}

describe("renderContactSheet", () => {
  for (const [name, font] of [
    ["the template font", undefined],
    ["seven segment digits", null],
  ] as const) {
    it(`draws each piece alone in its numbered cell on gray, with ${name}`, async () => {
      const cutout = twoPieces();
      const inventory = analyzeInventory(cutout);
      expect(inventory.objects).toHaveLength(2);
      const order = pickerNumbering(inventory.objects).map((i) => inventory.objects[i]);
      // Numbered left to right: the red piece is 1.
      expect(order.map((o) => o.color.name)).toEqual(["red", "blue"]);

      const sheet = await renderContactSheet(
        cutout,
        order.map((o) => o.pixelBox),
        { cell: 160, gap: 16, band: 64, ...(font === null ? { font: null } : {}) },
      );
      expect(sheet.buffer.subarray(0, 2).toString("hex")).toBe("ffd8");
      expect(sheet.width).toBe(2 * 160 + 3 * 16);
      expect(sheet.height).toBe(64 + 160 + 2 * 16);
      if (font === null) expect(sheet.digits).toBe("segments");

      const img = await decodeToRgba(sheet.buffer);
      expect(img.width).toBe(sheet.width);
      const [first, second] = sheet.cells;
      const inFirst = colorsIn(img, first);
      const inSecond = colorsIn(img, second);
      // Each cell shows its own piece and not a pixel of the neighbor, even
      // where the margin reaches into it.
      expect(inFirst.red).toBeGreaterThan(1000);
      expect(inFirst.blue).toBe(0);
      expect(inSecond.blue).toBeGreaterThan(1000);
      expect(inSecond.red).toBe(0);
      // The background is neutral gray.
      const o = (Math.round(first.top + 2) * img.width + first.left + 2) * 4;
      expect(Math.abs(img.data[o] - img.data[o + 1])).toBeLessThan(6);
      expect(Math.abs(img.data[o + 1] - img.data[o + 2])).toBeLessThan(6);
      // A dark number is drawn in the band above each cell.
      for (const cell of sheet.cells) {
        const band = colorsIn(img, { left: cell.left, top: cell.top - 64, width: cell.width, height: 64 });
        expect(band.dark).toBeGreaterThan(50);
      }
    });
  }

  it("wraps more than three pieces onto a second row", async () => {
    const cutout = twoPieces();
    const box = { left: 40, top: 10, width: 56, height: 80 };
    const sheet = await renderContactSheet(cutout, [box, box, box, box], { cell: 100, gap: 10, band: 40, font: null });
    expect(sheet.width).toBe(3 * 100 + 4 * 10);
    expect(sheet.height).toBe(2 * (40 + 100) + 3 * 10);
    expect(sheet.cells[3]).toMatchObject({ left: 10, top: 10 + 140 + 10 + 40 });
  });

  it("refuses an empty sheet", async () => {
    await expect(renderContactSheet(twoPieces(), [])).rejects.toThrow();
  });
});
