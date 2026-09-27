import { describe, expect, it } from "vitest";
import { dimensionsForFormat } from "../schemas";
import {
  calculateDimensionRevealMetadata,
  dimensionRevealSchema,
} from "./DimensionReveal";
import { calculateFeatureCalloutsMetadata, featureCalloutsSchema } from "./FeatureCallouts";
import { calculateSlideshowMetadata, slideshowSchema } from "./Slideshow";
import { calculateSpin360Metadata, spin360Schema } from "./Spin360";

const metadataOptions = {
  abortSignal: new AbortController().signal,
  compositionId: "test",
  isRendering: false,
};

describe("dimensionsForFormat", () => {
  it("maps formats to pixel sizes", () => {
    expect(dimensionsForFormat("9x16")).toEqual({ width: 1080, height: 1920 });
    expect(dimensionsForFormat("1x1")).toEqual({ width: 1080, height: 1080 });
  });
});

describe("spin360Schema", () => {
  const valid = { images: ["a.png", "b.png", "c.png"] };

  it("applies defaults", () => {
    const parsed = spin360Schema.parse(valid);
    expect(parsed.format).toBe("9x16");
    expect(parsed.fps).toBe(30);
    expect(parsed.durationInSeconds).toBe(6);
    expect(parsed.brand.ink).toMatch(/^#[0-9A-Fa-f]{6}$/);
    expect(parsed.brand.accent).toMatch(/^#[0-9A-Fa-f]{6}$/);
  });

  it("rejects fewer than two images", () => {
    expect(() => spin360Schema.parse({ images: ["only.png"] })).toThrow();
  });

  it("rejects a bad brand hex", () => {
    expect(() => spin360Schema.parse({ ...valid, brand: { ink: "red" } })).toThrow();
  });

  it("rejects a non integer fps", () => {
    expect(() => spin360Schema.parse({ ...valid, fps: 29.97 })).toThrow();
  });

  it("rejects emoji in the product name", () => {
    expect(() => spin360Schema.parse({ ...valid, productName: "Bottle ⚡" })).toThrow();
  });
});

describe("slideshowSchema", () => {
  it("accepts slides with optional captions", () => {
    const parsed = slideshowSchema.parse({
      slides: [{ image: "a.png", caption: "Built to last" }, { image: "b.png" }],
    });
    expect(parsed.slides).toHaveLength(2);
    expect(parsed.secondsPerSlide).toBe(3);
  });

  it("rejects an empty slide list", () => {
    expect(() => slideshowSchema.parse({ slides: [] })).toThrow();
  });

  it("rejects emoji in captions", () => {
    expect(() =>
      slideshowSchema.parse({ slides: [{ image: "a.png", caption: "Great ✨" }] }),
    ).toThrow();
  });
});

describe("featureCalloutsSchema", () => {
  const valid = {
    heroImage: "hero.png",
    callouts: ["Stainless steel body", "Leak proof lid", "Fits cup holders"],
  };

  it("accepts three to five callouts", () => {
    expect(featureCalloutsSchema.parse(valid).callouts).toHaveLength(3);
    expect(() =>
      featureCalloutsSchema.parse({ ...valid, callouts: valid.callouts.slice(0, 2) }),
    ).toThrow();
    expect(() =>
      featureCalloutsSchema.parse({
        ...valid,
        callouts: ["a", "b", "c", "d", "e", "f"],
      }),
    ).toThrow();
  });

  it("rejects emoji in callouts", () => {
    expect(() =>
      featureCalloutsSchema.parse({
        ...valid,
        callouts: ["Stainless steel", "Leak proof", "Cold drinks \u{1F9CA}"],
      }),
    ).toThrow();
  });

  it("rejects callouts over 40 characters", () => {
    expect(() =>
      featureCalloutsSchema.parse({
        ...valid,
        callouts: ["a".repeat(41), "Leak proof lid", "Fits cup holders"],
      }),
    ).toThrow();
  });
});

describe("dimensionRevealSchema", () => {
  it("defaults the measurement edge to bottom", () => {
    const parsed = dimensionRevealSchema.parse({
      image: "a.png",
      measurements: [{ label: "25 cm wide" }],
    });
    expect(parsed.measurements[0].edge).toBe("bottom");
  });

  it("rejects an empty measurement list", () => {
    expect(() => dimensionRevealSchema.parse({ image: "a.png", measurements: [] })).toThrow();
  });

  it("rejects an unknown edge", () => {
    expect(() =>
      dimensionRevealSchema.parse({
        image: "a.png",
        measurements: [{ label: "25 cm", edge: "middle" }],
      }),
    ).toThrow();
  });
});

describe("calculateMetadata", () => {
  it("derives portrait dimensions and frame count for Spin360", async () => {
    const meta = await calculateSpin360Metadata({
      ...metadataOptions,
      props: { images: ["a.png", "b.png"], durationInSeconds: 6, fps: 30 },
      defaultProps: { images: ["a.png", "b.png"] },
    });
    expect(meta.width).toBe(1080);
    expect(meta.height).toBe(1920);
    expect(meta.fps).toBe(30);
    expect(meta.durationInFrames).toBe(180);
  });

  it("derives square dimensions when the format prop asks for 1x1", async () => {
    const meta = await calculateFeatureCalloutsMetadata({
      ...metadataOptions,
      props: {
        heroImage: "hero.png",
        callouts: ["One good thing", "Another good thing", "A third good thing"],
        format: "1x1",
        durationInSeconds: 8,
        fps: 24,
      },
      defaultProps: {
        heroImage: "hero.png",
        callouts: ["One good thing", "Another good thing", "A third good thing"],
      },
    });
    expect(meta.width).toBe(1080);
    expect(meta.height).toBe(1080);
    expect(meta.durationInFrames).toBe(192);
  });

  it("derives slideshow duration from the slide count", async () => {
    const meta = await calculateSlideshowMetadata({
      ...metadataOptions,
      props: { slides: [{ image: "a.png" }, { image: "b.png" }], secondsPerSlide: 2, fps: 30 },
      defaultProps: { slides: [{ image: "a.png" }] },
    });
    expect(meta.durationInFrames).toBe(120);
  });

  it("derives dimension reveal duration from props", async () => {
    const meta = await calculateDimensionRevealMetadata({
      ...metadataOptions,
      props: {
        image: "a.png",
        measurements: [{ label: "25 cm wide" }],
        durationInSeconds: 5,
        fps: 30,
        format: "1x1",
      },
      defaultProps: { image: "a.png", measurements: [{ label: "25 cm wide" }] },
    });
    expect(meta.durationInFrames).toBe(150);
    expect(meta.width).toBe(1080);
    expect(meta.height).toBe(1080);
  });
});
