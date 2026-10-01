"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import { CONSENT_CHANGED_EVENT, openaiAdsPixelId, readConsent, type ConsentChoice } from "@/lib/consent";

/** OpenAI Ads pixel loader, as given by Ads Manager (data source "e-commerce"). */
const OPENAI_ADS_SDK_URL = "https://bzrcdn.openai.com/sdk/oaiq.min.js";

type Oaiq = ((...args: unknown[]) => void) & { q?: unknown[][] };

function currentOaiq(): Oaiq | undefined {
  return (window as unknown as { oaiq?: Oaiq }).oaiq;
}

/** The Page Viewed conversion event, exactly as Ads Manager gives it. */
function measurePageView(): void {
  currentOaiq()?.("measure", "page_viewed", { type: "contents" });
}

/**
 * The OpenAI Ads pixel, loaded only after the visitor accepts cookies, the
 * same consent PostHog waits for (lib/consent.ts). Before a choice, or after
 * a decline, no pixel code loads and nothing is measured. It sends Page
 * Viewed when it starts and on every later client side navigation. Debug
 * logging stays on outside production only.
 */
export function AdsPixel() {
  const pathname = usePathname();
  const lastMeasured = useRef<string | null>(null);

  useEffect(() => {
    const pixelId = openaiAdsPixelId();
    if (!pixelId) {
      return;
    }
    const start = (): void => {
      if (!currentOaiq()) {
        const q: Oaiq = (...args: unknown[]) => {
          q.q?.push(args);
        };
        q.q = [];
        (window as unknown as { oaiq?: Oaiq }).oaiq = q;
        const script = document.createElement("script");
        script.async = true;
        script.src = OPENAI_ADS_SDK_URL;
        document.head.appendChild(script);
        q("init", { pixelId, debug: process.env.NODE_ENV !== "production" });
      }
      if (lastMeasured.current !== window.location.pathname) {
        lastMeasured.current = window.location.pathname;
        measurePageView();
      }
    };
    const apply = (choice: ConsentChoice | null): void => {
      if (choice === "granted") start();
    };
    apply(readConsent());
    const onChange = (event: Event): void => apply((event as CustomEvent<ConsentChoice>).detail ?? null);
    window.addEventListener(CONSENT_CHANGED_EVENT, onChange);
    return () => window.removeEventListener(CONSENT_CHANGED_EVENT, onChange);
  }, []);

  // Client side navigations after the pixel started.
  useEffect(() => {
    if (!currentOaiq() || readConsent() !== "granted" || lastMeasured.current === pathname) {
      return;
    }
    lastMeasured.current = pathname;
    measurePageView();
  }, [pathname]);

  return null;
}
