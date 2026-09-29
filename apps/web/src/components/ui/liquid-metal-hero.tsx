import type { ReactNode } from "react";
import Link from "next/link";
import { Badge, Card, buttonVariants, cn } from "@curvi/ui";
import { LiquidMetalBackdrop } from "./liquid-metal-backdrop";

/**
 * Full bleed liquid metal hero: a centered badge, a very large headline, a
 * subtitle, two calls to action, a note and a frosted feature card over an
 * animated WebGL metal backdrop.
 *
 * Adapted from the 21st.dev LiquidMetalHero for this site. It is not a client
 * component, so the headline and subtitle are server HTML, visible without
 * JavaScript and never faded in (the headline is the LCP element and carries
 * SEO). The only client code is the backdrop. The entrance stagger is CSS:
 * the headline and subtitle only move, everything else fades up after them,
 * and the global reduced motion rule makes all of it instant.
 *
 * Props stay compatible with the original (label plus click handler per
 * call to action, features as strings). On this site pass hrefs: a call to
 * action with an href renders as a link. Click handlers work only when the
 * hero is rendered from a client component.
 */

export interface LiquidMetalHeroFeature {
  label: ReactNode;
  icon?: ReactNode;
}

export interface LiquidMetalHeroProps {
  badge?: ReactNode;
  title: ReactNode;
  subtitle: ReactNode;
  primaryCtaLabel: string;
  primaryCtaHref?: string;
  onPrimaryCtaClick?: () => void;
  secondaryCtaLabel?: string;
  secondaryCtaHref?: string;
  onSecondaryCtaClick?: () => void;
  /** Small line under the calls to action. */
  note?: ReactNode;
  features?: readonly (string | LiquidMetalHeroFeature)[];
  /** id for the headline; the section is labelled by it. */
  titleId?: string;
  className?: string;
}

const lift = "motion-safe:hover:-translate-y-0.5";

const primaryCtaClass = buttonVariants({
  variant: "secondary",
  size: "lg",
  className: cn("h-14 px-8 text-lg", lift),
});

const secondaryCtaClass = buttonVariants({
  variant: "outline",
  size: "lg",
  className: cn(
    "h-14 border-white/25 bg-white/5 px-8 text-lg text-white backdrop-blur-sm hover:border-white/40 hover:bg-white/10 focus-visible:outline-white",
    lift,
  ),
});

function Cta({
  label,
  href,
  onClick,
  className,
}: {
  label: string;
  href?: string;
  onClick?: () => void;
  className: string;
}) {
  if (href) {
    return (
      <Link href={href} onClick={onClick} className={className}>
        {label}
      </Link>
    );
  }
  return (
    <button type="button" onClick={onClick} className={className}>
      {label}
    </button>
  );
}

// Stagger for the feature items, after the card itself (360ms).
const featureDelays = ["[animation-delay:440ms]", "[animation-delay:520ms]", "[animation-delay:600ms]"];

export function LiquidMetalHero({
  badge,
  title,
  subtitle,
  primaryCtaLabel,
  primaryCtaHref,
  onPrimaryCtaClick,
  secondaryCtaLabel,
  secondaryCtaHref,
  onSecondaryCtaClick,
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
          <Badge className="animate-fade-in-up bg-night/60 px-3 py-1 font-mono text-[0.6875rem] uppercase tracking-[0.12em] text-ink-100 ring-white/20 backdrop-blur-sm sm:text-xs sm:tracking-[0.18em]">
            {badge}
          </Badge>
        ) : null}

        <h1
          id={titleId}
          className="mx-auto mt-6 animate-rise-in text-balance font-display text-[clamp(2.25rem,8.5vw,5.75rem)] font-bold uppercase leading-[0.95] tracking-tight text-white"
        >
          {title}
        </h1>

        <p className="mx-auto mt-6 max-w-2xl animate-rise-in text-lg text-ink-100 [animation-delay:120ms] sm:text-xl">
          {subtitle}
        </p>

        <div className="mt-10 flex animate-fade-in-up flex-col items-stretch justify-center gap-3 [animation-delay:240ms] sm:flex-row sm:items-center">
          <Cta label={primaryCtaLabel} href={primaryCtaHref} onClick={onPrimaryCtaClick} className={primaryCtaClass} />
          {secondaryCtaLabel ? (
            <Cta
              label={secondaryCtaLabel}
              href={secondaryCtaHref}
              onClick={onSecondaryCtaClick}
              className={secondaryCtaClass}
            />
          ) : null}
        </div>

        {note ? (
          <p className="mt-4 animate-fade-in-up text-sm text-ink-300 [animation-delay:300ms]">{note}</p>
        ) : null}

        {items.length > 0 ? (
          <Card className="mx-auto mt-12 max-w-4xl animate-fade-in-up border-white/15 bg-night/75 shadow-sheen backdrop-blur-md [animation-delay:360ms] hover:border-white/15">
            <ul className="grid divide-y divide-white/10 sm:grid-cols-3 sm:divide-x sm:divide-y-0">
              {items.map((item, index) => (
                <li
                  key={index}
                  className={cn(
                    "flex animate-fade-in-up items-center gap-3 px-5 py-4 text-left sm:flex-col sm:justify-start sm:gap-3 sm:py-6 sm:text-center",
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
    </section>
  );
}
