"use client";

import dynamic from "next/dynamic";
import { Component, useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { cn } from "@curvi/ui";

/**
 * The client code of the liquid metal hero. The server, and every browser at
 * first paint, renders the static CSS metal (.hero-metal-fallback). After
 * hydration, and only when the device should run it, the WebGL shader loads
 * in its own chunk at idle time and fades in over the fallback once it has
 * drawn its first frame.
 *
 * The shader never runs when the visitor prefers reduced motion (it stops
 * live if they switch the setting on), on screens under 20rem in
 * either direction, with Save-Data on, on devices reporting under
 * 4 GB of memory or under 4 cores, or without WebGL2. The cheap checks run
 * right after hydration; the WebGL2 probe creates a context, so it waits for
 * the idle callback. WebGL2 is probed at all because the library throws
 * inside an async effect otherwise, where no error boundary can catch it. A
 * lost WebGL context, a library error that still gets through, or a shader
 * chunk that fails to load drops back to the fallback for the rest of the
 * visit, and never takes the page down.
 *
 * Offscreen and hidden tab pausing come from the library itself: it stops
 * its animation loop when this element leaves the viewport or the tab is
 * hidden. That only works because the backdrop is scoped to the hero, never
 * position fixed. While the shader runs, LiquidMetalMotionToggle offers a
 * pause (WCAG 2.2.2), remembered in this browser.
 */
const LiquidMetalCanvas = dynamic(() => import("./liquid-metal-canvas"), {
  ssr: false,
  loading: () => null,
});

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";
/** Any real screen, phones and tablets included: the metal moves on every capable device. */
const DESKTOP_SCREEN = "(min-width: 20rem) and (min-height: 20rem)";
const MIN_DEVICE_MEMORY_GB = 4;
const MIN_CPU_CORES = 4;
const IDLE_TIMEOUT_MS = 2000;
const PAUSED_STORAGE_KEY = "curvi.heroMotionPaused";

export interface ShaderEnvironment {
  reducedMotion: boolean;
  /** Matches DESKTOP_SCREEN. */
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
    wideScreen: window.matchMedia(DESKTOP_SCREEN).matches,
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

/**
 * Motion state shared by the backdrop (which runs the shader) and the toggle
 * (which sits after the hero content, so it comes after the calls to action
 * in the tab order). One hero per page, so one module level store.
 */
interface MotionState {
  /** The shader is running and has drawn: there is motion to pause. */
  running: boolean;
  paused: boolean;
}

let motionState: MotionState = { running: false, paused: false };
const SERVER_MOTION_STATE: MotionState = { running: false, paused: false };
const motionListeners = new Set<() => void>();

function setMotionState(next: Partial<MotionState>) {
  motionState = { ...motionState, ...next };
  motionListeners.forEach((listener) => listener());
}

function subscribeMotion(listener: () => void) {
  motionListeners.add(listener);
  return () => {
    motionListeners.delete(listener);
  };
}

function useMotionState(): MotionState {
  return useSyncExternalStore(
    subscribeMotion,
    () => motionState,
    () => SERVER_MOTION_STATE,
  );
}

function readPausedPreference(): boolean {
  try {
    return window.localStorage.getItem(PAUSED_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function writePausedPreference(paused: boolean) {
  try {
    if (paused) {
      window.localStorage.setItem(PAUSED_STORAGE_KEY, "1");
    } else {
      window.localStorage.removeItem(PAUSED_STORAGE_KEY);
    }
  } catch {
    // Storage can be blocked; the toggle still works for this visit.
  }
}

/**
 * Keeps a failed shader (a chunk that did not load, or a render error in the
 * library) inside the backdrop: it renders nothing and reports the failure,
 * so the page keeps the static metal instead of the root error page.
 */
class ShaderBoundary extends Component<{ onError: () => void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch() {
    this.props.onError();
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}

export function LiquidMetalBackdrop({ className }: { className?: string }) {
  const [enabled, setEnabled] = useState(false);
  const [shown, setShown] = useState(false);
  const { paused } = useMotionState();
  const wrapperRef = useRef<HTMLDivElement>(null);
  const failRef = useRef<() => void>(() => {});

  useEffect(() => {
    setMotionState({ paused: readPausedPreference() });
    const motion = window.matchMedia(REDUCED_MOTION);
    const desktop = window.matchMedia(DESKTOP_SCREEN);
    const wrapper = wrapperRef.current;
    let failed = false;
    let cancelIdle = () => {};

    const evaluate = () => {
      cancelIdle();
      // Everything but the WebGL2 probe is cheap and runs now; the probe
      // creates a context, so it waits for idle time with the mount itself.
      if (failed || !shaderAllowed({ ...readEnvironment(), webgl2: () => true })) {
        setEnabled(false);
        setShown(false);
        setMotionState({ running: false });
        return;
      }
      cancelIdle = whenIdle(() => {
        if (!failed && supportsWebgl2()) {
          setEnabled(true);
        }
      });
    };
    const fail = () => {
      failed = true;
      evaluate();
    };
    failRef.current = fail;
    const onRejection = (event: PromiseRejectionEvent) => {
      if (isShaderLibraryError(event.reason)) {
        event.preventDefault();
        fail();
      }
    };

    evaluate();
    motion.addEventListener("change", evaluate);
    desktop.addEventListener("change", evaluate);
    // webglcontextlost does not bubble; a capture listener on an ancestor still sees it.
    wrapper?.addEventListener("webglcontextlost", fail, true);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      cancelIdle();
      failRef.current = () => {};
      setMotionState({ running: false });
      motion.removeEventListener("change", evaluate);
      desktop.removeEventListener("change", evaluate);
      wrapper?.removeEventListener("webglcontextlost", fail, true);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);

  // The shader has drawn its first frame: start the crossfade from the CSS metal.
  const onDrawn = useCallback(() => {
    requestAnimationFrame(() => {
      setShown(true);
      setMotionState({ running: true });
    });
  }, []);

  const onShaderError = useCallback(() => failRef.current(), []);

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
          <ShaderBoundary onError={onShaderError}>
            <LiquidMetalCanvas paused={paused} onDrawn={onDrawn} />
          </ShaderBoundary>
        </div>
      ) : null}
      {/* The logo's teal to pink sweep, laid over both metals as a color blend. */}
      <div data-testid="hero-metal-hue" className="hero-metal-hue absolute inset-0" />
    </div>
  );
}

/**
 * Pause and play for the animated metal. It renders only while the shader
 * runs: the static metal on phones and under reduced motion does not move.
 */
export function LiquidMetalMotionToggle({ className }: { className?: string }) {
  const { running, paused } = useMotionState();
  if (!running) {
    return null;
  }
  return (
    <button
      type="button"
      data-testid="hero-motion-toggle"
      onClick={() => {
        writePausedPreference(!paused);
        setMotionState({ paused: !paused });
      }}
      className={cn(
        "inline-flex items-center gap-2 rounded-full bg-night/80 px-3 py-1.5 text-xs font-medium text-ink-100 ring-1 ring-inset ring-white/20 transition-colors hover:bg-night hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white",
        className,
      )}
    >
      <svg viewBox="0 0 12 12" className="size-3" fill="currentColor" aria-hidden="true">
        {paused ? <path d="M3 1.8v8.4L10 6z" /> : <path d="M2.5 1.5h2.5v9H2.5zM7 1.5h2.5v9H7z" />}
      </svg>
      {paused ? "Play background motion" : "Pause background motion"}
    </button>
  );
}
