/**
 * The Amazon main image checker's measurements, kept free of the DOM so they
 * can be unit tested. The browser draws the photo onto a white canvas, reads
 * the pixels back and hands them here.
 *
 * Two fixes from Update.md: transparent pixels are composited on white before
 * they are measured, so a cutout PNG no longer reads as black with a 100
 * percent fill (6.9); and the fill must sit between the spec's minimum and
 * maximum, measured the way pipeline QC measures it, the product's longest
 * bounding box side over the frame's longest side (6.10).
 */

/** The amazon.main thresholds, passed in from the spec registry (CLAUDE.md rule 2). */
export interface CheckerRules {
  minLongSide: number;
  fillMinPercent: number;
  fillMaxPercent: number;
}

export interface CheckRow {
  /** Stable key for tests and the summary. */
  key: "resolution" | "background" | "fill";
  label: string;
  pass: boolean;
  measured: string;
}

export interface PixelMeasurements {
  /** Share of edge band pixels at exactly 255 255 255. */
  borderWhiteShare: number;
  /** Product bounding box longest side over the frame's longest side, 0 when no product was found. */
  fillRatio: number;
  hasProduct: boolean;
}

/** A pixel counts as product when any channel is below this. A heuristic of
 * the free tool, not a channel rule: the app measures against the real mask. */
export const NON_WHITE_CHANNEL_THRESHOLD = 250;
/** Share of edge pixels that must be pure white for the background row to pass. */
export const BORDER_WHITE_PASS_SHARE = 0.97;

/**
 * Composites RGBA pixels over pure white in place and makes them opaque.
 * Idempotent: opaque pixels are left as they are. The canvas is also filled
 * white before drawing; this keeps the measurement right whatever the
 * caller did.
 */
export function flattenOnWhite(data: Uint8ClampedArray | Uint8Array): void {
  for (let i = 0; i < data.length; i += 4) {
    const alpha = data[i + 3];
    if (alpha === 255) {
      continue;
    }
    const a = alpha / 255;
    data[i] = Math.round(data[i] * a + 255 * (1 - a));
    data[i + 1] = Math.round(data[i + 1] * a + 255 * (1 - a));
    data[i + 2] = Math.round(data[i + 2] * a + 255 * (1 - a));
    data[i + 3] = 255;
  }
}

/** Edge band whiteness and product fill from opaque RGBA pixels. */
export function measurePixels(data: Uint8ClampedArray | Uint8Array, width: number, height: number): PixelMeasurements {
  const band = Math.max(2, Math.round(Math.min(width, height) * 0.02));
  let borderTotal = 0;
  let borderPureWhite = 0;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      if (x < band || y < band || x >= width - band || y >= height - band) {
        borderTotal++;
        if (r === 255 && g === 255 && b === 255) {
          borderPureWhite++;
        }
      }
      if (r < NON_WHITE_CHANNEL_THRESHOLD || g < NON_WHITE_CHANNEL_THRESHOLD || b < NON_WHITE_CHANNEL_THRESHOLD) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  const hasProduct = maxX >= 0;
  const fillRatio = hasProduct ? Math.max(maxX - minX + 1, maxY - minY + 1) / Math.max(width, height) : 0;
  return {
    borderWhiteShare: borderTotal > 0 ? borderPureWhite / borderTotal : 0,
    fillRatio,
    hasProduct,
  };
}

function fillMeasured(m: PixelMeasurements, rules: CheckerRules): string {
  if (!m.hasProduct) {
    return "No product pixels found, the image is almost entirely white";
  }
  const percent = m.fillRatio * 100;
  const base = `Measured fill ${percent.toFixed(1)} percent of the longest frame side`;
  if (percent < rules.fillMinPercent) {
    return `${base}, so the product looks small in search results`;
  }
  if (percent > rules.fillMaxPercent) {
    return `${base}, so the product is cropped too tight`;
  }
  return base;
}

/** The three report rows for an image of the given natural size. */
export function checkRows(
  size: { width: number; height: number },
  m: PixelMeasurements,
  rules: CheckerRules,
): CheckRow[] {
  const longSide = Math.max(size.width, size.height);
  const fillPercent = m.fillRatio * 100;
  return [
    {
      key: "resolution",
      label: `Longest side is at least ${rules.minLongSide} px so zoom works`,
      pass: longSide >= rules.minLongSide,
      measured: `Measured ${size.width} by ${size.height} px, longest side ${longSide} px`,
    },
    {
      key: "background",
      label: "Background at the edges is pure white, RGB 255 255 255",
      pass: m.borderWhiteShare >= BORDER_WHITE_PASS_SHARE,
      measured: `Measured ${(m.borderWhiteShare * 100).toFixed(1)} percent of edge pixels at exactly 255 255 255`,
    },
    {
      key: "fill",
      label: `Product fills ${rules.fillMinPercent} to ${rules.fillMaxPercent} percent of the frame`,
      pass: m.hasProduct && fillPercent >= rules.fillMinPercent && fillPercent <= rules.fillMaxPercent,
      measured: fillMeasured(m, rules),
    },
  ];
}

/** "Passes all 3 checks" or "Fails 2 of 3 checks", for the free summary. */
export function summaryLine(rows: CheckRow[]): string {
  const failed = rows.filter((row) => !row.pass).length;
  if (failed === 0) {
    return `Passes all ${rows.length} checks`;
  }
  return `Fails ${failed} of ${rows.length} ${rows.length === 1 ? "check" : "checks"}`;
}
