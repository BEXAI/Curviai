/**
 * The small "Made with Curvi" badge on social exports (plan 9.6.3). It is
 * drawn only on specs with badgeAllowed that are not marketplace specs, so a
 * marketplace file is never marked on any plan. The badge must also never
 * cover the product (CLAUDE.md rule 3): it goes in the first corner whose
 * box, plus a clearance, holds no product mask pixel, and when no corner is
 * clear, or there is no mask to check against, the file ships without it.
 * Text is drawn from the bundled font's glyph outlines like the still
 * templates, so no system font is needed. Layout values come from the seed
 * (badgeStyle).
 */
import sharp from "sharp";
import { getSpec, isMarketplaceSpec, type ChannelSpec } from "@curvi/specs";
import { fidelityReport } from "../qc/fidelity";
import { qcKindForSpec } from "../qc/pixelChecks";
import { cloneRaw, decodeToRgba, encodeJpeg, encodePng, type RawImage, type RawMask } from "../raw";
import { badgeStyle } from "../seed/templates";
import { loadTemplateFont } from "../templates/font";

export interface BadgeBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

export type BadgeOutcome =
  | { applied: true; buffer: Buffer; box: BadgeBox }
  | { applied: false; reason: string };

/** True when a spec may carry the badge: a social spec with badgeAllowed. */
export function badgeEligible(specId: string): boolean {
  return !isMarketplaceSpec(specId) && getSpec(specId).badgeAllowed === true;
}

/** True when any mask pixel inside the box is product. */
function boxTouchesProduct(mask: RawMask, box: BadgeBox): boolean {
  const x0 = Math.max(0, box.left);
  const y0 = Math.max(0, box.top);
  const x1 = Math.min(mask.width, box.left + box.width);
  const y1 = Math.min(mask.height, box.top + box.height);
  for (let y = y0; y < y1; y++) {
    const row = y * mask.width;
    for (let x = x0; x < x1; x++) {
      if (mask.data[row + x] !== 0) {
        return true;
      }
    }
  }
  return false;
}

/**
 * The first corner, bottom right, bottom left, top right, then top left,
 * where the badge fits inside the canvas and outside the spec safe zone and
 * stays at least `clearance` pixels from every product pixel. Null when
 * none does.
 */
export function badgePlacement(
  canvas: { width: number; height: number },
  size: { width: number; height: number },
  opts: { margin: number; clearance: number; safeZone?: ChannelSpec["safeZone"] },
  mask: RawMask,
): BadgeBox | null {
  const top = (opts.safeZone?.top ?? 0) + opts.margin;
  const bottom = canvas.height - (opts.safeZone?.bottom ?? 0) - opts.margin - size.height;
  const left = opts.margin;
  const right = canvas.width - opts.margin - size.width;
  if (right < left || bottom < top) {
    return null;
  }
  const corners: BadgeBox[] = [
    { left: right, top: bottom, ...size },
    { left, top: bottom, ...size },
    { left: right, top, ...size },
    { left, top, ...size },
  ];
  for (const box of corners) {
    const guard = {
      left: box.left - opts.clearance,
      top: box.top - opts.clearance,
      width: box.width + opts.clearance * 2,
      height: box.height + opts.clearance * 2,
    };
    if (!boxTouchesProduct(mask, guard)) {
      return box;
    }
  }
  return null;
}

/** The spec safe zone is given for the spec height; scale it to the canvas. */
function scaledSafeZone(spec: ChannelSpec, canvasHeight: number): ChannelSpec["safeZone"] {
  if (!spec.safeZone) {
    return undefined;
  }
  const scale = spec.height ? canvasHeight / spec.height : 1;
  return { top: Math.ceil(spec.safeZone.top * scale), bottom: Math.ceil(spec.safeZone.bottom * scale) };
}

function escapeXml(value: string): string {
  return value.replace(/[<>&"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

/** The badge pill as straight RGBA pixels, or null when the font is missing. */
export async function renderBadge(fontPx: number): Promise<RawImage | null> {
  const font = loadTemplateFont();
  if (!font) {
    return null;
  }
  const text = Array.from(badgeStyle.text)
    .filter((ch) => ch === " " || font.charToGlyphIndex(ch) > 0)
    .join("");
  const scale = fontPx / font.unitsPerEm;
  const ascent = font.ascender * scale;
  const lineHeight = (font.ascender - font.descender) * scale;
  const padX = Math.round(fontPx * badgeStyle.padXOfFont);
  const padY = Math.round(fontPx * badgeStyle.padYOfFont);
  const width = Math.ceil(font.getAdvanceWidth(text, fontPx)) + padX * 2;
  const height = Math.ceil(lineHeight) + padY * 2;
  const radius = Math.round(height / 2);
  const path = font.getPath(text, padX, Math.round(padY + ascent), fontPx).toPathData(2);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
    `<rect width="${width}" height="${height}" rx="${radius}" ry="${radius}" fill="${escapeXml(badgeStyle.backgroundHex)}" fill-opacity="${badgeStyle.backgroundOpacity}"/>` +
    `<path d="${path}" fill="${escapeXml(badgeStyle.textHex)}"/>` +
    `</svg>`;
  const { data, info } = await sharp(Buffer.from(svg)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, channels: 4 };
}

/**
 * Draws the badge onto an encoded social file and re-encodes it in the same
 * format. Pixels under the mask are never written, even inside the box,
 * as a second guard behind the placement check. The re-encoded bytes are
 * checked again (product fidelity against the unbadged file and the spec
 * byte cap); when either fails the badge is left off, so the caller ships
 * the unbadged file that already passed QC.
 */
export async function applyBadge(
  buffer: Buffer,
  format: string,
  specId: string,
  mask: RawMask | null,
): Promise<BadgeOutcome> {
  if (!badgeEligible(specId)) {
    return { applied: false, reason: "not allowed for this channel spec" };
  }
  if (!mask) {
    return { applied: false, reason: "no product mask to keep the badge clear of the product" };
  }
  const image = await decodeToRgba(buffer);
  if (image.width !== mask.width || image.height !== mask.height) {
    return { applied: false, reason: "the product mask does not match the image size" };
  }
  const short = Math.min(image.width, image.height);
  const fontPx = Math.max(badgeStyle.minFontPx, Math.round(short * badgeStyle.fontOfShort));
  const badge = await renderBadge(fontPx);
  if (!badge) {
    return { applied: false, reason: "the badge font could not be found" };
  }
  const box = badgePlacement(
    image,
    badge,
    {
      margin: Math.round(short * badgeStyle.marginOfShort),
      clearance: Math.round(fontPx * badgeStyle.productClearanceOfFont),
      safeZone: scaledSafeZone(getSpec(specId), image.height),
    },
    mask,
  );
  if (!box) {
    return { applied: false, reason: "no corner is clear of the product" };
  }

  const original = cloneRaw(image);
  for (let y = 0; y < badge.height; y++) {
    for (let x = 0; x < badge.width; x++) {
      const target = (box.top + y) * image.width + (box.left + x);
      if (mask.data[target] !== 0) {
        continue;
      }
      const src = (y * badge.width + x) * 4;
      const alpha = badge.data[src + 3] / 255;
      if (alpha === 0) {
        continue;
      }
      const dst = target * 4;
      for (let c = 0; c < 3; c++) {
        image.data[dst + c] = Math.round(badge.data[src + c] * alpha + image.data[dst + c] * (1 - alpha));
      }
    }
  }

  const lower = format.toLowerCase();
  const encoded = lower === "png" ? await encodePng(image) : await encodeJpeg(image);

  // The file passed QC before the badge; drawing it re-encodes the whole
  // file, so the bytes that would ship are proven again here. The product
  // must still match the unbadged file inside the mask (rule 3) and the
  // file must still fit the channel byte cap. If either fails the caller
  // ships the unbadged file it already has.
  const spec = getSpec(specId);
  if (spec.maxBytes && encoded.length > spec.maxBytes) {
    return { applied: false, reason: "the badged file would be over the channel size limit" };
  }
  const shipped = await decodeToRgba(encoded);
  const fidelity =
    shipped.width === original.width && shipped.height === original.height
      ? await fidelityReport(original, shipped, mask, { kind: qcKindForSpec(spec) })
      : null;
  if (!fidelity?.pass) {
    return { applied: false, reason: "the badged file did not keep the product pixels intact" };
  }
  return { applied: true, buffer: encoded, box };
}
