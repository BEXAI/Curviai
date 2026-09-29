"use client";

import { useEffect } from "react";
import { LiquidMetal } from "@paper-design/shaders-react";

/**
 * The WebGL liquid metal itself. Only LiquidMetalBackdrop loads this file,
 * through next/dynamic with ssr false, so the shader library stays out of
 * the first load bundle and never runs on the server.
 *
 * The values are written out rather than spread from a library preset:
 * @paper-design/shaders-react ships breaking changes under 0.0.x, so a
 * version bump must not change the look silently. They start from the
 * library's full bleed "Backdrop" preset (shape none, scale 1) and are tuned
 * to the brand: the night page color behind the metal, a wine color burn
 * tint (the metal's own colors are fixed in the shader; only the tint moves
 * them), no blue shift so the fringes read burgundy and teal instead of a
 * rainbow, and a calmer speed. Compared side by side on 2026-09-29 against
 * the plain Backdrop colors and lighter and darker tints.
 */
const BRAND_METAL = {
  shape: "none",
  fit: "contain",
  scale: 1,
  worldWidth: 0,
  worldHeight: 0,
  colorBack: "#07080d",
  colorTint: "#d0587a",
  repetition: 1.5,
  softness: 0.15,
  distortion: 0.1,
  contour: 0.4,
  shiftRed: 0.3,
  shiftBlue: 0,
  angle: 70,
  speed: 0.35,
} as const;

/**
 * Render at the screen's own density with no 2x floor, and at most about
 * 0.9 megapixels. The soft stripes upscale without visible loss, and this
 * is several times fewer pixels than the library default.
 */
const MIN_PIXEL_RATIO = 1;
const MAX_PIXEL_COUNT = 1280 * 720;

export default function LiquidMetalCanvas({ onMounted }: { onMounted?: () => void }) {
  useEffect(() => {
    onMounted?.();
  }, [onMounted]);

  return (
    <LiquidMetal
      {...BRAND_METAL}
      minPixelRatio={MIN_PIXEL_RATIO}
      maxPixelCount={MAX_PIXEL_COUNT}
      className="h-full w-full"
    />
  );
}
