import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle, buttonVariants } from "@curvi/ui";
import { JsonLd } from "@/components/json-ld";
import { BeforeAfterSlider } from "@/components/marketing/before-after-slider";
import { ComingSoonBadge } from "@/components/marketing/coming-soon-badge";
import { ComplianceBadgeDemo } from "@/components/marketing/compliance-badge-demo";
import { afterDemoImage, beforeDemoImage } from "@/components/marketing/demo-images";
import { EmailCapture } from "@/components/marketing/email-capture";
import {
  homeClosing,
  homeFaqs,
  homeFeatures,
  homeFeaturesIntro,
  homeHero,
  homeSteps,
  type HomeFeatureKey,
} from "@/components/marketing/home-copy";
import { UploadBox } from "@/components/marketing/upload-box";
import { Wordmark } from "@/components/marketing/site-header";
import { isStripeConfigured } from "@/lib/env";
import { freeCredits, packsForCredits, paidTiers, tierDisplayName, typicalPackCredits } from "@/lib/marketing-facts";
import {
  SITE_DESCRIPTION,
  SITE_TITLE,
  faqPageJsonLd,
  jsonLdGraph,
  organizationJsonLd,
  pageMetadata,
  softwareApplicationJsonLd,
  websiteJsonLd,
} from "@/lib/seo";

export const metadata: Metadata = pageMetadata({
  title: SITE_TITLE,
  absoluteTitle: true,
  description: SITE_DESCRIPTION,
  path: "/",
});

const featureIcons: Record<HomeFeatureKey, ReactNode> = {
  fidelity: (
    <>
      <rect x="5" y="9" width="10" height="7.5" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M7.5 9V6.5a2.5 2.5 0 0 1 5 0V9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </>
  ),
  compliance: (
    <>
      <circle cx="10" cy="10" r="6.75" stroke="currentColor" strokeWidth="1.5" />
      <path d="m7 10 2 2 4-4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),
  channels: (
    <>
      <rect x="3.5" y="3.5" width="5.5" height="5.5" rx="1" stroke="currentColor" strokeWidth="1.5" />
      <rect x="11" y="3.5" width="5.5" height="5.5" rx="1" stroke="currentColor" strokeWidth="1.5" />
      <rect x="3.5" y="11" width="5.5" height="5.5" rx="1" stroke="currentColor" strokeWidth="1.5" />
      <rect x="11" y="11" width="5.5" height="5.5" rx="1" stroke="currentColor" strokeWidth="1.5" />
    </>
  ),
  brandKit: (
    <>
      <circle cx="7.25" cy="8" r="3.5" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="12.75" cy="8" r="3.5" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="10" cy="12.75" r="3.5" stroke="currentColor" strokeWidth="1.5" />
    </>
  ),
  freshCreativeDrop: (
    <>
      <rect x="3.75" y="5" width="12.5" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M3.75 8.5h12.5M7.5 3.25v3M12.5 3.25v3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </>
  ),
  directPublishing: (
    <>
      <path d="M10 13V4.5M6.5 8 10 4.5 13.5 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M4.5 15.75h11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </>
  ),
};

export default function HomePage() {
  const paid = paidTiers();
  const lowest = paid[0];
  const highest = paid[paid.length - 1];
  const packCredits = typicalPackCredits();
  const liveFeatures = homeFeatures.filter((feature) => feature.status === "live");
  const soonFeatures = homeFeatures.filter((feature) => feature.status === "coming_soon");

  return (
    <div className="theme-base bg-night text-ink-100">
      <JsonLd
        data={jsonLdGraph([
          organizationJsonLd(),
          websiteJsonLd(),
          softwareApplicationJsonLd(),
          faqPageJsonLd(homeFaqs.map((faq) => ({ question: faq.q, answer: faq.a }))),
        ])}
      />
      <section className="relative overflow-hidden">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 bg-[radial-gradient(64rem_36rem_at_75%_-20%,rgb(236_72_153/0.2),transparent),radial-gradient(44rem_28rem_at_0%_100%,rgb(45_212_191/0.14),transparent),radial-gradient(36rem_24rem_at_45%_40%,rgb(139_92_246/0.08),transparent)]"
        />
        <div className="relative mx-auto grid max-w-6xl items-center gap-12 px-6 pb-20 pt-16 lg:grid-cols-2 lg:pt-24">
        <div className="animate-fade-in-up">
          <Wordmark className="mb-8 block h-14 sm:h-16" />
          <p className="mb-5 font-mono text-xs font-semibold uppercase tracking-wider text-accent-400">
            {homeHero.eyebrow}
          </p>
          <h1 className="font-display text-4xl font-bold uppercase leading-tight tracking-tight text-white sm:text-5xl">
            Shot once. <span className="block text-[#b03a5b]">Ready everywhere.</span>
          </h1>
          <p className="mt-4 text-lg text-ink-300">{homeHero.lead}</p>
          <p className="mt-3 text-base font-medium text-ink-200">{homeHero.proof}</p>
          <div className="mt-8">
            <UploadBox freeCredits={freeCredits()} />
          </div>
        </div>
        <div className="animate-fade-in-up [animation-delay:120ms]">
          <BeforeAfterSlider beforeSrc={beforeDemoImage} afterSrc={afterDemoImage} />
          <p className="mt-2 text-center font-mono text-xs text-ink-500">{homeHero.sliderCaption}</p>
        </div>
        </div>
      </section>

      <section className="border-y border-white/10 bg-white/[0.02]">
        <div className="mx-auto max-w-6xl px-6 py-16">
          <h2 className="text-center font-display text-3xl font-bold uppercase tracking-tight text-white">How it works</h2>
          <div className="mt-10 grid gap-8 md:grid-cols-3">
            {homeSteps.map((step, index) => (
              <div key={step.title} className="rounded-xl bg-white/5 p-6 shadow-sheen ring-1 ring-inset ring-white/10">
                <span className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-accent-500/15 font-mono text-sm font-bold text-accent-400">
                  {index + 1}
                </span>
                <h3 className="mt-4 text-lg font-semibold text-white">{step.title}</h3>
                <p className="mt-2 text-sm text-ink-300">{step.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-6 py-16">
        <h2 className="text-center font-display text-3xl font-bold uppercase tracking-tight text-white">
          Everything a listing needs, nothing you have to prompt
        </h2>
        <p className="mx-auto mt-3 max-w-2xl text-center text-ink-300">{homeFeaturesIntro}</p>
        <div className="mt-10 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {[...liveFeatures, ...soonFeatures].map((feature) => (
            <Card
              key={feature.key}
              data-testid={`feature-${feature.key}`}
              className="border-white/10 bg-white/5 shadow-sheen transition-colors hover:bg-white/[0.08]"
            >
              <CardHeader>
                <span className="mb-1 inline-flex size-9 items-center justify-center rounded-lg bg-accent-500/15 text-accent-400">
                  <svg viewBox="0 0 20 20" fill="none" className="size-5" aria-hidden="true">
                    {featureIcons[feature.key]}
                  </svg>
                </span>
                <div className="flex flex-wrap items-center gap-2">
                  <CardTitle className="text-base text-white">{feature.title}</CardTitle>
                  {feature.status === "coming_soon" ? <ComingSoonBadge tone="dark" /> : null}
                </div>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-ink-300">{feature.body}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      </section>

      <section className="border-y border-white/10 bg-white/[0.02]">
        <div className="mx-auto max-w-6xl px-6 py-16">
          <h2 className="text-center font-display text-3xl font-bold uppercase tracking-tight text-white">
            Proof on every file, not promises
          </h2>
          <p className="mx-auto mt-3 max-w-2xl text-center text-ink-300">
            When the badge turns green it is because the pixels were measured. Here is an example of
            the report a main image ships with.
          </p>
          <div className="mt-10">
            <ComplianceBadgeDemo />
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-6 py-16">
        <h2 className="text-center font-display text-3xl font-bold uppercase tracking-tight text-white">Simple credit pricing</h2>
        <p className="mx-auto mt-3 max-w-2xl text-center text-ink-300" data-testid="home-pack-size">
          {lowest && highest ? `Plans from $${lowest.monthlyUsd} to $${highest.monthlyUsd} per month. ` : null}
          A typical listing pack of still images uses about {packCredits} credits.
        </p>
        {isStripeConfigured() ? null : (
          <p className="mx-auto mt-2 max-w-2xl text-center text-sm text-ink-400">
            Paid plans open soon. You can start on the free plan today.
          </p>
        )}
        <div className="mt-10 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
          {paid.map((tier) => (
            <div
              key={tier.key}
              className="rounded-xl bg-white/5 p-6 text-center shadow-sheen ring-1 ring-inset ring-white/10"
            >
              <p className="font-mono text-xs font-semibold uppercase tracking-wider text-ink-400">
                {tierDisplayName(tier.key)}
              </p>
              <p className="mt-2 text-3xl font-bold text-white">${tier.monthlyUsd}</p>
              <p className="mt-1 text-sm text-ink-300">
                {tier.creditsPerMonth.toLocaleString("en-US")} credits per month
              </p>
              <p className="mt-1 text-xs text-ink-400">
                About {packsForCredits(tier.creditsPerMonth).toLocaleString("en-US")} listing packs a month
              </p>
            </div>
          ))}
        </div>
        <div className="mt-8 text-center">
          <Link href="/pricing" className={buttonVariants({ variant: "secondary", size: "lg" })}>
            See full pricing
          </Link>
        </div>
      </section>

      <section className="border-t border-white/10">
        <div className="mx-auto max-w-3xl px-6 py-16">
          <h2 className="text-center font-display text-3xl font-bold uppercase tracking-tight text-white">Questions, answered</h2>
          <div className="mt-8 space-y-3">
            {homeFaqs.map((faq) => (
              <details
                key={faq.q}
                className="group rounded-xl bg-white/5 p-5 ring-1 ring-inset ring-white/10 open:shadow-sheen"
              >
                <summary className="cursor-pointer list-none text-sm font-semibold text-white marker:content-none">
                  <span className="flex items-center justify-between gap-4">
                    {faq.q}
                    <svg
                      className="h-4 w-4 shrink-0 text-ink-400 transition-transform group-open:rotate-180"
                      viewBox="0 0 16 16"
                      fill="none"
                      aria-hidden="true"
                    >
                      <path d="M4 6.5 8 10.5 12 6.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </span>
                </summary>
                <p className="mt-3 text-sm text-ink-300">{faq.a}</p>
              </details>
            ))}
          </div>
        </div>
      </section>

      <section className="relative overflow-hidden border-t border-white/10">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 bg-[radial-gradient(48rem_24rem_at_50%_120%,rgb(236_72_153/0.16),transparent),radial-gradient(40rem_20rem_at_20%_120%,rgb(45_212_191/0.12),transparent)]"
        />
        <div className="relative mx-auto max-w-3xl px-6 py-16 text-center">
          <Wordmark className="mx-auto mb-6 block h-12" />
          <h2 className="font-display text-3xl font-bold uppercase tracking-tight text-white">{homeClosing.title}</h2>
          <p className="mx-auto mt-3 max-w-xl text-ink-300">{homeClosing.body}</p>
          <div className="mt-8">
            <EmailCapture />
          </div>
        </div>
      </section>
    </div>
  );
}
