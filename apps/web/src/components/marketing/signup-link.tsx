"use client";

import Link from "next/link";
import { useEffect, useState, type ComponentProps } from "react";
import { readLandingParams, withLandingParams } from "@/lib/attribution";
import { signupHref, type SignupHrefInput } from "@/lib/billing/intent";
import { AcquisitionCta } from "./acquisition-cta";

export type SignupLinkProps = Omit<ComponentProps<typeof Link>, "href"> &
  SignupHrefInput & {
    /** False keeps the link even while packs are paused (P18-03). */
    waitlistAware?: boolean;
  };

/**
 * The one signup link (docs/phases/PHASE_18.md P18-01). It renders
 * signupHref for its source and extras, and once in the browser adds the
 * current page's landing parameters (UTM tags, ref and the rest of
 * LANDING_PARAM_KEYS) that the link does not set itself, so attribution
 * travels to /signup without any storage. Static pages stay static: the
 * server renders the plain link.
 *
 * Every Start free link on the marketing site goes through this component
 * (Lane 1 sweeps the bare /signup links), so the acquisition gate (P18-03,
 * Lane 2) makes signup links waitlist aware here once instead of in every
 * page: while packs are paused the link becomes "Get notified when packs are
 * back" with the same look (AcquisitionCta).
 */
export function SignupLink({ plan, cadence, source, extra, waitlistAware = true, ...rest }: SignupLinkProps) {
  const base = signupHref({ plan, cadence, source, extra });
  const [href, setHref] = useState(base);
  useEffect(() => {
    setHref(withLandingParams(base, readLandingParams(window.location.href)));
  }, [base]);
  const link = <Link href={href} {...rest} />;
  if (!waitlistAware) {
    return link;
  }
  return <AcquisitionCta className={typeof rest.className === "string" ? rest.className : undefined}>{link}</AcquisitionCta>;
}
