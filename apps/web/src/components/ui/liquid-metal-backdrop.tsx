"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@curvi/ui";

/**
 * The only client code in the liquid metal hero. The server, and every
 * browser at first paint, renders the static CSS metal (.hero-metal-fallback).
 * After hydration, and only when the device should run it, the WebGL shader
 * loads in its own chunk at idle time and fades in over the fallback.
 *
 * The shader never runs when the visitor prefers reduced motion (it stops
 * live if they switch the setting on), on screens narrower than 48rem, with
 * Save-Data on, on devices reporting under 4 GB of memory or under 4 cores,
 * or without WebGL2. WebGL2 is probed first because the library throws
 * inside an async effect otherwise, where no error boundary can catch it. A
 * lost WebGL context, or a library error that still gets through, drops
 * back to the fallback for the rest of the visit.
 *
 * Offscreen and hidden tab pausing come from the library itself: it stops
 * its animation loop when this element leaves the viewport or the tab is
 * hidden. That only works because the backdrop is scoped to the hero, never
 * position fixed.
 */
const LiquidMetalCanvas = dynamic(() => import("./liquid-metal-canvas"), {
  ssr: false,
  loading: () => null,
});

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";
const WIDE_SCREEN = "(min-width: 48rem)";
const MIN_DEVICE_MEMORY_GB = 4;
const MIN_CPU_CORES = 4;
const IDLE_TIMEOUT_MS = 2000;

export interface ShaderEnvironment {
  reducedMotion: boolean;
  wideScreen: boolean;
  saveData: boolean;
  /** navigator.deviceMemory in GB, where the browser reports it. */
  deviceMemory?: number;
  hardwareConcurrency?: number;
  /** Called last, so phones and reduced motion visitors never create a probe context. */
  webgl2: () => boolean;
}

/** Whether the animated shader should run, given what the browser reports. */
export function shaderAllowed(env: ShaderEnvironment): boolean {
  return (
    !env.reducedMotion &&
    env.wideScreen &&
    !env.saveData &&
    (env.deviceMemory === undefined || env.deviceMemory >= MIN_DEVICE_MEMORY_GB) &&
    (env.hardwareConcurrency === undefined || env.hardwareConcurrency >= MIN_CPU_CORES) &&
    env.webgl2()
  );
}

let webgl2Support: boolean | undefined;

/** Probe WebGL2 once per page load on a throwaway canvas, then free the context. */
function supportsWebgl2(): boolean {
  if (webgl2Support === undefined) {
    try {
      const gl = document.createElement("canvas").getContext("webgl2");
      webgl2Support = gl !== null;
      gl?.getExtension("WEBGL_lose_context")?.loseContext();
    } catch {
      webgl2Support = false;
    }
  }
  return webgl2Support;
}

function readEnvironment(): ShaderEnvironment {
  const nav = navigator as Navigator & { connection?: { saveData?: boolean }; deviceMemory?: number };
  return {
    reducedMotion: window.matchMedia(REDUCED_MOTION).matches,
    wideScreen: window.matchMedia(WIDE_SCREEN).matches,
    saveData: nav.connection?.saveData === true,
    deviceMemory: typeof nav.deviceMemory === "number" ? nav.deviceMemory : undefined,
    hardwareConcurrency: nav.hardwareConcurrency > 0 ? nav.hardwareConcurrency : undefined,
    webgl2: supportsWebgl2,
  };
}

/** Run once the main thread is idle, so the shader never competes with first paint or hydration. */
function whenIdle(run: () => void): () => void {
  if (typeof window.requestIdleCallback === "function") {
    const id = window.requestIdleCallback(run, { timeout: IDLE_TIMEOUT_MS });
    return () => window.cancelIdleCallback(id);
  }
  const id = window.setTimeout(run, 200);
  return () => window.clearTimeout(id);
}

function isShaderLibraryError(reason: unknown): boolean {
  return reason instanceof Error && reason.message.startsWith("Paper Shaders");
}

export function LiquidMetalBackdrop({ className }: { className?: string }) {
  const [enabled, setEnabled] = useState(false);
  const [shown, setShown] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const motion = window.matchMedia(REDUCED_MOTION);
    const wide = window.matchMedia(WIDE_SCREEN);
    const wrapper = wrapperRef.current;
    let failed = false;
    let cancelIdle = () => {};

    const evaluate = () => {
      cancelIdle();
      if (failed || !shaderAllowed(readEnvironment())) {
        setEnabled(false);
        setShown(false);
        return;
      }
      cancelIdle = whenIdle(() => setEnabled(true));
    };
    const fail = () => {
      failed = true;
      evaluate();
    };
    const onRejection = (event: PromiseRejectionEvent) => {
      if (isShaderLibraryError(event.reason)) {
        event.preventDefault();
        fail();
      }
    };

    evaluate();
    motion.addEventListener("change", evaluate);
    wide.addEventListener("change", evaluate);
    // webglcontextlost does not bubble; a capture listener on an ancestor still sees it.
    wrapper?.addEventListener("webglcontextlost", fail, true);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      cancelIdle();
      motion.removeEventListener("change", evaluate);
      wide.removeEventListener("change", evaluate);
      wrapper?.removeEventListener("webglcontextlost", fail, true);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);

  // Two frames after the shader mounts, start the crossfade from the CSS metal.
  const onMounted = useCallback(() => {
    requestAnimationFrame(() => requestAnimationFrame(() => setShown(true)));
  }, []);

  return (
    <div
      ref={wrapperRef}
      aria-hidden="true"
      data-testid="hero-backdrop"
      data-shader={enabled ? "on" : "off"}
      className={cn("pointer-events-none overflow-hidden", className)}
    >
      <div data-testid="hero-metal-fallback" className="hero-metal-fallback absolute inset-0" />
      {enabled ? (
        // Oversized past the hero's edges, which clip it: the full bleed metal
        // fades to its back color near its own borders, and that fade stays
        // out of view.
        <div
          className={cn(
            "absolute inset-x-[-10%] inset-y-[-18%] transition-opacity duration-[900ms] ease-out",
            shown ? "opacity-100" : "opacity-0",
          )}
        >
          <LiquidMetalCanvas onMounted={onMounted} />
        </div>
      ) : null}
    </div>
  );
}
