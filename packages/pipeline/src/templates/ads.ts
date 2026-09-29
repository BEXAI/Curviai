/**
 * Renderers for the ads formats (PHASE_16 workstream 3): the moodboard pin,
 * carousel slides and static ad variants. Same rules as the still
 * templates (./still): the real product is only scaled and placed with its
 * own alpha, never recolored or regenerated (CLAUDE.md rule 3); text, lines
 * and the call to action pill are decoration, and placing the product over
 * any decoration pixel throws, so text never covers the product. Every
 * image carries a rule 3 reference built from the inputs and the placement
 * alone, and a lossy file is kept only when its product pixels still pass
 * the fidelity check.
 *
 * Carousels: one wide canvas, cut at the seams into equal slides (founder
 * decision 4). drawCarousel paints any window of that canvas, so the whole
 * canvas (renderCarouselCanvas) and a single slide (renderCarouselSlide)
 * come from one definition: a slide is exactly its slice of the canvas, to
 * the pixel. The background is a function of the canvas x (a gradient, or
 * the carousel's one scene layer), and the accent line runs the whole width,
 * so the swipe reads as one image. Products and text stay inside their own
 * slide, clear of every seam (./ads-layout).
 */
import type { ChannelSpec } from "@curvi/specs";
import type opentype from "opentype.js";
import { hexToRgb } from "../color";
import { buildProductReference, PRODUCT_RESIZE_KERNEL } from "../deterministic/whiten";
import { sanitizeCopyLine } from "../copy-lint";
import type { BBox } from "../mask";
import { relativeLuminance } from "../output-options";
import { decodeMask, decodeToRgba, type RawImage, type RawMask } from "../raw";
import { adsFormats, stillStyle } from "../seed/templates";
import {
  adVariantAreas,
  carouselAccentLineY,
  carouselGeometry,
  carouselSlideAreas,
  slideBox,
  type CarouselGeometry,
  type CarouselSlideRole,
  type LayoutBox,
} from "./ads-layout";
import {
  Canvas,
  canvasSize,
  encodeKeepingProduct,
  fitInto,
  loadProduct,
  pickFont,
  pickFormat,
  renderText,
  TemplateUnavailableError,
  type Product,
  type TextBlock,
} from "./still";

/** An sRGB color as the canvas takes it. */
type Rgb = { r: number; g: number; b: number };

/** Colors and fonts every ads renderer takes from the caller (seed and brand kit). */
export interface AdsStyle {
  backgroundHex: string;
  textHex: string;
  accentHex: string;
  fonts?: { heading?: string | null; body?: string | null };
}

/** The real product: an RGBA cutout and its mask, the same size. */
export interface AdsProductInput {
  productPng: Buffer;
  maskPng: Buffer;
}

export interface AdsStillResult {
  /** Exactly the decoded pixels of encoded.buffer. */
  image: RawImage;
  /** Product placement at canvas scale, 255 on product pixels. */
  mask: RawMask;
  encoded: { buffer: Buffer; format: string };
  /** Rule 3 reference: the cutout scaled and placed exactly as drawn. */
  productReference: RawImage;
  /** Where the product and every drawn line or pill ended up, for tests. */
  layout: { product: BBox; decoration: BBox | null };
}

/** Text sizes as shares of the canvas short side. */
const TYPE = {
  headlineOfShort: 0.075,
  lineOfShort: 0.05,
  ctaOfShort: 0.045,
  minOfShort: 0.022,
  rowGapOfFont: 0.55,
  bulletOfFont: 0.4,
  bulletGapOfFont: 0.6,
  pillPadXOfFont: 1.1,
  pillPadYOfFont: 0.55,
  accentLineOfShort: 0.006,
  productPaddingOfShort: 0.02,
  /** The pin keeps its line in a band at the top. */
  pinHeadlineShare: 0.2,
  pinMarginOfShort: 0.07,
} as const;

// ---------------------------------------------------------------------------
// Copy

/** One ads line as printed: rule 9 clean, at most the seeded 40 characters. */
export function adsLine(raw: string | undefined | null): string {
  return sanitizeCopyLine(raw ?? "", adsFormats.lineMaxChars);
}

function mix(a: Rgb, b: Rgb, t: number): Rgb {
  return {
    r: Math.round(a.r + (b.r - a.r) * t),
    g: Math.round(a.g + (b.g - a.g) * t),
    b: Math.round(a.b + (b.b - a.b) * t),
  };
}

/** Text on the call to action pill: seed dark text, or seed light text on a dark accent. */
function pillTextFor(accentHex: string): Rgb {
  const dark = relativeLuminance(accentHex) < stillStyle.darkBackgroundLuminance;
  return hexToRgb(dark ? stillStyle.textOnDarkHex : stillStyle.textHex);
}

// ---------------------------------------------------------------------------
// Text stack

interface TextStack {
  headline?: string;
  lines?: string[];
  cta?: string;
}

interface StackFonts {
  heading: opentype.Font;
  body: opentype.Font;
}

function fontsFor(style: AdsStyle, stack: TextStack): StackFonts {
  const heading = pickFont(style.fonts?.heading, [stack.headline ?? "", stack.cta ?? ""]);
  const body = pickFont(style.fonts?.body, stack.lines ?? []);
  if (!heading || !body) {
    throw new TemplateUnavailableError("Template font file could not be found");
  }
  return { heading, body };
}

/**
 * Draws a headline, a dotted list and a call to action pill, stacked and
 * centered in the area, at the largest size where everything fits without
 * breaking a word. Throws TemplateUnavailableError when nothing fits.
 */
async function drawTextStack(
  canvas: Canvas,
  area: LayoutBox,
  stack: TextStack,
  fonts: StackFonts,
  text: Rgb,
  accent: Rgb,
  pillText: Rgb,
  short: number,
): Promise<void> {
  const parts = [stack.headline, ...(stack.lines ?? []), stack.cta].filter((p): p is string => !!p);
  if (parts.length === 0) {
    return;
  }
  const minSize = Math.max(8, Math.round(short * TYPE.minOfShort));
  for (let scale = 1; ; scale *= 0.9) {
    const head = Math.round(short * TYPE.headlineOfShort * scale);
    const body = Math.round(short * TYPE.lineOfShort * scale);
    const ctaSize = Math.round(short * TYPE.ctaOfShort * scale);
    if (Math.min(head, body, ctaSize) < minSize) {
      break;
    }
    const canShrink = Math.round(short * TYPE.lineOfShort * scale * 0.9) >= minSize;
    const bullet = Math.max(2, Math.round(body * TYPE.bulletOfFont));
    const indent = bullet + Math.round(body * TYPE.bulletGapOfFont);
    const padX = Math.round(ctaSize * TYPE.pillPadXOfFont);
    const padY = Math.round(ctaSize * TYPE.pillPadYOfFont);
    const headBlock = stack.headline ? await renderText(stack.headline, head, area.width, fonts.heading) : null;
    const lineBlocks = await Promise.all((stack.lines ?? []).map((l) => renderText(l, body, area.width - indent, fonts.body)));
    const ctaBlock = stack.cta ? await renderText(stack.cta, ctaSize, area.width - 2 * padX, fonts.heading) : null;
    const blocks: TextBlock[] = [headBlock, ...lineBlocks, ctaBlock].filter((b): b is TextBlock => b !== null);
    if (blocks.some((b) => b.brokeWord) && canShrink) {
      continue;
    }
    if (
      (headBlock && headBlock.width > area.width) ||
      lineBlocks.some((b) => b.width > area.width - indent) ||
      (ctaBlock && ctaBlock.width + 2 * padX > area.width)
    ) {
      continue;
    }
    const gap = Math.round(body * TYPE.rowGapOfFont);
    const heights = [
      headBlock?.height ?? null,
      ...lineBlocks.map((b) => b.height),
      ctaBlock ? ctaBlock.height + 2 * padY : null,
    ].filter((h): h is number => h !== null);
    const total = heights.reduce((sum, h) => sum + h, 0) + gap * (heights.length - 1);
    if (total > area.height) {
      continue;
    }
    let y = area.top + Math.floor((area.height - total) / 2);
    const centerX = (block: { width: number }) => area.left + Math.floor((area.width - block.width) / 2);
    if (headBlock) {
      canvas.blendCoverage(headBlock, centerX(headBlock), y, text);
      y += headBlock.height + gap;
    }
    if (lineBlocks.length > 0) {
      const listWidth = indent + Math.max(...lineBlocks.map((b) => b.width));
      const left = area.left + Math.floor((area.width - listWidth) / 2);
      for (const block of lineBlocks) {
        canvas.fillCircle(left + bullet / 2, y + block.firstLineMid, bullet / 2, accent);
        canvas.blendCoverage(block, left + indent, y, text);
        y += block.height + gap;
      }
    }
    if (ctaBlock) {
      const pill = { width: ctaBlock.width + 2 * padX, height: ctaBlock.height + 2 * padY };
      const left = centerX(pill);
      canvas.fillRect(left, y, pill.width, pill.height, accent);
      canvas.blendCoverage(ctaBlock, left + padX, y + padY, pillText);
    }
    return;
  }
  throw new TemplateUnavailableError("The ad copy does not fit the canvas");
}

// ---------------------------------------------------------------------------
// Product placement and encoding

interface Placed {
  placement: BBox;
  product: Product;
}

function productPlacement(product: Product, area: LayoutBox, short: number): BBox {
  const pad = Math.round(short * TYPE.productPaddingOfShort);
  return fitInto(product, {
    left: area.left + pad,
    top: area.top + pad,
    width: Math.max(1, area.width - 2 * pad),
    height: Math.max(1, area.height - 2 * pad),
  });
}

/** The rule 3 reference of one placed product, rebuilt from the inputs alone. */
async function referenceFor(input: AdsProductInput, placed: Placed, width: number, height: number): Promise<RawImage> {
  return buildProductReference(
    await decodeToRgba(input.productPng),
    { crop: placed.product.crop, ...placed.placement, kernel: PRODUCT_RESIZE_KERNEL },
    width,
    height,
    { alpha: { mask: await decodeMask(input.maskPng), mode: "min" } },
  );
}

async function finish(
  canvas: Canvas,
  spec: ChannelSpec,
  input: AdsProductInput,
  placed: Placed,
): Promise<AdsStillResult> {
  const decoration = canvas.decorationBounds();
  const mask = await canvas.placeProduct(placed.product, placed.placement);
  const productReference = await referenceFor(input, placed, canvas.width, canvas.height);
  const encoded = await encodeKeepingProduct(canvas.toRaw(), spec, pickFormat(spec), productReference, mask);
  if (encoded.image.width !== canvas.width || encoded.image.height !== canvas.height) {
    throw new Error(`Encoded ad is ${encoded.image.width}x${encoded.image.height}, expected ${canvas.width}x${canvas.height}`);
  }
  return {
    image: encoded.image,
    mask,
    encoded: { buffer: encoded.buffer, format: encoded.format },
    productReference,
    layout: { product: placed.placement, decoration },
  };
}

function refuseText(spec: ChannelSpec, what: string): void {
  if (spec.textAllowed === false) {
    throw new TemplateUnavailableError(`Channel ${spec.id} does not allow text for ${what}`);
  }
}

// ---------------------------------------------------------------------------
// Static ad variant

export interface AdVariantInput extends AdsProductInput, AdsStyle {
  spec: ChannelSpec;
  headline: string;
  cta: string;
}

/**
 * One static ad (ad_variant) for one placement: the headline on top, the
 * real product in the middle and the call to action pill at the bottom,
 * all inside the spec's safe zone, so the platform's name, caption and
 * buttons never cover them.
 */
export async function renderAdVariant(input: AdVariantInput): Promise<AdsStillResult> {
  const { spec } = input;
  refuseText(spec, "an ad");
  const headline = adsLine(input.headline);
  const cta = adsLine(input.cta);
  if (!headline || !cta) {
    throw new TemplateUnavailableError("An ad needs a headline and a call to action");
  }
  const size = canvasSize(spec);
  const areas = adVariantAreas(spec, size);
  if (areas.product.height <= 0 || areas.product.width <= 0) {
    throw new TemplateUnavailableError(`The ${spec.id} safe zone leaves no room for the product`);
  }
  const canvas = new Canvas(size.width, size.height, hexToRgb(input.backgroundHex));
  const short = Math.min(areas.safe.width, areas.safe.height);
  const fonts = fontsFor(input, { headline, cta });
  const text = hexToRgb(input.textHex);
  const accent = hexToRgb(input.accentHex);
  const pill = pillTextFor(input.accentHex);
  await drawTextStack(canvas, areas.headline, { headline }, fonts, text, accent, pill, short);
  await drawTextStack(canvas, areas.cta, { cta }, fonts, text, accent, pill, short);
  const product = await loadProduct(input.productPng, input.maskPng);
  return finish(canvas, spec, input, { product, placement: productPlacement(product, areas.product, short) });
}

// ---------------------------------------------------------------------------
// Moodboard pin

export interface PinMoodboardInput extends AdsProductInput, AdsStyle {
  spec: ChannelSpec;
  headline: string;
}

/**
 * The moodboard pin (pin_moodboard) without a scene: one short line in a
 * band at the top and the real product below it, on the card color.
 */
export async function renderPinMoodboard(input: PinMoodboardInput): Promise<AdsStillResult> {
  const { spec } = input;
  refuseText(spec, "a pin");
  const headline = adsLine(input.headline);
  if (!headline) {
    throw new TemplateUnavailableError("A moodboard pin needs one short line");
  }
  const size = canvasSize(spec);
  const areas = pinAreas(spec, size);
  const canvas = new Canvas(size.width, size.height, hexToRgb(input.backgroundHex));
  const short = Math.min(size.width, size.height);
  const fonts = fontsFor(input, { headline });
  await drawTextStack(
    canvas,
    areas.headline,
    { headline },
    fonts,
    hexToRgb(input.textHex),
    hexToRgb(input.accentHex),
    pillTextFor(input.accentHex),
    short,
  );
  const product = await loadProduct(input.productPng, input.maskPng);
  return finish(canvas, spec, input, { product, placement: productPlacement(product, areas.product, short) });
}

/** The pin's line band on top and product area below, inside its margin
 * and its safe zone when it has one. */
export function pinAreas(
  spec: ChannelSpec,
  size: { width: number; height: number },
): { headline: LayoutBox; product: LayoutBox } {
  const areas = adVariantAreas(spec, size);
  const short = Math.min(size.width, size.height);
  const margin = Math.round(short * TYPE.pinMarginOfShort);
  const inner: LayoutBox = {
    left: Math.max(areas.safe.left, margin),
    top: Math.max(areas.safe.top, margin),
    width: Math.min(areas.safe.width, size.width - 2 * margin),
    height: Math.min(areas.safe.height, size.height - 2 * margin),
  };
  const headlineHeight = Math.round(inner.height * TYPE.pinHeadlineShare);
  return {
    headline: { left: inner.left, top: inner.top, width: inner.width, height: headlineHeight },
    product: {
      left: inner.left,
      top: inner.top + headlineHeight,
      width: inner.width,
      height: inner.height - headlineHeight,
    },
  };
}

/**
 * The moodboard pin's line on a finished scene (pin_moodboard with scenes
 * on): a card of the card color across the top band with the line on it,
 * drawn only where the product is not. The scene's product pixels are never
 * touched; a product that reaches into the band refuses the line
 * (TemplateUnavailableError), so the shot needs review instead.
 */
export async function overlaySceneLine(input: {
  image: RawImage;
  mask: RawMask;
  spec: ChannelSpec;
  headline: string;
  style: AdsStyle;
}): Promise<RawImage> {
  const { image, mask, spec, style } = input;
  refuseText(spec, "a pin");
  const headline = adsLine(input.headline);
  if (!headline) {
    throw new TemplateUnavailableError("A moodboard pin needs one short line");
  }
  const areas = pinAreas(spec, { width: image.width, height: image.height });
  const band = areas.headline;
  for (let y = band.top; y < band.top + band.height; y++) {
    for (let x = band.left; x < band.left + band.width; x++) {
      if (mask.data[y * mask.width + x]) {
        throw new TemplateUnavailableError("The product reaches the line band of this pin");
      }
    }
  }
  const canvas = new Canvas(image.width, image.height, hexToRgb(style.backgroundHex));
  canvas.paintBackground((x, y) => {
    const o = (y * image.width + x) * 4;
    return { r: image.data[o], g: image.data[o + 1], b: image.data[o + 2] };
  });
  const short = Math.min(image.width, image.height);
  canvas.fillRect(band.left, band.top, band.width, band.height, hexToRgb(style.backgroundHex));
  await drawTextStack(
    canvas,
    band,
    { headline },
    fontsFor(style, { headline }),
    hexToRgb(style.textHex),
    hexToRgb(style.accentHex),
    pillTextFor(style.accentHex),
    short,
  );
  return canvas.toRaw();
}

// ---------------------------------------------------------------------------
// Carousel

/** What one carousel slide says, by its beat in the story. */
export interface CarouselSlideContent {
  slideIndex: number;
  role: CarouselSlideRole;
  headline?: string;
  lines?: string[];
  cta?: string;
}

export interface CarouselInput extends AdsProductInput, AdsStyle {
  spec: ChannelSpec;
  slideCount: number;
  /**
   * The carousel's one scene layer (scenes on), the whole canvas's size. When
   * absent the background is the continuous gradient. The layer never holds
   * the product: the product is placed on it here, exactly.
   */
  plate?: RawImage | null;
}

/** The continuous background at canvas x: a gradient from the card color
 * toward the accent, seed adsFormats.carousel.gradientAccentShare at the end. */
function gradientAt(geometry: CarouselGeometry, style: AdsStyle): (x: number) => Rgb {
  const from = hexToRgb(style.backgroundHex);
  const to = mix(from, hexToRgb(style.accentHex), adsFormats.carousel.gradientAccentShare);
  const span = Math.max(1, geometry.canvasWidth - 1);
  return (x) => mix(from, to, x / span);
}

/** The card color under a slide's text on a scene layer, so it stays legible. */
function cardUnderText(style: AdsStyle): Rgb {
  return hexToRgb(style.backgroundHex);
}

/**
 * Paints the window [offsetX, offsetX + canvas.width) of the carousel's
 * whole canvas: the background (gradient or scene layer) and the accent line
 * across the full width, then each given slide's text in its own area.
 * Returns each given slide's product placement, in canvas (window)
 * coordinates, for the caller to place.
 */
async function drawCarousel(
  canvas: Canvas,
  offsetX: number,
  geometry: CarouselGeometry,
  slides: readonly CarouselSlideContent[],
  input: CarouselInput,
  product: Product,
): Promise<BBox[]> {
  const { plate } = input;
  if (plate && (plate.width !== geometry.canvasWidth || plate.height !== geometry.canvasHeight)) {
    throw new Error(
      `Scene layer is ${plate.width}x${plate.height}, expected ${geometry.canvasWidth}x${geometry.canvasHeight}`,
    );
  }
  if (plate) {
    canvas.paintBackground((x, y) => {
      const o = (y * plate.width + x + offsetX) * 4;
      return { r: plate.data[o], g: plate.data[o + 1], b: plate.data[o + 2] };
    });
  } else {
    const gradient = gradientAt(geometry, input);
    canvas.paintBackground((x) => gradient(x + offsetX));
  }
  const short = Math.min(geometry.slideWidth, geometry.slideHeight);
  const accent = hexToRgb(input.accentHex);
  const thick = Math.max(2, Math.round(short * TYPE.accentLineOfShort));
  canvas.fillRect(0, carouselAccentLineY(geometry) - Math.floor(thick / 2), canvas.width, thick, accent);

  const text = hexToRgb(input.textHex);
  const pill = pillTextFor(input.accentHex);
  const placements: BBox[] = [];
  for (const slide of slides) {
    const areas = carouselSlideAreas(geometry, slide.slideIndex, slide.role);
    const shift = (box: LayoutBox): LayoutBox => ({ ...box, left: box.left - offsetX });
    const stack: TextStack = {
      ...(slide.headline ? { headline: adsLine(slide.headline) } : {}),
      ...(slide.lines && slide.lines.length > 0 ? { lines: slide.lines.map(adsLine).filter((l) => l.length > 0) } : {}),
      ...(slide.cta ? { cta: adsLine(slide.cta) } : {}),
    };
    if (plate) {
      const card = shift(areas.text);
      canvas.fillRect(card.left, card.top, card.width, card.height, cardUnderText(input));
    }
    await drawTextStack(canvas, shift(areas.text), stack, fontsFor(input, stack), text, accent, pill, short);
    placements.push(productPlacement(product, shift(areas.product), short));
  }
  return placements;
}

function assertSlides(slides: readonly CarouselSlideContent[], slideCount: number): void {
  const seen = new Set<number>();
  for (const slide of slides) {
    if (slide.slideIndex < 1 || slide.slideIndex > slideCount || seen.has(slide.slideIndex)) {
      throw new Error(`Slide ${slide.slideIndex} does not fit a ${slideCount} slide carousel`);
    }
    seen.add(slide.slideIndex);
  }
}

/**
 * The whole carousel canvas, every slide drawn once: the raw pixels and the
 * product mask, before any encoding. sliceCarouselCanvas cuts it into slides.
 */
export async function renderCarouselCanvas(
  input: CarouselInput & { slides: readonly CarouselSlideContent[] },
): Promise<{ image: RawImage; mask: RawMask; geometry: CarouselGeometry }> {
  const geometry = carouselGeometry(input.spec, input.slideCount);
  assertSlides(input.slides, input.slideCount);
  const canvas = new Canvas(geometry.canvasWidth, geometry.canvasHeight, hexToRgb(input.backgroundHex));
  const product = await loadProduct(input.productPng, input.maskPng);
  const placements = await drawCarousel(canvas, 0, geometry, input.slides, input, product);
  const mask = Buffer.alloc(geometry.canvasWidth * geometry.canvasHeight, 0);
  for (const placement of placements) {
    const placed = await canvas.placeProduct(product, placement);
    for (let i = 0; i < mask.length; i++) {
      if (placed.data[i]) mask[i] = 255;
    }
  }
  return { image: canvas.toRaw(), mask: { data: mask, width: geometry.canvasWidth, height: geometry.canvasHeight }, geometry };
}

/** Cuts a whole carousel canvas at its seams into its slides, in order. */
export function sliceCarouselCanvas(image: RawImage, geometry: CarouselGeometry): RawImage[] {
  const slides: RawImage[] = [];
  for (let index = 1; index <= geometry.slideCount; index++) {
    const box = slideBox(geometry, index);
    const data = Buffer.alloc(box.width * box.height * 4);
    for (let y = 0; y < box.height; y++) {
      const from = ((box.top + y) * image.width + box.left) * 4;
      image.data.copy(data, y * box.width * 4, from, from + box.width * 4);
    }
    slides.push({ data, width: box.width, height: box.height, channels: 4 });
  }
  return slides;
}

/**
 * One carousel slide (carousel_slide), exactly its slice of the whole
 * canvas: the same background, accent line and layout, with only this
 * slide's text and product drawn, so memory holds one slide, not the canvas.
 * Encoded for the spec with the rule 3 check.
 */
export async function renderCarouselSlide(
  input: CarouselInput & { slide: CarouselSlideContent },
): Promise<AdsStillResult> {
  const { canvas, placed } = await drawCarouselSlide(input);
  return finish(canvas, input.spec, input, placed);
}

/**
 * One carousel slide's pixels and product mask before encoding, for the
 * seam tests: exactly the slide's slice of renderCarouselCanvas.
 */
export async function composeCarouselSlide(
  input: CarouselInput & { slide: CarouselSlideContent },
): Promise<{ image: RawImage; mask: RawMask }> {
  const { canvas, placed } = await drawCarouselSlide(input);
  const mask = await canvas.placeProduct(placed.product, placed.placement);
  return { image: canvas.toRaw(), mask };
}

async function drawCarouselSlide(
  input: CarouselInput & { slide: CarouselSlideContent },
): Promise<{ canvas: Canvas; placed: Placed }> {
  const { spec, slide } = input;
  refuseText(spec, "a carousel");
  const geometry = carouselGeometry(spec, input.slideCount);
  assertSlides([slide], input.slideCount);
  const box = slideBox(geometry, slide.slideIndex);
  const canvas = new Canvas(box.width, box.height, hexToRgb(input.backgroundHex));
  const product = await loadProduct(input.productPng, input.maskPng);
  const [placement] = await drawCarousel(canvas, box.left, geometry, [slide], input, product);
  return { canvas, placed: { product, placement: placement! } };
}

/** The scene layer's prompt size for a carousel: the whole canvas. */
export function carouselPlateSize(spec: ChannelSpec, slideCount: number): { width: number; height: number } {
  const geometry = carouselGeometry(spec, slideCount);
  return { width: geometry.canvasWidth, height: geometry.canvasHeight };
}
