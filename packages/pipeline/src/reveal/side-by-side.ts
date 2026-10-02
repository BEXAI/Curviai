/**
 * Side by side makeover image for the "Share this makeover" download: the
 * seller's original photo on the left, one finished shot on the right, each
 * fitted whole into a square panel with a small label. This is a share
 * graphic, never a listing output: both pictures are only scaled to fit
 * (fit contain, no crop), and the finished shot's own product pixels come
 * from the stored output as delivered (CLAUDE.md rule 3). Label text is drawn
 * from the bundled font's glyph outlines, like the still templates, so it
 * renders the same on every host; without the font the labels are left out
 * rather than drawn in a fallback face.
 */
import sharp, { type OverlayOptions } from "sharp";
import { loadTemplateFont } from "../templates/font";

export interface SideBySideInput {
  /** Encoded original photo (any format sharp reads, SVG included). */
  before: Buffer;
  /** Encoded finished shot. */
  after: Buffer;
  /** Label drawn on the left panel; empty leaves it out. */
  beforeLabel?: string;
  /** Label drawn on the right panel; empty leaves it out. */
  afterLabel?: string;
  /** Square panel side in pixels. */
  panel?: number;
  /** Gap between and around the panels, in pixels. */
  gap?: number;
  /** Canvas and panel background, #RRGGBB. */
  backgroundHex?: string;
  /** Label pill fill, #RRGGBB; the text is white. */
  labelHex?: string;
  /** JPEG quality of the result. */
  quality?: number;
}

export interface SideBySideResult {
  buffer: Buffer;
  width: number;
  height: number;
  /** False when the font was missing and the labels were left out. */
  labeled: boolean;
}

/** Largest input side accepted, in pixels, so a huge upload cannot exhaust memory. */
export const SIDE_BY_SIDE_MAX_INPUT_PIXELS = 80_000_000;

const HEX = /^#[0-9a-fA-F]{6}$/;

function hex(value: string | undefined, fallback: string): string {
  return value && HEX.test(value) ? value : fallback;
}

async function fitPanel(input: Buffer, side: number, background: string): Promise<Buffer> {
  return sharp(input, { limitInputPixels: SIDE_BY_SIDE_MAX_INPUT_PIXELS })
    .rotate()
    .resize(side, side, { fit: "contain", background, withoutEnlargement: false })
    .flatten({ background })
    .png()
    .toBuffer();
}

/** An SVG label pill, or null when there is no text or no font. */
function labelSvg(text: string, sizePx: number, fill: string): { svg: Buffer; width: number; height: number } | null {
  const font = loadTemplateFont();
  const clean = Array.from(text.trim())
    .filter((ch) => ch === " " || (font !== null && font.charToGlyphIndex(ch) > 0))
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  if (!font || clean.length === 0) {
    return null;
  }
  const scale = sizePx / font.unitsPerEm;
  const ascent = font.ascender * scale;
  const textHeight = (font.ascender - font.descender) * scale;
  const padX = Math.round(sizePx * 0.7);
  const padY = Math.round(sizePx * 0.35);
  const width = Math.ceil(font.getAdvanceWidth(clean, sizePx)) + padX * 2;
  const height = Math.ceil(textHeight) + padY * 2;
  const d = font.getPath(clean, padX, Math.round(padY + ascent), sizePx).toPathData(2);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="${width}" height="${height}" rx="${Math.round(height / 2)}" fill="${fill}" fill-opacity="0.85"/><path d="${d}" fill="#ffffff"/></svg>`;
  return { svg: Buffer.from(svg), width, height };
}

export async function renderSideBySide(input: SideBySideInput): Promise<SideBySideResult> {
  const panel = Math.max(64, Math.round(input.panel ?? 1080));
  const gap = Math.max(0, Math.round(input.gap ?? Math.round(panel / 27)));
  const background = hex(input.backgroundHex, "#ffffff");
  const labelFill = hex(input.labelHex, "#1d2433");
  const width = panel * 2 + gap * 3;
  const height = panel + gap * 2;

  const [left, right] = await Promise.all([
    fitPanel(input.before, panel, background),
    fitPanel(input.after, panel, background),
  ]);
  const layers: OverlayOptions[] = [
    { input: left, left: gap, top: gap },
    { input: right, left: gap * 2 + panel, top: gap },
  ];

  const sizePx = Math.max(12, Math.round(panel / 28));
  const inset = Math.round(panel / 36);
  let labeled = false;
  for (const [text, x] of [
    [input.beforeLabel ?? "", gap] as const,
    [input.afterLabel ?? "", gap * 2 + panel] as const,
  ]) {
    const label = labelSvg(text, sizePx, labelFill);
    if (label && label.width < panel - inset * 2) {
      layers.push({ input: label.svg, left: x + inset, top: gap + inset });
      labeled = true;
    }
  }

  const buffer = await sharp({ create: { width, height, channels: 3, background } })
    .composite(layers)
    .jpeg({ quality: Math.min(100, Math.max(40, Math.round(input.quality ?? 88))), mozjpeg: true })
    .toBuffer();
  return { buffer, width, height, labeled };
}
