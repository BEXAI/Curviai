import type { CSSProperties } from "react";
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
  type BrandColors,
} from "../schemas";

const measurementSchema = z.object({
  label: plainLabel(30),
  edge: z.enum(["bottom", "left", "right", "top"]).default("bottom"),
});

export const dimensionRevealSchema = z.object({
  image: z.string().min(1),
  measurements: z.array(measurementSchema).min(1).max(4),
  format: videoFormatSchema.default("9x16"),
  fps: fpsSchema.default(30),
  durationInSeconds: z.number().min(3).max(15).default(6),
  brand: brandColorsSchema.default(defaultBrandColors),
});

export type DimensionRevealProps = z.input<typeof dimensionRevealSchema>;
type Measurement = z.output<typeof measurementSchema>;

export const calculateDimensionRevealMetadata: CalculateMetadataFunction<DimensionRevealProps> = ({
  props,
}) => {
  const parsed = dimensionRevealSchema.parse(props);
  return {
    ...dimensionsForFormat(parsed.format),
    fps: parsed.fps,
    durationInFrames: framesForSeconds(parsed.durationInSeconds, parsed.fps),
    props: parsed,
  };
};

/** Product image bounds in percent of the canvas. Lines hug these edges. */
const box = { left: 20, top: 20, width: 60, height: 50 };

const MeasureLine = ({
  measurement,
  progress,
  brand,
}: {
  measurement: Measurement;
  progress: number;
  brand: BrandColors;
}) => {
  const horizontal = measurement.edge === "bottom" || measurement.edge === "top";
  const containerStyle: CSSProperties = horizontal
    ? {
        position: "absolute",
        left: `${box.left}%`,
        width: `${box.width}%`,
        top: measurement.edge === "bottom" ? `${box.top + box.height + 5}%` : `${box.top - 7}%`,
        height: 0,
      }
    : {
        position: "absolute",
        top: `${box.top}%`,
        height: `${box.height}%`,
        left: measurement.edge === "left" ? `${box.left - 7}%` : `${box.left + box.width + 5}%`,
        width: 0,
      };
  const lineStyle: CSSProperties = horizontal
    ? {
        position: "absolute",
        left: 0,
        right: 0,
        top: -2,
        height: 4,
        backgroundColor: brand.accent,
        transform: `scaleX(${progress})`,
        transformOrigin: "center",
      }
    : {
        position: "absolute",
        top: 0,
        bottom: 0,
        left: -2,
        width: 4,
        backgroundColor: brand.accent,
        transform: `scaleY(${progress})`,
        transformOrigin: "center",
      };
  const tickBase: CSSProperties = horizontal
    ? { position: "absolute", top: -14, width: 4, height: 28, backgroundColor: brand.accent }
    : { position: "absolute", left: -14, height: 4, width: 28, backgroundColor: brand.accent };
  const labelStyle: CSSProperties = horizontal
    ? {
        position: "absolute",
        left: "50%",
        top: 14,
        transform: "translateX(-50%)",
        whiteSpace: "nowrap",
      }
    : {
        position: "absolute",
        top: "50%",
        left: measurement.edge === "left" ? undefined : 24,
        right: measurement.edge === "left" ? 24 : undefined,
        transform: "translateY(-50%)",
        whiteSpace: "nowrap",
      };

  return (
    <div style={{ ...containerStyle, opacity: progress }}>
      <div style={lineStyle} />
      <div style={{ ...tickBase, ...(horizontal ? { left: -2 } : { top: -2 }) }} />
      <div style={{ ...tickBase, ...(horizontal ? { right: -2 } : { bottom: -2 }) }} />
      <div
        style={{
          ...labelStyle,
          fontFamily: fontStack,
          fontSize: 34,
          fontWeight: 600,
          color: brand.ink,
          backgroundColor: brand.paper,
          padding: "4px 14px",
          borderRadius: 8,
        }}
      >
        {measurement.label}
      </div>
    </div>
  );
};

export const DimensionReveal = (props: DimensionRevealProps) => {
  const parsed = dimensionRevealSchema.parse(props);
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const starts = staggeredStarts(
    parsed.measurements.length,
    Math.round(0.4 * fps),
    Math.round(0.6 * fps),
  );
  const springDuration = Math.round(0.9 * fps);

  return (
    <AbsoluteFill style={{ backgroundColor: parsed.brand.paper }}>
      <Img
        src={parsed.image}
        style={{
          position: "absolute",
          left: `${box.left}%`,
          top: `${box.top}%`,
          width: `${box.width}%`,
          height: `${box.height}%`,
          objectFit: "contain",
        }}
      />
      {parsed.measurements.map((measurement, index) => {
        const start = starts[index];
        const progress = spring({
          frame: Math.max(0, frame - start),
          fps,
          durationInFrames: springDuration,
          config: { damping: 200, stiffness: 140 },
        });
        return (
          <MeasureLine
            key={`${index}-${measurement.label}`}
            measurement={measurement}
            progress={frame >= start ? progress : 0}
            brand={parsed.brand}
          />
        );
      })}
    </AbsoluteFill>
  );
};
