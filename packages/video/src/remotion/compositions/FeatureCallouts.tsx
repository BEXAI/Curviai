import {
  AbsoluteFill,
  Img,
  spring,
  useCurrentFrame,
  useVideoConfig,
  type CalculateMetadataFunction,
} from "remotion";
import { z } from "zod";
import { framesForSeconds, staggeredStarts } from "../../timing";
import {
  brandColorsSchema,
  defaultBrandColors,
  dimensionsForFormat,
  fontStack,
  fpsSchema,
  plainLabel,
  videoFormatSchema,
} from "../schemas";

export const featureCalloutsSchema = z.object({
  heroImage: z.string().min(1),
  callouts: z.array(plainLabel(40)).min(3).max(5),
  heading: plainLabel(60).optional(),
  format: videoFormatSchema.default("9x16"),
  fps: fpsSchema.default(30),
  durationInSeconds: z.number().min(4).max(20).default(8),
  brand: brandColorsSchema.default(defaultBrandColors),
});

export type FeatureCalloutsProps = z.input<typeof featureCalloutsSchema>;

export const calculateFeatureCalloutsMetadata: CalculateMetadataFunction<FeatureCalloutsProps> = ({
  props,
}) => {
  const parsed = featureCalloutsSchema.parse(props);
  return {
    ...dimensionsForFormat(parsed.format),
    fps: parsed.fps,
    durationInFrames: framesForSeconds(parsed.durationInSeconds, parsed.fps),
    props: parsed,
  };
};

export const FeatureCallouts = (props: FeatureCalloutsProps) => {
  const parsed = featureCalloutsSchema.parse(props);
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const introFrames = Math.round(0.5 * fps);
  const strideFrames =
    parsed.callouts.length > 1
      ? Math.max(1, Math.floor((durationInFrames * 0.7 - introFrames) / (parsed.callouts.length - 1)))
      : 0;
  const starts = staggeredStarts(parsed.callouts.length, introFrames, strideFrames);
  const springDuration = Math.round(0.8 * fps);

  return (
    <AbsoluteFill style={{ backgroundColor: parsed.brand.paper, fontFamily: fontStack }}>
      {parsed.heading ? (
        <div
          style={{
            position: "absolute",
            left: "6%",
            right: "6%",
            top: "3%",
            textAlign: "center",
            fontSize: 52,
            fontWeight: 700,
            color: parsed.brand.ink,
          }}
        >
          {parsed.heading}
        </div>
      ) : null}
      <Img
        src={parsed.heroImage}
        style={{
          position: "absolute",
          left: "10%",
          top: parsed.heading ? "10%" : "6%",
          width: "80%",
          height: parsed.heading ? "38%" : "42%",
          objectFit: "contain",
        }}
      />
      <div
        style={{
          position: "absolute",
          left: "9%",
          right: "9%",
          top: "52%",
          bottom: "4%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "flex-start",
          gap: 20,
        }}
      >
        {parsed.callouts.map((label, index) => {
          const start = starts[index];
          const progress = spring({
            frame: Math.max(0, frame - start),
            fps,
            durationInFrames: springDuration,
            config: { damping: 200, stiffness: 120 },
          });
          const visible = frame >= start;
          return (
            <div
              key={`${index}-${label}`}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 20,
                padding: "18px 28px",
                borderRadius: 16,
                backgroundColor: parsed.brand.paper,
                border: `3px solid ${parsed.brand.accent}`,
                opacity: visible ? progress : 0,
                transform: `translateY(${(1 - progress) * 48}px)`,
              }}
            >
              <div
                style={{
                  width: 18,
                  height: 18,
                  borderRadius: 9,
                  backgroundColor: parsed.brand.accent,
                  flexShrink: 0,
                }}
              />
              <div style={{ fontSize: 38, fontWeight: 600, color: parsed.brand.ink }}>{label}</div>
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};
