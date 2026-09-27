import {
  AbsoluteFill,
  Easing,
  Img,
  interpolate,
  Sequence,
  useCurrentFrame,
  useVideoConfig,
  type CalculateMetadataFunction,
} from "remotion";
import { z } from "zod";
import { framesForSeconds, slideshowTotalFrames } from "../../timing";
import {
  brandColorsSchema,
  defaultBrandColors,
  dimensionsForFormat,
  fontStack,
  fpsSchema,
  plainLabel,
  videoFormatSchema,
  type BrandColors,
} from "../schemas";

const slideSchema = z.object({
  image: z.string().min(1),
  caption: plainLabel(80).optional(),
});

export const slideshowSchema = z.object({
  slides: z.array(slideSchema).min(1).max(12),
  format: videoFormatSchema.default("9x16"),
  fps: fpsSchema.default(30),
  secondsPerSlide: z.number().min(1.5).max(10).default(3),
  transitionSeconds: z.number().min(0).max(1.5).default(0.5),
  brand: brandColorsSchema.default(defaultBrandColors),
});

export type SlideshowProps = z.input<typeof slideshowSchema>;
type Slide = z.output<typeof slideSchema>;

export const calculateSlideshowMetadata: CalculateMetadataFunction<SlideshowProps> = ({ props }) => {
  const parsed = slideshowSchema.parse(props);
  return {
    ...dimensionsForFormat(parsed.format),
    fps: parsed.fps,
    durationInFrames: slideshowTotalFrames(parsed.slides.length, parsed.secondsPerSlide, parsed.fps),
    props: parsed,
  };
};

const SlideView = ({
  slide,
  transitionFrames,
  brand,
  slideIn,
}: {
  slide: Slide;
  transitionFrames: number;
  brand: BrandColors;
  slideIn: boolean;
}) => {
  const frame = useCurrentFrame();
  const progress =
    transitionFrames > 0
      ? interpolate(frame, [0, transitionFrames], [0, 1], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
          easing: Easing.out(Easing.cubic),
        })
      : 1;
  const translateX = slideIn ? (1 - progress) * 12 : 0;

  return (
    <AbsoluteFill
      style={{
        opacity: slideIn ? progress : 1,
        transform: `translateX(${translateX}%)`,
      }}
    >
      <Img
        src={slide.image}
        style={{
          position: "absolute",
          left: "6%",
          right: "6%",
          top: "6%",
          bottom: slide.caption ? "22%" : "6%",
          width: "88%",
          height: slide.caption ? "72%" : "88%",
          objectFit: "contain",
        }}
      />
      {slide.caption ? (
        <div style={{ position: "absolute", left: "8%", right: "8%", bottom: "8%", textAlign: "center" }}>
          <div
            style={{
              width: 72,
              height: 6,
              borderRadius: 3,
              backgroundColor: brand.accent,
              margin: "0 auto 18px auto",
            }}
          />
          <div style={{ fontFamily: fontStack, fontSize: 46, fontWeight: 600, color: brand.ink }}>
            {slide.caption}
          </div>
        </div>
      ) : null}
    </AbsoluteFill>
  );
};

export const Slideshow = (props: SlideshowProps) => {
  const parsed = slideshowSchema.parse(props);
  const { fps } = useVideoConfig();
  const framesPerSlide = framesForSeconds(parsed.secondsPerSlide, fps);
  const transitionFrames = Math.min(Math.round(parsed.transitionSeconds * fps), framesPerSlide);

  return (
    <AbsoluteFill style={{ backgroundColor: parsed.brand.paper }}>
      {parsed.slides.map((slide, index) => (
        <Sequence key={index} from={index * framesPerSlide} durationInFrames={framesPerSlide}>
          <SlideView
            slide={slide}
            transitionFrames={transitionFrames}
            brand={parsed.brand}
            slideIn={index > 0}
          />
        </Sequence>
      ))}
    </AbsoluteFill>
  );
};
