import {
  AbsoluteFill,
  Img,
  useCurrentFrame,
  useVideoConfig,
  type CalculateMetadataFunction,
} from "remotion";
import { z } from "zod";
import { crossfadeSegments, framesForSeconds, segmentOpacity } from "../../timing";
import {
  brandColorsSchema,
  defaultBrandColors,
  dimensionsForFormat,
  fontStack,
  fpsSchema,
  plainLabel,
  videoFormatSchema,
} from "../schemas";

export const spin360Schema = z.object({
  images: z.array(z.string().min(1)).min(2).max(72),
  format: videoFormatSchema.default("9x16"),
  fps: fpsSchema.default(30),
  durationInSeconds: z.number().min(2).max(30).default(6),
  crossfadeSeconds: z.number().min(0).max(1).default(0.2),
  productName: plainLabel(80).optional(),
  brand: brandColorsSchema.default(defaultBrandColors),
});

export type Spin360Props = z.input<typeof spin360Schema>;

export const calculateSpin360Metadata: CalculateMetadataFunction<Spin360Props> = ({ props }) => {
  const parsed = spin360Schema.parse(props);
  return {
    ...dimensionsForFormat(parsed.format),
    fps: parsed.fps,
    durationInFrames: framesForSeconds(parsed.durationInSeconds, parsed.fps),
    props: parsed,
  };
};

export const Spin360 = (props: Spin360Props) => {
  const parsed = spin360Schema.parse(props);
  const frame = useCurrentFrame();
  const { durationInFrames, fps } = useVideoConfig();
  const requestedOverlap = Math.round(parsed.crossfadeSeconds * fps);
  const overlap = Math.max(0, Math.min(requestedOverlap, durationInFrames - 1));
  const segments = crossfadeSegments(parsed.images.length, durationInFrames, overlap);
  const last = segments.length - 1;

  return (
    <AbsoluteFill style={{ backgroundColor: parsed.brand.paper }}>
      {segments.map((segment) => {
        const opacity = segmentOpacity(frame, segment, overlap, segment.index === 0, segment.index === last);
        if (opacity <= 0) {
          return null;
        }
        return (
          <Img
            key={segment.index}
            src={parsed.images[segment.index]}
            style={{
              position: "absolute",
              inset: 0,
              width: "100%",
              height: "100%",
              objectFit: "contain",
              opacity,
            }}
          />
        );
      })}
      {parsed.productName ? (
        <div
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            bottom: "5%",
            textAlign: "center",
            fontFamily: fontStack,
            fontSize: 44,
            fontWeight: 600,
            color: parsed.brand.ink,
          }}
        >
          {parsed.productName}
        </div>
      ) : null}
    </AbsoluteFill>
  );
};
