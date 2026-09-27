import { describe, expect, it } from "vitest";
import {
  crossfadeSegments,
  framesForSeconds,
  segmentOpacity,
  slideshowTotalFrames,
  staggeredStarts,
} from "./timing";

describe("framesForSeconds", () => {
  it("converts seconds to whole frames", () => {
    expect(framesForSeconds(6, 30)).toBe(180);
    expect(framesForSeconds(2, 24)).toBe(48);
    expect(framesForSeconds(1.5, 30)).toBe(45);
  });

  it("never returns less than one frame", () => {
    expect(framesForSeconds(0.01, 12)).toBe(1);
  });

  it("rejects non positive seconds and bad fps", () => {
    expect(() => framesForSeconds(0, 30)).toThrow(/seconds/);
    expect(() => framesForSeconds(-1, 30)).toThrow(/seconds/);
    expect(() => framesForSeconds(2, 0)).toThrow(/fps/);
    expect(() => framesForSeconds(2, 29.97)).toThrow(/fps/);
  });
});

describe("crossfadeSegments", () => {
  it("covers the full timeline with overlapping segments", () => {
    const segments = crossfadeSegments(4, 180, 6);
    expect(segments).toHaveLength(4);
    expect(segments[0].from).toBe(0);
    const lastSegment = segments[3];
    expect(lastSegment.from + lastSegment.durationInFrames).toBe(180);
    for (let i = 1; i < segments.length; i++) {
      const previousEnd = segments[i - 1].from + segments[i - 1].durationInFrames;
      const overlap = previousEnd - segments[i].from;
      expect(overlap).toBeGreaterThanOrEqual(5);
      expect(overlap).toBeLessThanOrEqual(7);
    }
  });

  it("partitions exactly when overlap is zero", () => {
    const segments = crossfadeSegments(3, 90, 0);
    expect(segments[0].from).toBe(0);
    for (let i = 1; i < segments.length; i++) {
      const previousEnd = segments[i - 1].from + segments[i - 1].durationInFrames;
      expect(segments[i].from).toBe(previousEnd);
    }
    const total = segments.reduce((sum, s) => sum + s.durationInFrames, 0);
    expect(total).toBe(90);
  });

  it("handles a single item", () => {
    const segments = crossfadeSegments(1, 60, 5);
    expect(segments).toEqual([{ index: 0, from: 0, durationInFrames: 60 }]);
  });

  it("rejects invalid inputs", () => {
    expect(() => crossfadeSegments(0, 100, 5)).toThrow(/itemCount/);
    expect(() => crossfadeSegments(5, 3, 0)).toThrow(/totalFrames/);
    expect(() => crossfadeSegments(2, 100, -1)).toThrow(/overlapFrames/);
    expect(() => crossfadeSegments(2, 100, 100)).toThrow(/too large/);
  });
});

describe("segmentOpacity", () => {
  const segment = { index: 1, from: 40, durationInFrames: 50 };

  it("is zero outside the segment", () => {
    expect(segmentOpacity(39, segment, 6, false, false)).toBe(0);
    expect(segmentOpacity(91, segment, 6, false, false)).toBe(0);
  });

  it("ramps in over the fade window", () => {
    expect(segmentOpacity(40, segment, 6, false, false)).toBe(0);
    expect(segmentOpacity(43, segment, 6, false, false)).toBeCloseTo(0.5, 5);
    expect(segmentOpacity(46, segment, 6, false, false)).toBe(1);
  });

  it("ramps out over the fade window", () => {
    expect(segmentOpacity(90, segment, 6, false, false)).toBe(0);
    expect(segmentOpacity(87, segment, 6, false, false)).toBeCloseTo(0.5, 5);
    expect(segmentOpacity(84, segment, 6, false, false)).toBe(1);
  });

  it("does not fade in the first segment or out the last", () => {
    const first = { index: 0, from: 0, durationInFrames: 50 };
    expect(segmentOpacity(0, first, 6, true, false)).toBe(1);
    const last = { index: 3, from: 130, durationInFrames: 50 };
    expect(segmentOpacity(180, last, 6, false, true)).toBe(1);
  });

  it("complementary fades sum to one in the overlap", () => {
    const outgoing = { index: 0, from: 0, durationInFrames: 50 };
    const incoming = { index: 1, from: 44, durationInFrames: 50 };
    for (let frame = 44; frame <= 50; frame++) {
      const sum =
        segmentOpacity(frame, outgoing, 6, true, false) +
        segmentOpacity(frame, incoming, 6, false, true);
      expect(sum).toBeCloseTo(1, 5);
    }
  });
});

describe("staggeredStarts", () => {
  it("spaces entrances evenly", () => {
    expect(staggeredStarts(4, 15, 20)).toEqual([15, 35, 55, 75]);
  });

  it("handles a single entrance", () => {
    expect(staggeredStarts(1, 10, 999)).toEqual([10]);
  });

  it("rejects invalid inputs", () => {
    expect(() => staggeredStarts(0, 0, 10)).toThrow(/count/);
    expect(() => staggeredStarts(3, -1, 10)).toThrow(/firstFrame/);
    expect(() => staggeredStarts(3, 0, -5)).toThrow(/strideFrames/);
  });
});

describe("slideshowTotalFrames", () => {
  it("multiplies slides by the per slide frame count", () => {
    expect(slideshowTotalFrames(3, 3, 30)).toBe(270);
    expect(slideshowTotalFrames(5, 2.5, 24)).toBe(300);
  });

  it("rejects a non positive slide count", () => {
    expect(() => slideshowTotalFrames(0, 3, 30)).toThrow(/slideCount/);
  });
});
