import { Composition } from "remotion";
import {
  calculateDimensionRevealMetadata,
  DimensionReveal,
  dimensionRevealSchema,
  type DimensionRevealProps,
} from "./compositions/DimensionReveal";
import {
  calculateFeatureCalloutsMetadata,
  FeatureCallouts,
  featureCalloutsSchema,
  type FeatureCalloutsProps,
} from "./compositions/FeatureCallouts";
import {
  calculateSlideshowMetadata,
  Slideshow,
  slideshowSchema,
  type SlideshowProps,
} from "./compositions/Slideshow";
import {
  calculateSpin360Metadata,
  Spin360,
  spin360Schema,
  type Spin360Props,
} from "./compositions/Spin360";

/** Solid color SVG stand in so the studio opens without remote assets. */
function placeholderStill(label: string, background: string): string {
  const svg = [
    '<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1080">',
    `<rect width="100%" height="100%" fill="${background}"/>`,
    '<text x="50%" y="50%" font-family="Helvetica, Arial, sans-serif" font-size="80" fill="#111827" text-anchor="middle" dominant-baseline="middle">',
    label,
    "</text></svg>",
  ].join("");
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

export const spin360DefaultProps: Spin360Props = {
  images: [
    placeholderStill("Front", "#E2E8F0"),
    placeholderStill("Right side", "#CBD5E1"),
    placeholderStill("Back", "#94A3B8"),
    placeholderStill("Left side", "#CBD5E1"),
  ],
  productName: "Sample product",
};

export const slideshowDefaultProps: SlideshowProps = {
  slides: [
    { image: placeholderStill("Hero", "#E2E8F0"), caption: "Built to last" },
    { image: placeholderStill("Detail", "#CBD5E1"), caption: "Easy to clean" },
    { image: placeholderStill("In use", "#94A3B8"), caption: "Ready out of the box" },
  ],
};

export const featureCalloutsDefaultProps: FeatureCalloutsProps = {
  heroImage: placeholderStill("Product", "#E2E8F0"),
  heading: "Why buyers pick it",
  callouts: [
    "Stainless steel body",
    "Keeps drinks cold all day",
    "Leak proof lid",
    "Fits car cup holders",
  ],
};

export const dimensionRevealDefaultProps: DimensionRevealProps = {
  image: placeholderStill("Product", "#E2E8F0"),
  measurements: [
    { label: "25 cm wide", edge: "bottom" },
    { label: "32 cm tall", edge: "left" },
  ],
};

export const RemotionRoot = () => {
  return (
    <>
      <Composition
        id="Spin360"
        component={Spin360}
        schema={spin360Schema}
        defaultProps={spin360DefaultProps}
        calculateMetadata={calculateSpin360Metadata}
      />
      <Composition
        id="Slideshow"
        component={Slideshow}
        schema={slideshowSchema}
        defaultProps={slideshowDefaultProps}
        calculateMetadata={calculateSlideshowMetadata}
      />
      <Composition
        id="FeatureCallouts"
        component={FeatureCallouts}
        schema={featureCalloutsSchema}
        defaultProps={featureCalloutsDefaultProps}
        calculateMetadata={calculateFeatureCalloutsMetadata}
      />
      <Composition
        id="DimensionReveal"
        component={DimensionReveal}
        schema={dimensionRevealSchema}
        defaultProps={dimensionRevealDefaultProps}
        calculateMetadata={calculateDimensionRevealMetadata}
      />
    </>
  );
};
