"use client";

import { useCallback, useRef, useState } from "react";
import { cn } from "@curvi/ui";

export interface BeforeAfterSliderProps {
  beforeSrc: string;
  afterSrc: string;
  beforeLabel?: string;
  afterLabel?: string;
  className?: string;
}

/**
 * Draggable before and after comparison. Server render shows both images
 * split at 50 percent, so the component still reads as stacked images when
 * JavaScript is unavailable.
 */
export function BeforeAfterSlider({
  beforeSrc,
  afterSrc,
  beforeLabel = "Before",
  afterLabel = "After",
  className,
}: BeforeAfterSliderProps) {
  const [percent, setPercent] = useState(50);
  const containerRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);

  const updateFromClientX = useCallback((clientX: number) => {
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const next = ((clientX - rect.left) / rect.width) * 100;
    setPercent(Math.min(100, Math.max(0, next)));
  }, []);

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      draggingRef.current = true;
      event.currentTarget.setPointerCapture(event.pointerId);
      updateFromClientX(event.clientX);
    },
    [updateFromClientX],
  );

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (draggingRef.current) {
        updateFromClientX(event.clientX);
      }
    },
    [updateFromClientX],
  );

  const stopDragging = useCallback(() => {
    draggingRef.current = false;
  }, []);

  return (
    <div className={cn("select-none", className)}>
      <div
        ref={containerRef}
        className="relative aspect-square w-full cursor-ew-resize overflow-hidden rounded-xl border border-ink-200 bg-white shadow-sm"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={stopDragging}
        onPointerCancel={stopDragging}
      >
        <img src={afterSrc} alt={afterLabel} className="absolute inset-0 h-full w-full object-cover" draggable={false} />
        <div className="absolute inset-0" style={{ clipPath: `inset(0 ${100 - percent}% 0 0)` }}>
          <img
            src={beforeSrc}
            alt={beforeLabel}
            className="absolute inset-0 h-full w-full object-cover"
            draggable={false}
          />
        </div>
        <div
          className="absolute inset-y-0 w-0.5 bg-white shadow-[0_0_0_1px_rgba(19,24,38,0.2)]"
          style={{ left: `${percent}%` }}
          aria-hidden="true"
        >
          <span className="absolute left-1/2 top-1/2 flex h-9 w-9 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-ink-200 bg-white text-ink-500 shadow-md">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
              <path d="M4.5 2.5 1 7l3.5 4.5M9.5 2.5 13 7l-3.5 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
        </div>
        <span className="absolute left-3 top-3 rounded-full bg-ink-900/80 px-2.5 py-0.5 text-xs font-medium text-white">
          {beforeLabel}
        </span>
        <span className="absolute right-3 top-3 rounded-full bg-white/90 px-2.5 py-0.5 text-xs font-medium text-ink-900 shadow-sm">
          {afterLabel}
        </span>
      </div>
      <label className="mt-3 block">
        <span className="sr-only">Compare before and after</span>
        <input
          type="range"
          min={0}
          max={100}
          value={Math.round(percent)}
          onChange={(event) => setPercent(Number(event.target.value))}
          className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-ink-100 accent-accent-500"
        />
      </label>
    </div>
  );
}
