/**
 * Geometry of the ads formats (PHASE_16 workstream 3), pure and sharp free,
 * so the planner, the renderer and the tests read one definition.
 *
 * A carousel is one wide canvas, slideCount slides of the spec's size side
 * by side, cut into equal slides at the seams (founder decision 4). Every
 * product placement and every line of text sits inside one slide, clear of
 * its seams by a margin, so nothing the seller needs to read or see whole is
 * ever cut in two by a swipe. Only the background and the accent line run
 * across the seams, which is what makes the slides read as one story.
 */
import type { ChannelSpec } from "@curvi/specs";
import { safeArea } from "@curvi/specs";

/** A rectangle in canvas pixels. */
export interface LayoutBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** The size of one carousel's whole canvas and of each slide. */
export interface CarouselGeometry {
  slideCount: number;
  slideWidth: number;
  slideHeight: number;
  canvasWidth: number;
  canvasHeight: number;
}

/** Layout proportions, relative to the slide's short side. */
const CAROUSEL = {
  /** Clear space kept between anything drawn and a seam or edge. */
  marginOfShort: 0.07,
  /** Share of the slide's content height the product takes, by slide role. */
  productShare: { hero: 0.6, support: 0.42 },
  /** Gap between the product area and the text below it. */
  gapOfShort: 0.04,
  /** Where the accent line runs, as a share of the bottom margin. */
  accentLineOfMargin: 0.5,
} as const;

/** Whether a slide shows the product large (hook and call to action) or
 * small above its text (benefits, details, in the box). */
export type CarouselSlideRole = "hero" | "support";

export function carouselGeometry(spec: ChannelSpec, slideCount: number): CarouselGeometry {
  if (spec.width === undefined || spec.height === undefined) {
    throw new Error(`Carousel spec ${spec.id} has no fixed size`);
  }
  if (!Number.isInteger(slideCount) || slideCount < 1) {
    throw new Error(`A carousel needs at least one slide, got ${slideCount}`);
  }
  return {
    slideCount,
    slideWidth: spec.width,
    slideHeight: spec.height,
    canvasWidth: spec.width * slideCount,
    canvasHeight: spec.height,
  };
}

/** Slide index (1 based) as a box on the whole canvas. */
export function slideBox(geometry: CarouselGeometry, slideIndex: number): LayoutBox {
  if (!Number.isInteger(slideIndex) || slideIndex < 1 || slideIndex > geometry.slideCount) {
    throw new Error(`Slide ${slideIndex} is outside a ${geometry.slideCount} slide carousel`);
  }
  return {
    left: (slideIndex - 1) * geometry.slideWidth,
    top: 0,
    width: geometry.slideWidth,
    height: geometry.slideHeight,
  };
}

/** The x of every seam between two slides on the whole canvas. */
export function seamsOf(geometry: CarouselGeometry): number[] {
  return Array.from({ length: geometry.slideCount - 1 }, (_, i) => (i + 1) * geometry.slideWidth);
}

/**
 * True when a box on the whole canvas would be cut by a seam: it spans a
 * seam, or it touches one (a box ending exactly at a seam still loses its
 * edge pixels to the next slide's crop only if it passes it; touching is
 * refused anyway, so a placement always keeps clear space at the swipe).
 */
export function crossesSeam(box: LayoutBox, geometry: CarouselGeometry): boolean {
  const right = box.left + box.width;
  return seamsOf(geometry).some((seam) => box.left <= seam && right >= seam);
}

/** The margin every slide keeps clear at its edges and seams, in pixels. */
export function carouselMargin(geometry: CarouselGeometry): number {
  return Math.round(Math.min(geometry.slideWidth, geometry.slideHeight) * CAROUSEL.marginOfShort);
}

/**
 * Where a slide places the product and its text, on the whole canvas: the
 * product area above, the text area below, both inside the slide less its
 * margin. The planner rule: every area is inside its own slide and never
 * crosses a seam (carouselPlacementsValid).
 */
export function carouselSlideAreas(
  geometry: CarouselGeometry,
  slideIndex: number,
  role: CarouselSlideRole,
): { product: LayoutBox; text: LayoutBox } {
  const slide = slideBox(geometry, slideIndex);
  const margin = carouselMargin(geometry);
  const gap = Math.round(Math.min(geometry.slideWidth, geometry.slideHeight) * CAROUSEL.gapOfShort);
  const inner: LayoutBox = {
    left: slide.left + margin,
    top: slide.top + margin,
    width: slide.width - 2 * margin,
    height: slide.height - 2 * margin,
  };
  const productHeight = Math.round(inner.height * CAROUSEL.productShare[role]);
  return {
    product: { left: inner.left, top: inner.top, width: inner.width, height: productHeight },
    text: {
      left: inner.left,
      top: inner.top + productHeight + gap,
      width: inner.width,
      height: inner.height - productHeight - gap,
    },
  };
}

/** The y of the accent line that runs across the whole canvas, in the
 * bottom margin, below every slide's text. */
export function carouselAccentLineY(geometry: CarouselGeometry): number {
  const margin = carouselMargin(geometry);
  return geometry.canvasHeight - Math.round(margin * CAROUSEL.accentLineOfMargin);
}

/**
 * The planner rule (PHASE_16 workstream 3): true when every slide's product
 * and text areas sit inside that slide and none crosses a seam, for these
 * slide roles in order. The planner skips a carousel that fails it.
 */
export function carouselPlacementsValid(geometry: CarouselGeometry, roles: readonly CarouselSlideRole[]): boolean {
  if (roles.length !== geometry.slideCount) {
    return false;
  }
  return roles.every((role, i) => {
    const slide = slideBox(geometry, i + 1);
    const areas = carouselSlideAreas(geometry, i + 1, role);
    return [areas.product, areas.text].every(
      (box) =>
        box.width > 0 &&
        box.height > 0 &&
        box.left >= slide.left &&
        box.left + box.width <= slide.left + slide.width &&
        box.top >= slide.top &&
        box.top + box.height <= slide.top + slide.height &&
        !crossesSeam(box, geometry),
    );
  });
}

/** Layout proportions of a static ad variant, relative to its safe area. */
const AD = {
  /** Clear space inside the safe area, as a share of its short side. */
  marginOfShort: 0.05,
  /** Share of the safe area height for the headline band at the top. */
  headlineShare: 0.2,
  /** Share for the call to action band at the bottom. */
  ctaShare: 0.13,
  /** Gap between the bands and the product, as a share of the short side. */
  gapOfShort: 0.03,
} as const;

/**
 * The three bands of a static ad variant, all inside the spec's safe area
 * (the canvas less the platform's own interface): the headline on top, the
 * product in the middle, the call to action at the bottom.
 */
export function adVariantAreas(
  spec: ChannelSpec,
  canvas: { width: number; height: number },
): { safe: LayoutBox; headline: LayoutBox; product: LayoutBox; cta: LayoutBox } {
  const safe = safeArea(spec, canvas);
  const short = Math.min(safe.width, safe.height);
  const margin = Math.round(short * AD.marginOfShort);
  const gap = Math.round(short * AD.gapOfShort);
  const inner: LayoutBox = {
    left: safe.left + margin,
    top: safe.top + margin,
    width: safe.width - 2 * margin,
    height: safe.height - 2 * margin,
  };
  const headlineHeight = Math.round(inner.height * AD.headlineShare);
  const ctaHeight = Math.round(inner.height * AD.ctaShare);
  const headline: LayoutBox = { left: inner.left, top: inner.top, width: inner.width, height: headlineHeight };
  const cta: LayoutBox = {
    left: inner.left,
    top: inner.top + inner.height - ctaHeight,
    width: inner.width,
    height: ctaHeight,
  };
  const productTop = headline.top + headline.height + gap;
  const product: LayoutBox = {
    left: inner.left,
    top: productTop,
    width: inner.width,
    height: cta.top - gap - productTop,
  };
  return { safe, headline, product, cta };
}

/** True when inner lies wholly inside outer. */
export function boxWithin(inner: LayoutBox, outer: LayoutBox): boolean {
  return (
    inner.left >= outer.left &&
    inner.top >= outer.top &&
    inner.left + inner.width <= outer.left + outer.width &&
    inner.top + inner.height <= outer.top + outer.height
  );
}
