import { cn } from "@curvi/ui";
import { aspectRatioCss, type PreviewAspect } from "@/lib/output-preview";

/**
 * Checkerboard from the ink tokens, so it follows the light and dark
 * palettes. It is painted on the image element, which is sized to the
 * picture, so only transparent pixels show it.
 */
export const CHECKERBOARD =
  "bg-[repeating-conic-gradient(var(--color-ink-200)_0%_25%,var(--color-ink-50)_0%_50%)] bg-[length:16px_16px]";

export interface OutputPreviewProps {
  src: string;
  alt: string;
  /** The channel's canvas shape (previewAspect). */
  aspect: PreviewAspect;
  /** Draw the checkerboard behind transparent pixels. */
  transparent?: boolean;
  className?: string;
  testId?: string;
}

/**
 * One delivered file as a preview: the whole picture, never cropped, inside
 * a box in the channel's shape on a neutral surface (PHASE_15 job page). A
 * kept photo in its own shape sits inside the box with the surface around it.
 */
export function OutputPreview({ src, alt, aspect, transparent = false, className, testId }: OutputPreviewProps) {
  return (
    <div
      className={cn(
        "flex w-full items-center justify-center overflow-hidden rounded-lg border border-ink-950/10 bg-ink-100",
        className,
      )}
      style={{ aspectRatio: aspectRatioCss(aspect) }}
      data-testid={testId ?? "output-preview"}
      data-transparent={transparent ? "true" : undefined}
    >
      {/* Signed R2 preview; a plain img avoids next/image domain config. */}
      <img
        src={src}
        alt={alt}
        loading="lazy"
        className={cn("block max-h-full max-w-full object-contain", transparent && CHECKERBOARD)}
      />
    </div>
  );
}
