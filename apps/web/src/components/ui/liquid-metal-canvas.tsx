"use client";

import { useEffect, useRef, type RefObject } from "react";
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
 * tint in the logo teal, recolored across the hero by the .hero-metal-hue
 * layer in globals.css (the metal's own colors are fixed in the shader; only the tint moves
 * them), a gentle red shift and no blue shift so the fringes read wine
 * instead of a rainbow, and a calmer speed. The comparison and the date are
 * in docs/phases/HOME_LIQUID_METAL.md. The two colors match the night and
 * wine tokens in globals.css; the shader needs literal color strings.
 */
const BRAND_METAL = {
  shape: "none",
  fit: "contain",
  scale: 1,
  worldWidth: 0,
  worldHeight: 0,
  colorBack: "#07080d",
  colorTint: "#2dd4bf",
  repetition: 1.5,
  softness: 0.15,
  distortion: 0.1,
  contour: 0.4,
  shiftRed: 0.15,
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
/** Stop waiting for a first frame after about ten seconds of animation frames. */
const MAX_WAIT_FRAMES = 600;

type ShaderHost = HTMLElement & { paperShaderMount?: unknown };

/**
 * The library builds its WebGL program asynchronously after mount and draws
 * its first frame when its canvas gets a size. Report onDrawn only then, so
 * the crossfade never runs over an empty canvas.
 */
function useFirstFrame(hostRef: RefObject<HTMLDivElement | null>, onDrawn?: () => void) {
  useEffect(() => {
    let frame = 0;
    let id = 0;
    const check = () => {
      const shader = hostRef.current?.querySelector<ShaderHost>("[data-paper-shader]");
      const canvas = shader?.querySelector("canvas");
      if (shader?.paperShaderMount && canvas && canvas.width > 0 && canvas.height > 0) {
        onDrawn?.();
        return;
      }
      frame += 1;
      if (frame < MAX_WAIT_FRAMES) {
        id = requestAnimationFrame(check);
      }
    };
    id = requestAnimationFrame(check);
    return () => cancelAnimationFrame(id);
  }, [hostRef, onDrawn]);
}

export default function LiquidMetalCanvas({ paused = false, onDrawn }: { paused?: boolean; onDrawn?: () => void }) {
  const hostRef = useRef<HTMLDivElement>(null);
  useFirstFrame(hostRef, onDrawn);

  return (
    <div ref={hostRef} className="h-full w-full">
      <LiquidMetal
        {...BRAND_METAL}
        // Speed 0 stops the library's animation loop entirely, on the frame it shows.
        speed={paused ? 0 : BRAND_METAL.speed}
        minPixelRatio={MIN_PIXEL_RATIO}
        maxPixelCount={MAX_PIXEL_COUNT}
        className="h-full w-full"
      />
    </div>
  );
}
