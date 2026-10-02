"use client";

import { useEffect, useState } from "react";
import { cn } from "@curvi/ui";
import type { FoundingOfferView } from "@/lib/offer/founding";
import { fetchFoundingOffer, foundingOfferHidden, hideFoundingOffer } from "@/lib/offer/founding-client";
import { FOUNDING_BANNER_DISMISS_LABEL, foundingBannerText } from "./offer-copy";

function browserStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/**
 * The founding member banner (docs/phases/PHASE_18.md P18-21) on /pricing
 * and the home page. Renders nothing until GET /api/offer says the offer is
 * live (the switch is on, seats are left, the code is active in Stripe and
 * packs run), and nothing again once the visitor hides it.
 */
export function FoundingOfferBanner({ tone = "light", className }: { tone?: "light" | "night"; className?: string }) {
  const [view, setView] = useState<FoundingOfferView | null>(null);

  useEffect(() => {
    let active = true;
    void fetchFoundingOffer().then((next) => {
      if (active && next && !foundingOfferHidden(next.endsOn, browserStorage())) {
        setView(next);
      }
    });
    return () => {
      active = false;
    };
  }, []);

  if (!view) {
    return null;
  }
  const text = foundingBannerText(view);
  const night = tone === "night";
  return (
    <aside
      data-testid="founding-offer-banner"
      aria-label="Founding member offer"
      className={cn(
        "relative mx-auto flex max-w-3xl items-start gap-4 rounded-xl p-4 pr-12 text-sm",
        night ? "bg-white/[0.06] text-ink-100 ring-1 ring-inset ring-white/15" : "border border-accent-200 bg-accent-50 text-ink-800",
        className,
      )}
    >
      <div className="space-y-1">
        <p className={cn("font-semibold", night ? "text-white" : "text-ink-950")}>{text.title}</p>
        <p data-testid="founding-offer-seats">{text.body}</p>
        {text.annual ? <p className={night ? "text-ink-300" : "text-ink-600"}>{text.annual}</p> : null}
      </div>
      <button
        type="button"
        aria-label={FOUNDING_BANNER_DISMISS_LABEL}
        data-testid="founding-offer-hide"
        onClick={() => {
          hideFoundingOffer(view.endsOn, browserStorage());
          setView(null);
        }}
        className={cn(
          "absolute right-3 top-3 rounded-md p-1",
          night ? "text-ink-300 hover:bg-white/10 hover:text-white" : "text-ink-500 hover:bg-accent-100 hover:text-ink-900",
        )}
      >
        <svg className="h-4 w-4" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      </button>
    </aside>
  );
}
