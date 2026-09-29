import type { ReactNode } from "react";
import Link from "next/link";
import { Badge, Card, buttonVariants, cn } from "@curvi/ui";
import { LiquidMetalBackdrop, LiquidMetalMotionToggle } from "./liquid-metal-backdrop";

/**
 * Full bleed liquid metal hero: a centered badge, a very large headline, a
 * subtitle, two calls to action, a note and a frosted feature card over an
 * animated WebGL metal backdrop.
 *
 * Adapted from the 21st.dev LiquidMetalHero for this site. It is not a client
 * component, so the headline and subtitle are server HTML, visible without
 * JavaScript and never faded in (the headline is the LCP element and carries
 * SEO). The only client code is the backdrop and its motion toggle.
 *
 * The entrance stagger is CSS and runs only for visitors without a reduced
 * motion preference (every entrance class is motion-safe): the headline and
 * subtitle only move, everything else fades up after them. Under reduced
 * motion nothing animates or waits, so every item shows at once.
 *
 * The calls to action are links. The original's click handlers are gone: a
 * server component cannot pass them, and a call to action without a target
 * would be a control that does nothing.
 */

export interface LiquidMetalHeroFeature {
  label: ReactNode;
  icon?: ReactNode;
}

type SecondaryCta =
  | { secondaryCtaLabel: string; secondaryCtaHref: string }
  | { secondaryCtaLabel?: undefined; secondaryCtaHref?: undefined };

export type LiquidMetalHeroProps = {
  badge?: ReactNode;
  title: ReactNode;
  subtitle: ReactNode;
  primaryCtaLabel: string;
  primaryCtaHref: string;
  /** Small line under the calls to action. */
  note?: ReactNode;
  features?: readonly (string | LiquidMetalHeroFeature)[];
  /** id for the headline; the section is labelled by it. */
  titleId?: string;
  className?: string;
} & SecondaryCta;

const lift = "motion-safe:hover:-translate-y-0.5";

const primaryCtaClass = buttonVariants({
  variant: "secondary",
  size: "lg",
  className: cn("h-14 px-8 text-lg", lift),
});

const secondaryCtaClass = buttonVariants({
  variant: "glass",
  size: "lg",
  className: cn("h-14 px-8 text-lg", lift),
});

// Entrance classes. Each one is motion-safe, so under reduced motion an item
// neither animates nor sits at opacity 0 through a delay.
const fadeUp = "motion-safe:animate-fade-in-up";
const riseIn = "motion-safe:animate-rise-in";
// Stagger for the feature items, after the card itself (360ms).
const featureDelays = [
  "motion-safe:[animation-delay:440ms]",
  "motion-safe:[animation-delay:520ms]",
  "motion-safe:[animation-delay:600ms]",
];

export function LiquidMetalHero({
  badge,
  title,
  subtitle,
  primaryCtaLabel,
  primaryCtaHref,
  secondaryCtaLabel,
  secondaryCtaHref,
  note,
  features,
  titleId = "liquid-metal-hero-title",
  className,
}: LiquidMetalHeroProps) {
  const items = (features ?? []).map((feature) =>
    typeof feature === "string" ? { label: feature, icon: undefined } : feature,
  );

  return (
    <section
      aria-labelledby={titleId}
      data-testid="liquid-metal-hero"
      className={cn("relative isolate flex min-h-[calc(100svh-4rem)] items-center overflow-hidden", className)}
    >
      <LiquidMetalBackdrop className="absolute inset-0 z-0" />
      <div aria-hidden="true" className="hero-metal-scrim pointer-events-none absolute inset-0 z-[1]" />

      <div className="relative z-10 mx-auto w-full max-w-6xl px-6 pb-16 pt-20 text-center sm:pb-20">
        {badge ? (
          <Badge
            className={cn(
              "bg-night/70 px-3 py-1 font-mono text-[0.6875rem] uppercase tracking-[0.12em] text-ink-100 ring-white/20 sm:text-xs sm:tracking-[0.18em]",
              fadeUp,
            )}
          >
            {badge}
          </Badge>
        ) : null}

        <h1
          id={titleId}
          className={cn(
            "mx-auto mt-6 text-balance font-display text-[clamp(2.25rem,8.5vw,5.75rem)] font-bold uppercase leading-[0.95] tracking-tight text-white",
            riseIn,
          )}
        >
          {title}
        </h1>

        <p
          className={cn(
            "mx-auto mt-6 max-w-2xl text-lg text-ink-100 sm:text-xl",
            riseIn,
            "motion-safe:[animation-delay:120ms]",
          )}
        >
          {subtitle}
        </p>

        <div
          className={cn(
            "mt-10 flex flex-col items-stretch justify-center gap-3 sm:flex-row sm:items-center",
            fadeUp,
            "motion-safe:[animation-delay:240ms]",
          )}
        >
          <Link href={primaryCtaHref} className={primaryCtaClass}>
            {primaryCtaLabel}
          </Link>
          {secondaryCtaLabel ? (
            <Link href={secondaryCtaHref} className={secondaryCtaClass}>
              {secondaryCtaLabel}
            </Link>
          ) : null}
        </div>

        {note ? (
          <p className={cn("mt-4 text-sm text-ink-200", fadeUp, "motion-safe:[animation-delay:300ms]")}>{note}</p>
        ) : null}

        {items.length > 0 ? (
          <Card
            className={cn(
              "mx-auto mt-12 max-w-4xl border-white/15 bg-night/80 shadow-sheen hover:border-white/15",
              fadeUp,
              "motion-safe:[animation-delay:360ms]",
            )}
          >
            <ul className="grid divide-y divide-white/10 sm:grid-cols-3 sm:divide-x sm:divide-y-0">
              {items.map((item, index) => (
                <li
                  key={index}
                  className={cn(
                    "flex items-center gap-3 px-5 py-4 text-left sm:flex-col sm:justify-start sm:gap-3 sm:py-6 sm:text-center",
                    fadeUp,
                    featureDelays[index % featureDelays.length],
                  )}
                >
                  {item.icon ? (
                    <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-lg bg-teal-brand/10 text-teal-brand ring-1 ring-inset ring-teal-brand/25">
                      {item.icon}
                    </span>
                  ) : null}
                  <span className="text-sm font-medium text-white sm:text-base">{item.label}</span>
                </li>
              ))}
            </ul>
          </Card>
        ) : null}
      </div>

      <LiquidMetalMotionToggle className="absolute bottom-4 right-4 z-20" />
    </section>
  );
}
