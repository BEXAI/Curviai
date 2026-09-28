/**
 * Still template renderer for method "template" shots: infographic,
 * dimensions, the A+ banner and the social crops. Everything here is
 * deterministic. The product is only scaled and placed with its own alpha,
 * never recolored or regenerated (CLAUDE.md rule 3). Colors and copy always
 * come from the caller (seed stillStyle and the shot plan); the only numbers
 * in this file are layout proportions.
 */
import sharp from "sharp";
import type { ChannelSpec } from "@curvi/specs";
import { hexToRgb } from "../color";
import { boundingBoxOfMask, type BBox } from "../mask";
import { decodeMask, decodeToRgba, type RawImage, type RawMask } from "../raw";
import { buildProductReference, PRODUCT_RESIZE_KERNEL } from "../deterministic/whiten";
import { fidelityReport } from "../qc/fidelity";
import { qcKindForSpec } from "../qc/pixelChecks";
import type opentype from "opentype.js";
import { loadTemplateFont } from "./font";

export type TemplateStillType =
  | "infographic"
  | "dimensions"
  | "aplus_banner"
  | "social_1x1"
  | "social_4x5"
  | "social_9x16";

export const TEMPLATE_STILL_TYPES: ReadonlySet<string> = new Set<TemplateStillType>([
  "infographic",
  "dimensions",
  "aplus_banner",
  "social_1x1",
  "social_4x5",
  "social_9x16",
]);

/**
 * The template cannot be rendered for this input (missing copy, a spec that
 * forbids text, a font that cannot be found, a size cap that cannot be met).
 * Callers route the shot to needs review instead of failing the pack.
 */
export class TemplateUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TemplateUnavailableError";
  }
}

interface TemplateStillInput {
  type: TemplateStillType;
  spec: ChannelSpec;
  /** RGBA cutout of the real product, alpha 0 outside it. */
  productPng: Buffer;
  /** Same size as productPng, 255 on the product. */
  maskPng: Buffer;
  callouts?: string[];
  backgroundHex: string;
  textHex: string;
  accentHex: string;
}

interface TemplateStillResult {
  /** Exactly the decoded pixels of encoded.buffer. */
  image: RawImage;
  /** Product placement at canvas scale, 255 on product pixels. */
  mask: RawMask;
  encoded: { buffer: Buffer; format: string };
  /**
   * Rule 3 reference at canvas size: the input cutout cropped and scaled
   * exactly as placed, with nothing else applied. fidelityReport(
   * productReference, image, mask) proves the product was not recolored.
   */
  productReference: RawImage;
}

/** Longest callout the image will carry, matching the planner's cap. */
const MAX_CALLOUT_CHARS = 40;
const MAX_CALLOUTS = 5;

// Layout proportions. All relative to the canvas so every channel size works.
const LAYOUT = {
  marginOfShort: 0.06,
  /** Portrait canvases at or above this height over width stack text below the product. */
  stackAspect: 1.15,
  infographic: {
    productShareSide: 0.5,
    columnStartSide: 0.55,
    productShareStacked: 0.56,
    columnStartStacked: 0.62,
    productPadding: 0.04,
    fontOfShort: 0.042,
    minFontOfShort: 0.016,
    rowGapOfFont: 0.9,
    bulletOfFont: 0.42,
    bulletGapOfFont: 0.6,
  },
  dimensions: {
    productWidth: 0.66,
    productHeight: 0.6,
    lineGapOfShort: 0.03,
    lineThicknessOfShort: 0.004,
    tickOfShort: 0.022,
    labelGapOfShort: 0.025,
    fontOfShort: 0.05,
    minFontOfShort: 0.018,
  },
  aplus: { boxWidth: 0.86, boxHeight: 0.8 },
  social: { boxWidth: 0.78, boxHeight: 0.72 },
  jpegQualities: [90, 80, 70, 60, 50, 40],
  /** Higher lossy qualities tried, in order, when a still fails the rule 3 check. */
  fidelityQualities: [95, 98, 100],
} as const;

export async function renderTemplateStill(input: TemplateStillInput): Promise<TemplateStillResult> {
  const { type, spec } = input;
  if (!TEMPLATE_STILL_TYPES.has(type)) {
    throw new TemplateUnavailableError(`No still template for shot type ${String(type)}`);
  }
  const needsText = type === "infographic" || type === "dimensions";
  const copy = needsText ? usableCopy(type, input.callouts) : [];
  if (needsText && spec.textAllowed === false) {
    throw new TemplateUnavailableError(`Channel ${spec.id} does not allow text for ${type}`);
  }

  const bg = hexToRgb(input.backgroundHex);
  const text = hexToRgb(input.textHex);
  const accent = hexToRgb(input.accentHex);
  if (spec.background?.type === "solid" && spec.background.rgb) {
    const [r, g, b] = spec.background.rgb;
    if (needsText || r !== bg.r || g !== bg.g || b !== bg.b) {
      throw new TemplateUnavailableError(
        `Channel ${spec.id} requires a plain solid background the ${type} template cannot meet`,
      );
    }
  }
  const format = pickFormat(spec);
  const font = needsText ? loadTemplateFont() : null;
  if (needsText && !font) {
    throw new TemplateUnavailableError("Template font file could not be found");
  }

  const product = await loadProduct(input.productPng, input.maskPng);
  const { width: W, height: H } = canvasSize(spec);
  const canvas = new Canvas(W, H, bg);
  const safeTop = Math.min(spec.safeZone?.top ?? 0, Math.floor(H / 4));
  const safeBottom = Math.min(spec.safeZone?.bottom ?? 0, Math.floor(H / 4));
  const short = Math.min(W, H);
  const margin = Math.round(short * LAYOUT.marginOfShort);
  const content: BBox = {
    left: margin,
    top: safeTop + margin,
    width: W - 2 * margin,
    height: H - safeTop - safeBottom - 2 * margin,
  };

  let placement: BBox;
  switch (type) {
    case "infographic":
      placement = await layoutInfographic(canvas, product, content, copy, font!, text, accent);
      break;
    case "dimensions":
      placement = await layoutDimensions(canvas, product, content, copy[0], font!, text, accent);
      break;
    case "aplus_banner":
      placement = fitCentered(product, content, LAYOUT.aplus.boxWidth, LAYOUT.aplus.boxHeight);
      break;
    default:
      placement = fitCentered(product, content, LAYOUT.social.boxWidth, LAYOUT.social.boxHeight);
      break;
  }

  const mask = await canvas.placeProduct(product, placement);
  // Rebuilt from the decoded inputs and the placement alone, never from the
  // canvas, so a recolor anywhere after placement fails fidelity.
  const productReference = await buildProductReference(
    await decodeToRgba(input.productPng),
    { crop: product.crop, ...placement, kernel: PRODUCT_RESIZE_KERNEL },
    W,
    H,
    { alpha: { mask: await decodeMask(input.maskPng), mode: "min" } },
  );
  const encoded = await encodeKeepingProduct(canvas.toRaw(), spec, format, productReference, mask);
  const { image } = encoded;
  if (image.width !== W || image.height !== H) {
    throw new Error(`Encoded template is ${image.width}x${image.height}, expected ${W}x${H}`);
  }
  return { image, mask, encoded: { buffer: encoded.buffer, format: encoded.format }, productReference };
}

// Copy handling

function usableCopy(type: "infographic" | "dimensions", callouts: string[] | undefined): string[] {
  const cleaned = (callouts ?? []).map(sanitizeCallout).filter((c) => c.length > 0);
  if (type === "dimensions") {
    if (cleaned.length === 0) {
      throw new TemplateUnavailableError("Dimensions template needs a dimension label");
    }
    return [cleaned[0]];
  }
  if (cleaned.length === 0) {
    throw new TemplateUnavailableError("Infographic template needs at least one usable callout");
  }
  return cleaned.slice(0, MAX_CALLOUTS);
}

/**
 * Plain text for the image: no emojis, no arrows, no dashes used as
 * punctuation (CLAUDE.md rule 9), single spaced, at most 40 characters.
 */
export function sanitizeCallout(raw: string): string {
  let s = raw.normalize("NFC");
  // Emojis, pictographs, keycaps, variation selectors, joiners, flags.
  s = s.replace(/[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{1F3FB}-\u{1F3FF}⃣︎️‍]/gu, "");
  // Arrow characters and ASCII arrows.
  s = s.replace(/[←-⇿⟰-⟿⤀-⥿⬀-⯿]/gu, " ");
  s = s.replace(/<-+>?|-+>|=+>|<=+/g, " ");
  // Unicode hyphens (U+2010, U+2011) behave like the ASCII hyphen: kept
  // inside a word, dropped when spaced. Every other dash character (figure,
  // en, em, bar, minus sign, small and fullwidth forms) and a doubled ASCII
  // hyphen ("fast--easy") are always punctuation here; a spaced or leading or
  // trailing hyphen is too. Hyphens inside words (12-inch) stay.
  s = s.replace(/[\u2010\u2011]/gu, "-");
  s = s.replace(/[\u2012-\u2015\u2212\u2E3A\u2E3B\uFE58\uFE63\uFF0D]/gu, " ");
  s = s.replace(/-{2,}/g, " ");
  s = s.replace(/(^|\s)-+(?=\s|$)/g, " ");
  s = s.replace(/^[\s*•·-]+/u, "");
  // Control characters and collapsed whitespace.
  s = s.replace(/\p{Cc}/gu, " ").replace(/\s+/g, " ").trim();
  if (s.length > MAX_CALLOUT_CHARS) {
    const cut = s.slice(0, MAX_CALLOUT_CHARS);
    const lastSpace = cut.lastIndexOf(" ");
    s = (lastSpace >= MAX_CALLOUT_CHARS / 2 ? cut.slice(0, lastSpace) : cut).trim();
  }
  return s.replace(/[\s,;:]+$/, "");
}

// Spec handling

function canvasSize(spec: ChannelSpec): { width: number; height: number } {
  let width = spec.width ?? spec.minWidth;
  let height = spec.height ?? spec.minHeight;
  if (width === undefined && height === undefined) {
    const side = spec.minLongSide ?? 2000;
    width = side;
    height = side;
  }
  width ??= height!;
  height ??= width;
  // Respect a minimum long side the explicit sizes do not already meet.
  const long = Math.max(width, height);
  if (spec.minLongSide && long < spec.minLongSide) {
    const k = spec.minLongSide / long;
    width = Math.ceil(width * k);
    height = Math.ceil(height * k);
  }
  if (spec.maxWidth) width = Math.min(width, spec.maxWidth);
  if (spec.maxHeight) height = Math.min(height, spec.maxHeight);
  return { width, height };
}

type StillFormat = "jpg" | "png" | "webp";

function pickFormat(spec: ChannelSpec): StillFormat {
  const allowed: readonly string[] = spec.formats ?? ["jpg", "png"];
  for (const f of ["jpg", "png", "webp"] as const) {
    if (allowed.includes(f)) {
      return f;
    }
  }
  throw new TemplateUnavailableError(`Channel ${spec.id} allows no still image format`);
}

/**
 * Encode in the preferred format, but keep a lossy file only when its decoded
 * product pixels still pass the rule 3 fidelity check the runner applies. On
 * detailed products lossy codec error can push single pixels past the limit;
 * then higher qualities are tried, and lossless PNG after those when the
 * spec allows it. Otherwise the still needs review.
 */
async function encodeKeepingProduct(
  raw: RawImage,
  spec: ChannelSpec,
  format: StillFormat,
  productReference: RawImage,
  mask: RawMask,
): Promise<{ buffer: Buffer; format: StillFormat; image: RawImage }> {
  const buffer = await encodeForSpec(raw, spec, format);
  const image = await decodeToRgba(buffer);
  if (format === "png") {
    return { buffer, format, image };
  }
  const kind = qcKindForSpec(spec);
  if ((await fidelityReport(productReference, image, mask, { kind })).pass) {
    return { buffer, format, image };
  }
  const maxBytes = spec.maxBytes ?? Number.POSITIVE_INFINITY;
  for (const quality of LAYOUT.fidelityQualities) {
    const better = await encodeLossy(raw, format, quality);
    if (better.length > maxBytes) {
      break;
    }
    const betterImage = await decodeToRgba(better);
    if ((await fidelityReport(productReference, betterImage, mask, { kind })).pass) {
      return { buffer: better, format, image: betterImage };
    }
  }
  const allowed: readonly string[] = spec.formats ?? ["jpg", "png"];
  if (!allowed.includes("png")) {
    throw new TemplateUnavailableError(
      `Lossy ${format} changes product pixels past the fidelity limit and ${spec.id} takes no PNG`,
    );
  }
  const png = await encodeForSpec(raw, spec, "png");
  return { buffer: png, format: "png", image: await decodeToRgba(png) };
}

function encodeLossy(raw: RawImage, format: "jpg" | "webp", quality: number): Promise<Buffer> {
  const base = sharp(raw.data, { raw: { width: raw.width, height: raw.height, channels: 4 } }).removeAlpha();
  return format === "jpg"
    ? base.jpeg({ quality, chromaSubsampling: "4:4:4" }).toBuffer()
    : base.webp({ quality }).toBuffer();
}

async function encodeForSpec(raw: RawImage, spec: ChannelSpec, format: StillFormat): Promise<Buffer> {
  const maxBytes = spec.maxBytes ?? Number.POSITIVE_INFINITY;
  const base = () =>
    sharp(raw.data, { raw: { width: raw.width, height: raw.height, channels: 4 } }).removeAlpha();
  if (format === "png") {
    const png = await base().png({ compressionLevel: 9 }).toBuffer();
    if (png.length > maxBytes) {
      throw new TemplateUnavailableError(`PNG is ${png.length} bytes, over the ${spec.id} cap`);
    }
    return png;
  }
  let last = 0;
  for (const quality of LAYOUT.jpegQualities) {
    const out = await encodeLossy(raw, format, quality);
    if (out.length <= maxBytes) {
      return out;
    }
    last = out.length;
  }
  throw new TemplateUnavailableError(`Encoded still is ${last} bytes, over the ${spec.id} cap`);
}

// Product handling

interface Product {
  /** RGBA crop of the product bounding box, alpha limited by the mask. */
  data: Buffer;
  width: number;
  height: number;
  /** Box of the source cutout that data was cropped from. */
  crop: BBox;
}

async function loadProduct(productPng: Buffer, maskPng: Buffer): Promise<Product> {
  const rgba = await decodeToRgba(productPng);
  const mask = await decodeMask(maskPng);
  if (rgba.width !== mask.width || rgba.height !== mask.height) {
    throw new Error(
      `Mask size ${mask.width}x${mask.height} does not match product ${rgba.width}x${rgba.height}`,
    );
  }
  const bbox = boundingBoxOfMask(mask);
  if (!bbox) {
    throw new TemplateUnavailableError("Product mask is empty");
  }
  // The cutout's own alpha, never wider than the mask.
  const data = Buffer.from(rgba.data);
  for (let i = 0; i < mask.data.length; i++) {
    const o = i * 4 + 3;
    data[o] = Math.min(data[o], mask.data[i]);
  }
  const crop = await sharp(data, { raw: { width: rgba.width, height: rgba.height, channels: 4 } })
    .extract(bbox)
    .raw()
    .toBuffer();
  return { data: crop, width: bbox.width, height: bbox.height, crop: bbox };
}

/** Largest product placement inside box, keeping aspect, centered. */
function fitInto(product: Product, box: BBox): BBox {
  const scale = Math.min(box.width / product.width, box.height / product.height);
  const width = Math.max(1, Math.min(box.width, Math.round(product.width * scale)));
  const height = Math.max(1, Math.min(box.height, Math.round(product.height * scale)));
  return {
    left: box.left + Math.floor((box.width - width) / 2),
    top: box.top + Math.floor((box.height - height) / 2),
    width,
    height,
  };
}

function fitCentered(product: Product, content: BBox, widthShare: number, heightShare: number): BBox {
  const width = Math.round(content.width * widthShare);
  const height = Math.round(content.height * heightShare);
  return fitInto(product, {
    left: content.left + Math.floor((content.width - width) / 2),
    top: content.top + Math.floor((content.height - height) / 2),
    width,
    height,
  });
}

// Layouts

async function layoutInfographic(
  canvas: Canvas,
  product: Product,
  content: BBox,
  callouts: string[],
  font: opentype.Font,
  text: Rgb,
  accent: Rgb,
): Promise<BBox> {
  const L = LAYOUT.infographic;
  const stacked = canvas.height / canvas.width >= LAYOUT.stackAspect;
  let productArea: BBox;
  let column: BBox;
  if (stacked) {
    const productH = Math.round(content.height * L.productShareStacked);
    const columnTop = content.top + Math.round(content.height * L.columnStartStacked);
    productArea = { left: content.left, top: content.top, width: content.width, height: productH };
    column = {
      left: content.left,
      top: columnTop,
      width: content.width,
      height: content.top + content.height - columnTop,
    };
  } else {
    const productW = Math.round(content.width * L.productShareSide);
    const columnLeft = content.left + Math.round(content.width * L.columnStartSide);
    productArea = { left: content.left, top: content.top, width: productW, height: content.height };
    column = {
      left: columnLeft,
      top: content.top,
      width: content.left + content.width - columnLeft,
      height: content.height,
    };
  }
  const pad = Math.round(Math.min(productArea.width, productArea.height) * L.productPadding);
  const placement = fitInto(product, {
    left: productArea.left + pad,
    top: productArea.top + pad,
    width: productArea.width - 2 * pad,
    height: productArea.height - 2 * pad,
  });

  const short = Math.min(canvas.width, canvas.height);
  const minSize = Math.max(8, Math.round(short * L.minFontOfShort));
  for (let size = Math.round(short * L.fontOfShort); size >= minSize; size = Math.floor(size * 0.9)) {
    const bullet = Math.max(2, Math.round(size * L.bulletOfFont));
    const indent = bullet + Math.round(size * L.bulletGapOfFont);
    const textWidth = column.width - indent;
    if (textWidth <= size) {
      break;
    }
    const blocks = await Promise.all(callouts.map((c) => renderText(c, size, textWidth, font)));
    if (blocks.some((b) => b.width > textWidth)) {
      continue;
    }
    // Prefer a smaller size over breaking a word, until the floor.
    if (blocks.some((b) => b.brokeWord) && Math.floor(size * 0.9) >= minSize) {
      continue;
    }
    const gap = Math.round(size * L.rowGapOfFont);
    const total = blocks.reduce((sum, b) => sum + b.height, 0) + gap * (blocks.length - 1);
    if (total > column.height) {
      continue;
    }
    const blockWidth = indent + Math.max(...blocks.map((b) => b.width));
    const left = stacked ? column.left + Math.floor((column.width - blockWidth) / 2) : column.left;
    let y = column.top + Math.floor((column.height - total) / 2);
    for (const block of blocks) {
      // Bullet centered on the first line's x height.
      canvas.fillCircle(left + bullet / 2, y + block.firstLineMid, bullet / 2, accent);
      canvas.blendCoverage(block, left + indent, y, text);
      y += block.height + gap;
    }
    return placement;
  }
  throw new TemplateUnavailableError("Infographic callouts do not fit the canvas");
}

async function layoutDimensions(
  canvas: Canvas,
  product: Product,
  content: BBox,
  label: string,
  font: opentype.Font,
  text: Rgb,
  accent: Rgb,
): Promise<BBox> {
  const L = LAYOUT.dimensions;
  const short = Math.min(canvas.width, canvas.height);
  const thick = Math.max(2, Math.round(short * L.lineThicknessOfShort));
  const tick = Math.max(thick * 3, Math.round(short * L.tickOfShort));
  const lineGap = Math.max(thick * 2, Math.round(short * L.lineGapOfShort));
  const labelGap = Math.round(short * L.labelGapOfShort);

  // Product box centered, with room right for the vertical line and below
  // for the horizontal line and the label.
  const boxW = Math.round(content.width * L.productWidth);
  const boxH = Math.round(content.height * L.productHeight);
  const placement = fitInto(product, {
    left: content.left + Math.floor((content.width - boxW) / 2),
    top: content.top,
    width: boxW,
    height: boxH,
  });
  const labelTop = placement.top + placement.height + lineGap + Math.ceil(tick / 2) + labelGap;
  const labelHeight = content.top + content.height - labelTop;
  const minSize = Math.max(8, Math.round(short * L.minFontOfShort));
  let block: TextBlock | null = null;
  for (let size = Math.round(short * L.fontOfShort); size >= minSize; size = Math.floor(size * 0.9)) {
    const candidate = await renderText(label, size, content.width, font);
    const canShrink = Math.floor(size * 0.9) >= minSize;
    if (candidate.width <= content.width && candidate.height <= labelHeight && !(candidate.brokeWord && canShrink)) {
      block = candidate;
      break;
    }
  }
  if (!block) {
    throw new TemplateUnavailableError("Dimension label does not fit the canvas");
  }

  // Horizontal measure line under the product with end ticks.
  const hy = placement.top + placement.height + lineGap;
  canvas.fillRect(placement.left, hy - Math.floor(thick / 2), placement.width, thick, accent);
  for (const x of [placement.left, placement.left + placement.width - thick]) {
    canvas.fillRect(x, hy - Math.floor(tick / 2), thick, tick, accent);
  }
  // Vertical measure line right of the product with end ticks.
  const vx = placement.left + placement.width + lineGap;
  if (vx + Math.ceil(tick / 2) < content.left + content.width) {
    canvas.fillRect(vx - Math.floor(thick / 2), placement.top, thick, placement.height, accent);
    for (const y of [placement.top, placement.top + placement.height - thick]) {
      canvas.fillRect(vx - Math.floor(tick / 2), y, tick, thick, accent);
    }
  }
  const labelLeft = placement.left + Math.floor((placement.width - block.width) / 2);
  const clampedLeft = Math.max(content.left, Math.min(labelLeft, content.left + content.width - block.width));
  canvas.blendCoverage(block, clampedLeft, labelTop, text);
  return placement;
}

// Text

interface TextBlock {
  /** Single channel coverage, 255 is solid text. */
  coverage: Buffer;
  width: number;
  height: number;
  /** A word was longer than a line and had to break between characters. */
  brokeWord: boolean;
  /** Y of the first line's x height middle, for aligning a bullet. */
  firstLineMid: number;
}

/**
 * Rasterize text from the bundled font's glyph outlines: greedy word wrap to
 * maxWidth (a word longer than a line breaks between characters), left
 * aligned, line height from the font's own metrics. Characters the font has
 * no glyph for are dropped rather than drawn as boxes.
 */
async function renderText(text: string, sizePx: number, maxWidth: number, font: opentype.Font): Promise<TextBlock> {
  const clean = Array.from(text)
    .filter((ch) => ch === " " || font.charToGlyphIndex(ch) > 0)
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  const measure = (s: string) => font.getAdvanceWidth(s, sizePx);
  const lines: string[] = [];
  let line = "";
  let brokeWord = false;
  for (const word of clean.split(" ").filter(Boolean)) {
    const candidate = line ? `${line} ${word}` : word;
    if (measure(candidate) <= maxWidth) {
      line = candidate;
      continue;
    }
    if (line) {
      lines.push(line);
      line = "";
    }
    // Break an overlong word between characters.
    let rest = word;
    while (measure(rest) > maxWidth && rest.length > 1) {
      brokeWord = true;
      let cut = rest.length - 1;
      while (cut > 1 && measure(rest.slice(0, cut)) > maxWidth) cut--;
      lines.push(rest.slice(0, cut));
      rest = rest.slice(cut);
    }
    line = rest;
  }
  if (line) lines.push(line);
  if (lines.length === 0) {
    return { coverage: Buffer.alloc(0), width: 0, height: 0, brokeWord, firstLineMid: 0 };
  }

  const scale = sizePx / font.unitsPerEm;
  const ascent = font.ascender * scale;
  const lineHeight = Math.ceil((font.ascender - font.descender) * scale);
  const width = Math.max(1, Math.ceil(Math.max(...lines.map(measure))) + 2);
  const height = lineHeight * lines.length;
  const paths = lines
    .map((l, i) => font.getPath(l, 1, Math.round(i * lineHeight + ascent), sizePx).toPathData(2))
    .filter((d) => d.length > 0)
    .map((d) => `<path d="${d}" fill="#ffffff"/>`)
    .join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${paths}</svg>`;
  const { data, info } = await sharp(Buffer.from(svg))
    .ensureAlpha()
    .extractChannel(3)
    .raw()
    .toBuffer({ resolveWithObject: true });
  const os2 = font.tables.os2 as { sxHeight?: number } | undefined;
  const xHeight = (os2?.sxHeight || font.unitsPerEm / 2) * scale;
  const firstLineMid = Math.round(ascent) - xHeight / 2;
  return { coverage: data, width: info.width, height: info.height, brokeWord, firstLineMid };
}

// Canvas

interface Rgb {
  r: number;
  g: number;
  b: number;
}

class Canvas {
  readonly data: Buffer;
  /** Pixels touched by text or decoration, to prove they never meet the product. */
  private readonly decoration: Uint8Array;

  constructor(
    readonly width: number,
    readonly height: number,
    bg: Rgb,
  ) {
    this.data = Buffer.alloc(width * height * 4);
    this.decoration = new Uint8Array(width * height);
    for (let i = 0; i < width * height; i++) {
      const o = i * 4;
      this.data[o] = bg.r;
      this.data[o + 1] = bg.g;
      this.data[o + 2] = bg.b;
      this.data[o + 3] = 255;
    }
  }

  private blend(x: number, y: number, a: number, c: Rgb): void {
    if (a === 0 || x < 0 || y < 0 || x >= this.width || y >= this.height) {
      return;
    }
    const i = y * this.width + x;
    const o = i * 4;
    this.decoration[i] = 1;
    if (a === 255) {
      this.data[o] = c.r;
      this.data[o + 1] = c.g;
      this.data[o + 2] = c.b;
      return;
    }
    this.data[o] = Math.round((a * c.r + (255 - a) * this.data[o]) / 255);
    this.data[o + 1] = Math.round((a * c.g + (255 - a) * this.data[o + 1]) / 255);
    this.data[o + 2] = Math.round((a * c.b + (255 - a) * this.data[o + 2]) / 255);
  }

  fillRect(left: number, top: number, width: number, height: number, c: Rgb): void {
    for (let y = top; y < top + height; y++) {
      for (let x = left; x < left + width; x++) {
        this.blend(x, y, 255, c);
      }
    }
  }

  fillCircle(cx: number, cy: number, radius: number, c: Rgb): void {
    // 4x4 supersampling for a smooth edge.
    for (let y = Math.floor(cy - radius); y <= Math.ceil(cy + radius); y++) {
      for (let x = Math.floor(cx - radius); x <= Math.ceil(cx + radius); x++) {
        let hits = 0;
        for (let sy = 0; sy < 4; sy++) {
          for (let sx = 0; sx < 4; sx++) {
            const dx = x + (sx + 0.5) / 4 - cx;
            const dy = y + (sy + 0.5) / 4 - cy;
            if (dx * dx + dy * dy <= radius * radius) hits++;
          }
        }
        this.blend(x, y, Math.round((hits * 255) / 16), c);
      }
    }
  }

  blendCoverage(block: TextBlock, left: number, top: number, c: Rgb): void {
    for (let y = 0; y < block.height; y++) {
      for (let x = 0; x < block.width; x++) {
        this.blend(left + x, top + y, block.coverage[y * block.width + x], c);
      }
    }
  }

  /**
   * Scale the product into placement and composite it with its own alpha.
   * Fully opaque product pixels are copied exactly; only the anti aliased
   * edge blends with the background. Returns the placement mask.
   */
  async placeProduct(product: Product, placement: BBox): Promise<RawMask> {
    const scaled = await sharp(product.data, {
      raw: { width: product.width, height: product.height, channels: 4 },
    })
      .resize(placement.width, placement.height, { fit: "fill", kernel: PRODUCT_RESIZE_KERNEL })
      .raw()
      .toBuffer();
    const mask = Buffer.alloc(this.width * this.height, 0);
    for (let y = 0; y < placement.height; y++) {
      for (let x = 0; x < placement.width; x++) {
        const src = (y * placement.width + x) * 4;
        const a = scaled[src + 3];
        if (a === 0) {
          continue;
        }
        const cx = placement.left + x;
        const cy = placement.top + y;
        if (cx < 0 || cy < 0 || cx >= this.width || cy >= this.height) {
          continue;
        }
        const i = cy * this.width + cx;
        if (this.decoration[i]) {
          throw new Error("Template layout placed text or lines over the product");
        }
        const o = i * 4;
        for (let ch = 0; ch < 3; ch++) {
          this.data[o + ch] =
            a === 255 ? scaled[src + ch] : Math.round((a * scaled[src + ch] + (255 - a) * this.data[o + ch]) / 255);
        }
        mask[i] = 255;
      }
    }
    return { data: mask, width: this.width, height: this.height };
  }

  toRaw(): RawImage {
    return { data: this.data, width: this.width, height: this.height, channels: 4 };
  }
}
