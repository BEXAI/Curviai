/**
 * The contact sheet the vision picker looks at (docs/phases/PHASE_13.md,
 * product inventory tie breaker): every significant piece of a photo's
 * cutout, cropped with a small margin, fitted into its own cell on a neutral
 * gray background, with a large number above it. Only the piece's own pixels
 * are drawn, so a neighbor reaching into the margin never shows in the
 * wrong cell. The sheet is model input only, never a listing output.
 *
 * Numbers are drawn from the bundled template font's glyph outlines, like
 * the still templates, so they render the same on every host; without the
 * font they are drawn as seven segment digits from plain rectangles.
 */
import type opentype from "opentype.js";
import sharp, { type OverlayOptions } from "sharp";
import { HEX, hexToRgb } from "./color";
import { CUTOUT_ALPHA_THRESHOLD, maskComponents } from "./isolate";
import type { BBox } from "./mask";
import { encodeVisionJpeg, type RawImage } from "./raw";
import { loadTemplateFont } from "./templates/font";

export interface ContactSheetOptions {
  /** Square cell side for each piece, in pixels. */
  cell?: number;
  /** Space between and around the cells, in pixels. */
  gap?: number;
  /** Height of the band above each cell holding its number, in pixels. */
  band?: number;
  /** Margin around each piece's box, as a share of its longer side. */
  margin?: number;
  /** Cells per row before the sheet wraps. */
  columns?: number;
  /** Sheet background, #RRGGBB. */
  backgroundHex?: string;
  /** The font for the numbers; null forces the seven segment digits. The
   * bundled template font when omitted. */
  font?: opentype.Font | null;
}

export interface ContactSheet {
  /** The sheet as a bounded JPEG for vision input (encodeVisionJpeg). */
  buffer: Buffer;
  width: number;
  height: number;
  /** How the numbers were drawn. */
  digits: "font" | "segments";
  /** Each cell's rect on the sheet, before any vision downscale, in number
   * order: the band above it holds the number. */
  cells: Array<{ left: number; top: number; width: number; height: number }>;
}

/** The seven segments each digit lights: a top, b upper right, c lower
 * right, d bottom, e lower left, f upper left, g middle. */
const SEGMENTS: Record<string, string> = {
  "0": "abcdef",
  "1": "bc",
  "2": "abged",
  "3": "abgcd",
  "4": "fgbc",
  "5": "afgcd",
  "6": "afgedc",
  "7": "abc",
  "8": "abcdefg",
  "9": "abcdfg",
};

/** SVG rects drawing one digit as seven segments in a w by h box at x, y. */
function segmentDigit(digit: string, x: number, y: number, w: number, h: number): string {
  const t = Math.max(2, Math.round(w * 0.18));
  const half = Math.round(h / 2);
  const rects: Record<string, [number, number, number, number]> = {
    a: [x, y, w, t],
    b: [x + w - t, y, t, half],
    c: [x + w - t, y + half, t, h - half],
    d: [x, y + h - t, w, t],
    e: [x, y + half, t, h - half],
    f: [x, y, t, half],
    g: [x, y + half - Math.round(t / 2), w, t],
  };
  return [...(SEGMENTS[digit] ?? "")]
    .map((s) => rects[s])
    .map(([rx, ry, rw, rh]) => `<rect x="${rx}" y="${ry}" width="${rw}" height="${rh}" fill="#111111"/>`)
    .join("");
}

/** An SVG badge with the number n, sized to the band, on a white rounded
 * rect so it reads on any background. */
function numberBadge(n: number, band: number, font: opentype.Font | null): { svg: Buffer; width: number } {
  const text = String(n);
  const height = band;
  const size = Math.round(band * 0.72);
  let inner: string;
  let contentWidth: number;
  if (font) {
    const scale = size / font.unitsPerEm;
    const capHeight = font.ascender * scale * 0.72;
    contentWidth = Math.ceil(font.getAdvanceWidth(text, size));
    const padX = Math.round(band * 0.35);
    const baseline = Math.round(height / 2 + capHeight / 2);
    inner = `<path d="${font.getPath(text, padX, baseline, size).toPathData(2)}" fill="#111111"/>`;
    const width = contentWidth + padX * 2;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="${width}" height="${height}" rx="${Math.round(height / 5)}" fill="#ffffff"/>${inner}</svg>`;
    return { svg: Buffer.from(svg), width };
  }
  const digitH = Math.round(band * 0.64);
  const digitW = Math.round(digitH * 0.55);
  const space = Math.round(digitW * 0.35);
  const padX = Math.round(band * 0.3);
  const top = Math.round((height - digitH) / 2);
  contentWidth = text.length * digitW + (text.length - 1) * space;
  inner = [...text].map((d, i) => segmentDigit(d, padX + i * (digitW + space), top, digitW, digitH)).join("");
  const width = contentWidth + padX * 2;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="${width}" height="${height}" rx="${Math.round(height / 5)}" fill="#ffffff"/>${inner}</svg>`;
  return { svg: Buffer.from(svg), width };
}

function sameBox(a: BBox, b: BBox): boolean {
  return a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height;
}

/** One piece cropped with its margin: its own pixels only, the rest clear. */
function cropPiece(cutout: RawImage, labels: Int32Array, label: number | null, box: BBox, marginShare: number): RawImage {
  const { width, height, data } = cutout;
  const margin = Math.max(4, Math.round(Math.max(box.width, box.height) * marginShare));
  const left = Math.max(0, box.left - margin);
  const top = Math.max(0, box.top - margin);
  const right = Math.min(width, box.left + box.width + margin);
  const bottom = Math.min(height, box.top + box.height + margin);
  const w = Math.max(1, right - left);
  const h = Math.max(1, bottom - top);
  const out = Buffer.alloc(w * h * 4, 0);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = (top + y) * width + (left + x);
      if (p >= labels.length) continue;
      // Without a matching piece (a box from another cutout), every opaque
      // pixel inside the box itself is drawn.
      const inside =
        label === null
          ? left + x >= box.left &&
            left + x < box.left + box.width &&
            top + y >= box.top &&
            top + y < box.top + box.height &&
            data[p * 4 + 3] > CUTOUT_ALPHA_THRESHOLD
          : labels[p] === label;
      if (!inside) continue;
      data.copy(out, (y * w + x) * 4, p * 4, p * 4 + 4);
    }
  }
  return { data: out, width: w, height: h, channels: 4 };
}

/**
 * Renders the contact sheet of the given pieces (pixel boxes in the cutout,
 * in number order: the first is number 1). Pure: the same cutout and boxes
 * give the same sheet.
 */
export async function renderContactSheet(
  cutout: RawImage,
  pieces: readonly BBox[],
  opts: ContactSheetOptions = {},
): Promise<ContactSheet> {
  if (pieces.length === 0) {
    throw new Error("A contact sheet needs at least one piece");
  }
  const cell = Math.max(64, Math.round(opts.cell ?? 400));
  const gap = Math.max(0, Math.round(opts.gap ?? 24));
  const band = Math.max(24, Math.round(opts.band ?? 96));
  const marginShare = Math.max(0, opts.margin ?? 0.06);
  const columns = Math.max(1, Math.min(pieces.length, Math.round(opts.columns ?? 3)));
  const rows = Math.ceil(pieces.length / columns);
  const background = opts.backgroundHex && HEX.test(opts.backgroundHex) ? opts.backgroundHex : "#9a9a9a";
  const font = opts.font === undefined ? loadTemplateFont() : opts.font;
  const width = columns * cell + (columns + 1) * gap;
  const height = rows * (band + cell) + (rows + 1) * gap;

  const alpha = Buffer.alloc(cutout.width * cutout.height);
  for (let i = 0; i < alpha.length; i++) alpha[i] = cutout.data[i * 4 + 3];
  const { labels, components } = maskComponents({ data: alpha, width: cutout.width, height: cutout.height }, CUTOUT_ALPHA_THRESHOLD);

  const layers: OverlayOptions[] = [];
  const cells: ContactSheet["cells"] = [];
  for (let i = 0; i < pieces.length; i++) {
    const box = pieces[i];
    const component = components.find((c) => sameBox(c.bbox, box));
    const crop = cropPiece(cutout, labels, component ? component.label : null, box, marginShare);
    const fitted = await sharp(crop.data, { raw: { width: crop.width, height: crop.height, channels: 4 } })
      .resize(cell, cell, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toBuffer();
    const col = i % columns;
    const row = Math.floor(i / columns);
    const left = gap + col * (cell + gap);
    const top = gap + row * (band + cell + gap);
    const badge = numberBadge(i + 1, band, font);
    layers.push({ input: badge.svg, left: left + Math.max(0, Math.round((cell - badge.width) / 2)), top });
    layers.push({ input: fitted, left, top: top + band });
    cells.push({ left, top: top + band, width: cell, height: cell });
  }
  const png = await sharp({ create: { width, height, channels: 3, background } })
    .composite(layers)
    .png()
    .toBuffer();
  return { buffer: await encodeVisionJpeg(png), width, height, digits: font ? "font" : "segments", cells };
}

export interface PieceThumbnailOptions {
  /** Square side of each thumbnail, in pixels. */
  size?: number;
  /** Margin around each piece's box, as a share of its longer side. */
  margin?: number;
  /** Thumbnail background, #RRGGBB. */
  backgroundHex?: string;
}

/**
 * One small JPEG per piece for the product chooser at upload (docs/phases/
 * PHASE_14.md 3.2): the piece cropped from the cutout with the contact
 * sheet's margin, only its own pixels, fitted on a plain background. Shown
 * to the seller only, never used as listing output.
 */
export async function renderPieceThumbnails(
  cutout: RawImage,
  pieces: readonly BBox[],
  opts: PieceThumbnailOptions = {},
): Promise<Buffer[]> {
  if (pieces.length === 0) {
    return [];
  }
  const size = Math.max(32, Math.round(opts.size ?? 256));
  const marginShare = Math.max(0, opts.margin ?? 0.06);
  const background = hexToRgb(opts.backgroundHex && HEX.test(opts.backgroundHex) ? opts.backgroundHex : "#f4f4f5");
  const alpha = Buffer.alloc(cutout.width * cutout.height);
  for (let i = 0; i < alpha.length; i++) alpha[i] = cutout.data[i * 4 + 3];
  const { labels, components } = maskComponents({ data: alpha, width: cutout.width, height: cutout.height }, CUTOUT_ALPHA_THRESHOLD);
  const out: Buffer[] = [];
  for (const box of pieces) {
    const component = components.find((c) => sameBox(c.bbox, box));
    const crop = cropPiece(cutout, labels, component ? component.label : null, box, marginShare);
    const fitted = await sharp(crop.data, { raw: { width: crop.width, height: crop.height, channels: 4 } })
      .resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toBuffer();
    out.push(
      await sharp({ create: { width: size, height: size, channels: 3, background } })
        .composite([{ input: fitted, left: 0, top: 0 }])
        .jpeg({ quality: 82 })
        .toBuffer(),
    );
  }
  return out;
}

export interface CutoutPreviewOptions {
  /** Longest side of the preview, in pixels; the cutout is never enlarged. */
  longSide: number;
  /** Margin around the product's box, as a share of its longer side. */
  margin?: number;
}

/**
 * A small alpha PNG of the product from the cutout, for the new pack form's
 * preview strip (docs/phases/PHASE_15.md P1, cutout preview): the piece's
 * own pixels only, on a clear background, fitted inside longSide and never
 * enlarged. With no piece, every opaque pixel of the cutout is drawn.
 * Shown to the seller only, never used as listing output. Null when the
 * cutout has nothing opaque.
 */
export async function renderCutoutPreview(
  cutout: RawImage,
  piece: BBox | null,
  opts: CutoutPreviewOptions,
): Promise<Buffer | null> {
  const alpha = Buffer.alloc(cutout.width * cutout.height);
  for (let i = 0; i < alpha.length; i++) alpha[i] = cutout.data[i * 4 + 3];
  const { labels, components } = maskComponents({ data: alpha, width: cutout.width, height: cutout.height }, CUTOUT_ALPHA_THRESHOLD);
  let box = piece;
  let label: number | null = null;
  if (box) {
    const component = components.find((c) => sameBox(c.bbox, box as BBox));
    label = component ? component.label : null;
  } else {
    if (components.length === 0) return null;
    const left = Math.min(...components.map((c) => c.bbox.left));
    const top = Math.min(...components.map((c) => c.bbox.top));
    const right = Math.max(...components.map((c) => c.bbox.left + c.bbox.width));
    const bottom = Math.max(...components.map((c) => c.bbox.top + c.bbox.height));
    box = { left, top, width: right - left, height: bottom - top };
  }
  const crop = cropPiece(cutout, labels, label, box, Math.max(0, opts.margin ?? 0.04));
  const side = Math.max(32, Math.round(opts.longSide));
  return sharp(crop.data, { raw: { width: crop.width, height: crop.height, channels: 4 } })
    .resize(side, side, { fit: "inside", withoutEnlargement: true })
    .png()
    .toBuffer();
}
