import { decodeToRgba, type RawImage } from "@curvi/pipeline";

/**
 * Alpha at and above which a cutout pixel counts as the product itself.
 * Those pixels, the solid body and the inner half of the soft border, take
 * their color from the photo that was sent, never from the segmentation
 * service's foreground estimate: the service may repaint border pixels, and
 * rule 3 says product pixels are the seller's own. Below it, the faint outer
 * fringe keeps the service's refined color, which is what stops the old
 * background showing as a halo on a new one.
 */
export const EDGE_RESTORE_MIN_ALPHA = 128;

/**
 * The cutout with every product pixel's color restored from the photo that
 * was cut out, keeping the service's alpha. Returns the cutout unchanged
 * when the photo cannot be decoded or its size differs from the cutout's.
 */
export async function restoreSourceEdges(cutout: RawImage, sentBytes: Buffer): Promise<RawImage> {
  const source = await decodeToRgba(sentBytes).catch(() => null);
  if (!source || source.width !== cutout.width || source.height !== cutout.height) {
    return cutout;
  }
  return restoreSourceEdgesRaw(cutout, source);
}

/** Pure form of restoreSourceEdges, on two decoded images of one size. */
export function restoreSourceEdgesRaw(cutout: RawImage, source: RawImage): RawImage {
  const data = Buffer.from(cutout.data);
  for (let i = 0; i < cutout.width * cutout.height; i++) {
    const o = i * 4;
    if (data[o + 3] >= EDGE_RESTORE_MIN_ALPHA) {
      data[o] = source.data[o];
      data[o + 1] = source.data[o + 1];
      data[o + 2] = source.data[o + 2];
    }
  }
  return { ...cutout, data };
}
