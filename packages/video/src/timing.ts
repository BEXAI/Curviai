/**
 * Pure frame timing math for the Remotion templates.
 * No React or Remotion imports here so the planner and tests can use these directly.
 */

export interface FrameSegment {
  index: number;
  from: number;
  durationInFrames: number;
}

export function assertFps(fps: number): void {
  if (!Number.isInteger(fps) || fps <= 0) {
    throw new Error(`fps must be a positive integer, got ${fps}`);
  }
}

function assertPositiveFinite(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive finite number, got ${value}`);
  }
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** Convert a duration in seconds to a whole frame count, never below 1. */
export function framesForSeconds(seconds: number, fps: number): number {
  assertPositiveFinite(seconds, "seconds");
  assertFps(fps);
  return Math.max(1, Math.round(seconds * fps));
}

/**
 * Split totalFrames across itemCount segments where consecutive segments
 * overlap by overlapFrames for a crossfade. The first segment starts at
 * frame 0 and the last one ends exactly at totalFrames.
 */
export function crossfadeSegments(
  itemCount: number,
  totalFrames: number,
  overlapFrames: number,
): FrameSegment[] {
  if (!Number.isInteger(itemCount) || itemCount < 1) {
    throw new Error(`itemCount must be a positive integer, got ${itemCount}`);
  }
  if (!Number.isInteger(totalFrames) || totalFrames < itemCount) {
    throw new Error(
      `totalFrames must be an integer of at least itemCount (${itemCount}), got ${totalFrames}`,
    );
  }
  if (!Number.isInteger(overlapFrames) || overlapFrames < 0) {
    throw new Error(`overlapFrames must be a non negative integer, got ${overlapFrames}`);
  }
  const segmentLength = (totalFrames + (itemCount - 1) * overlapFrames) / itemCount;
  if (overlapFrames > 0 && overlapFrames >= segmentLength) {
    throw new Error(
      `overlapFrames (${overlapFrames}) is too large for ${itemCount} segments over ${totalFrames} frames`,
    );
  }
  const stride = segmentLength - overlapFrames;
  const segments: FrameSegment[] = [];
  for (let i = 0; i < itemCount; i++) {
    const from = Math.round(i * stride);
    const to =
      i === itemCount - 1 ? totalFrames : Math.min(totalFrames, Math.round(i * stride + segmentLength));
    segments.push({ index: i, from, durationInFrames: to - from });
  }
  return segments;
}

/**
 * Opacity of one crossfade segment at a global frame. Ramps in over
 * fadeFrames at the start (unless it is the first segment) and ramps out
 * over fadeFrames at the end (unless it is the last segment).
 */
export function segmentOpacity(
  frame: number,
  segment: FrameSegment,
  fadeFrames: number,
  isFirst: boolean,
  isLast: boolean,
): number {
  const local = frame - segment.from;
  if (local < 0 || local > segment.durationInFrames) {
    return 0;
  }
  let opacity = 1;
  if (fadeFrames > 0 && !isFirst) {
    opacity = Math.min(opacity, clamp01(local / fadeFrames));
  }
  if (fadeFrames > 0 && !isLast) {
    opacity = Math.min(opacity, clamp01((segment.durationInFrames - local) / fadeFrames));
  }
  return opacity;
}

/** Start frames for a run of staggered entrances. */
export function staggeredStarts(count: number, firstFrame: number, strideFrames: number): number[] {
  if (!Number.isInteger(count) || count < 1) {
    throw new Error(`count must be a positive integer, got ${count}`);
  }
  if (!Number.isFinite(firstFrame) || firstFrame < 0) {
    throw new Error(`firstFrame must be a non negative number, got ${firstFrame}`);
  }
  if (!Number.isFinite(strideFrames) || strideFrames < 0) {
    throw new Error(`strideFrames must be a non negative number, got ${strideFrames}`);
  }
  return Array.from({ length: count }, (_, i) => Math.round(firstFrame + i * strideFrames));
}

/** Total frame count for a slideshow where every slide holds for the same time. */
export function slideshowTotalFrames(
  slideCount: number,
  secondsPerSlide: number,
  fps: number,
): number {
  if (!Number.isInteger(slideCount) || slideCount < 1) {
    throw new Error(`slideCount must be a positive integer, got ${slideCount}`);
  }
  return slideCount * framesForSeconds(secondsPerSlide, fps);
}
