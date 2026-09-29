import { describe, expect, it } from "vitest";
import {
  analyzeInventory,
  chooseInventoryTarget,
  colorNameOf,
  inventoryRecord,
  matchProducts,
  noteSignals,
  shapeOf,
  type InventoryObject,
  type NoteSignals,
} from "./inventory";
import { isolateComponents, type PixelRect } from "./isolate";
import type { RawImage } from "./raw";
import type { IntakeProduct } from "./schemas";

type Rect = PixelRect & { rgb: [number, number, number]; alpha?: number };

/** A transparent cutout with opaque rectangles, like Photoroom output. */
function cutout(width: number, height: number, rects: Rect[]): RawImage {
  const data = Buffer.alloc(width * height * 4, 0);
  for (const r of rects) {
    for (let y = r.top; y < r.top + r.height; y++) {
      for (let x = r.left; x < r.left + r.width; x++) {
        const o = (y * width + x) * 4;
        data[o] = r.rgb[0];
        data[o + 1] = r.rgb[1];
        data[o + 2] = r.rgb[2];
        data[o + 3] = r.alpha ?? 255;
      }
    }
  }
  return { data, width, height, channels: 4 };
}

const RED: [number, number, number] = [200, 30, 30];
const BLUE: [number, number, number] = [30, 40, 200];
const none: NoteSignals = { wantColors: [], excludeColors: [], wantWords: [], excludeWords: [] };

/** Two tall bottles on a 400 x 300 cutout: red at x 40, blue at x 200. */
function twoBottles(gap = 10): RawImage {
  return cutout(400, 300, [
    { left: 40, top: 50, width: 150, height: 200, rgb: RED },
    { left: 190 + gap, top: 50, width: 150, height: 200, rgb: BLUE },
  ]);
}

const redBox = { x: 0.1, y: 50 / 300, width: 0.375, height: 200 / 300 };
const blueBox = { x: 0.5, y: 50 / 300, width: 0.375, height: 200 / 300 };
const product = (label: string, box: IntakeProduct["box"], matchesIntent: IntakeProduct["matchesIntent"] = "unclear") => ({
  label,
  box,
  matchesIntent,
});

describe("color names", () => {
  it("reads the fixed hue table and the black, white and gray rules", () => {
    expect(colorNameOf(200, 30, 30)).toBe("red");
    expect(colorNameOf(240, 140, 20)).toBe("orange");
    expect(colorNameOf(230, 220, 40)).toBe("yellow");
    expect(colorNameOf(40, 180, 60)).toBe("green");
    expect(colorNameOf(20, 170, 170)).toBe("teal");
    expect(colorNameOf(30, 40, 200)).toBe("blue");
    expect(colorNameOf(120, 40, 200)).toBe("purple");
    expect(colorNameOf(230, 60, 180)).toBe("pink");
    expect(colorNameOf(240, 170, 170)).toBe("pink");
    expect(colorNameOf(120, 70, 20)).toBe("brown");
    expect(colorNameOf(20, 20, 25)).toBe("black");
    expect(colorNameOf(245, 245, 240)).toBe("white");
    expect(colorNameOf(128, 128, 128)).toBe("gray");
  });

  it("classes shapes by height over width", () => {
    expect(shapeOf(2)).toBe("tall");
    expect(shapeOf(0.5)).toBe("wide");
    expect(shapeOf(1.1)).toBe("square");
  });
});

describe("analyzeInventory", () => {
  it("finds two bottles of different colors with their boxes, shapes and colors", () => {
    const inv = analyzeInventory(twoBottles());
    expect(inv.objects).toHaveLength(2);
    const [red, blue] = inv.objects;
    expect(red.box).toEqual({ x: 0.1, y: 0.1667, width: 0.375, height: 0.6667 });
    expect(red.shape).toBe("tall");
    expect(red.color).toEqual({ hex: "#c81e1e", name: "red", shares: { red: 1 } });
    expect(blue.color.name).toBe("blue");
    expect(blue.color.hex).toBe("#1e28c8");
    expect(red.areaShare).toBeCloseTo((150 * 200) / (400 * 300), 3);
    expect(red.aspectRatio).toBeCloseTo(200 / 150, 3);
  });

  it("counts touching objects as one piece holding both colors", () => {
    const inv = analyzeInventory(twoBottles(0));
    expect(inv.objects).toHaveLength(1);
    expect(inv.objects[0].shape).toBe("wide");
    expect(inv.objects[0].color.shares.red).toBeGreaterThan(0.4);
    expect(inv.objects[0].color.shares.blue).toBeGreaterThan(0.4);
  });

  it("keeps an object with a transparent hole as one piece, colored by its opaque pixels", () => {
    const ring = cutout(200, 200, [
      { left: 50, top: 50, width: 100, height: 100, rgb: [40, 180, 60] },
      // The hole: fully transparent, colored pixels that must not count.
      { left: 75, top: 75, width: 50, height: 50, rgb: [255, 0, 0], alpha: 0 },
    ]);
    const inv = analyzeInventory(ring);
    expect(inv.objects).toHaveLength(1);
    expect(inv.objects[0].color.name).toBe("green");
    expect(inv.objects[0].color.shares).toEqual({ green: 1 });
    expect(inv.objects[0].areaShare).toBeCloseTo((100 * 100 - 50 * 50) / (200 * 200), 4);
  });

  it("never counts noise specks as products", () => {
    const specks = cutout(400, 300, [
      { left: 40, top: 50, width: 150, height: 200, rgb: RED },
      { left: 300, top: 10, width: 3, height: 3, rgb: BLUE },
      { left: 380, top: 280, width: 5, height: 5, rgb: BLUE },
    ]);
    const inv = analyzeInventory(specks);
    expect(inv.objects).toHaveLength(1);
    expect(inv.noisePieces).toBe(2);
  });

  it("colors a piece by its opaque pixels, not its soft edge", () => {
    const soft = cutout(200, 200, [
      { left: 40, top: 40, width: 100, height: 100, rgb: BLUE },
      { left: 30, top: 40, width: 10, height: 100, rgb: RED, alpha: 60 },
    ]);
    const inv = analyzeInventory(soft);
    expect(inv.objects).toHaveLength(1);
    expect(inv.objects[0].color.shares).toEqual({ blue: 1 });
  });
});

describe("noteSignals", () => {
  it("reads the production note: blue wanted, red excluded, the shared brand word dropped", () => {
    expect(noteSignals("Blue Gatorade only, delete the red gatorade fully")).toEqual({
      wantColors: ["blue"],
      excludeColors: ["red"],
      wantWords: [],
      excludeWords: [],
    });
  });

  it("adds the parsed intent and splits a clause at its exclusion word", () => {
    expect(
      noteSignals("I want the navy mug and remove the silver kettles", {
        featureOnly: null,
        exclude: ["crimson tray"],
        mustKeep: [],
        styleNotes: null,
      }),
    ).toEqual({ wantColors: ["blue"], excludeColors: ["gray", "red"], wantWords: ["mug"], excludeWords: ["kettle", "tray"] });
  });

  it("is empty without a note or intent", () => {
    expect(noteSignals(undefined, null)).toEqual(none);
    expect(noteSignals("Bright and airy, on a kitchen counter")).toEqual({
      ...none,
      wantWords: ["airy", "bright", "counter", "kitchen"],
    });
  });
});

describe("chooseInventoryTarget", () => {
  const objects = (img = twoBottles()): InventoryObject[] => analyzeInventory(img).objects;
  const gatorade = noteSignals("Blue Gatorade only, delete the red gatorade fully");

  it("picks the blue bottle from the note alone, with no model products at all", () => {
    expect(chooseInventoryTarget({ objects: objects(), products: [], signals: gatorade })).toEqual({
      rule: "note",
      featured: [1],
      removed: [0],
      touching: false,
    });
  });

  it("takes the model's single yes when it agrees with the note's color", () => {
    const products = [product("red bottle", redBox, "no"), product("blue bottle", blueBox, "yes")];
    expect(chooseInventoryTarget({ objects: objects(), products, signals: gatorade }).rule).toBe("model");
  });

  it("treats the model's yes on red as ambiguous when the note names blue", () => {
    const products = [product("red bottle", redBox, "yes"), product("blue bottle", blueBox, "no")];
    const decision = chooseInventoryTarget({ objects: objects(), products, signals: gatorade });
    expect(decision.rule).toBe("conflict");
    expect(decision.featured).toEqual([]);
  });

  it("takes the model's yes when the note names no color", () => {
    const products = [product("red bottle", redBox, "yes"), product("blue bottle", blueBox, "no")];
    expect(chooseInventoryTarget({ objects: objects(), products, signals: none })).toMatchObject({
      rule: "model",
      featured: [0],
      removed: [1],
    });
  });

  it("uses a single piece whole and leaves several without any signal ambiguous", () => {
    const one = objects(cutout(400, 300, [{ left: 40, top: 50, width: 150, height: 200, rgb: RED }]));
    expect(chooseInventoryTarget({ objects: one, products: [], signals: none })).toMatchObject({
      rule: "single_object",
      featured: [0],
      removed: [],
    });
    expect(chooseInventoryTarget({ objects: objects(), products: [], signals: none }).rule).toBe("ambiguous");
  });

  it("keeps every piece of an in the box photo", () => {
    expect(chooseInventoryTarget({ objects: objects(), products: [], signals: none, multiItem: true })).toMatchObject({
      rule: "in_the_box",
      featured: [0, 1],
      removed: [],
    });
  });

  it("keeps a product in two parts when intake saw one product around both", () => {
    const products = [product("earrings", { x: 0.05, y: 0.1, width: 0.9, height: 0.8 })];
    expect(chooseInventoryTarget({ objects: objects(), products, signals: none })).toMatchObject({
      rule: "single_product",
      featured: [0, 1],
      removed: [],
    });
  });

  it("marks touching products the note wants apart", () => {
    const merged = objects(twoBottles(0));
    const products = [product("red bottle", redBox, "no"), product("blue bottle", blueBox, "yes")];
    expect(chooseInventoryTarget({ objects: merged, products, signals: gatorade })).toMatchObject({
      rule: "model",
      touching: true,
    });
    // No model products at all: the excluded red inside the piece gives it away.
    expect(chooseInventoryTarget({ objects: merged, products: [], signals: gatorade })).toMatchObject({
      touching: true,
    });
  });
});

describe("inventoryRecord", () => {
  it("labels matched pieces from intake, the rest deterministically, and records agreement", () => {
    const inv = analyzeInventory(twoBottles());
    const products = [product("Blue Gatorade bottle", blueBox, "yes"), product("mug", { x: 0.9, y: 0.9, width: 0.05, height: 0.05 })];
    const signals = noteSignals("Blue Gatorade only, delete the red gatorade fully");
    const decision = chooseInventoryTarget({ objects: inv.objects, products, signals });
    const record = inventoryRecord({ mediaId: "m1", inventory: inv, products, decision });
    expect(record.items.map((i) => [i.label, i.labelSource, i.status, i.colorName, i.shape])).toEqual([
      ["red tall object", "deterministic", "removed", "red", "tall"],
      ["Blue Gatorade bottle", "intake", "featured", "blue", "tall"],
    ]);
    expect(record.intakeCount).toBe(2);
    expect(record.countMatch).toBe(true);
    expect(record.unmatchedItems).toEqual([0]);
    expect(record.unmatchedProducts).toEqual(["mug"]);
    expect(matchProducts(inv.objects, products).productOf).toEqual([null, 0]);
  });
});

describe("isolateComponents", () => {
  it("keeps the chosen piece byte identical and zeroes the others", () => {
    const img = twoBottles();
    const [red, blue] = analyzeInventory(img).objects;
    const out = isolateComponents(img, [blue.pixelBox], [red.pixelBox]);
    expect(out.missing).toBe(false);
    for (let y = 0; y < img.height; y++) {
      for (let x = 0; x < img.width; x++) {
        const o = (y * img.width + x) * 4;
        const inBlue = x >= 200 && x < 350 && y >= 50 && y < 250;
        const got = [...out.image.data.subarray(o, o + 4)];
        expect(got).toEqual(inBlue ? [...img.data.subarray(o, o + 4)] : [0, 0, 0, 0]);
      }
    }
  });

  it("says when a chosen box matches no piece", () => {
    const img = twoBottles();
    expect(isolateComponents(img, [{ left: 0, top: 0, width: 10, height: 10 }]).missing).toBe(true);
  });
});
