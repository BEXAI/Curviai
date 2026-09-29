import type { Metadata } from "next";
import Link from "next/link";
import { Card, buttonVariants, cn } from "@curvi/ui";
import { JsonLd } from "@/components/json-ld";
import { BeforeAfterSlider } from "@/components/marketing/before-after-slider";
import { ComplianceBadgeDemo } from "@/components/marketing/compliance-badge-demo";
import { afterDemoImage, beforeDemoImage } from "@/components/marketing/demo-images";
import { EmailCapture } from "@/components/marketing/email-capture";
import {
  homeChannelTiles,
  homeChannels,
  homeClosing,
  homeClosingAlt,
  homeFaqAside,
  homeFaqs,
  homeFeaturesIntro,
  homeGuides,
  homeHero,
  homeHeroCtas,
  homeHeroFeatures,
  homeHeroNote,
  homeHowItWorks,
  homePack,
  homePricing,
  homeProof,
  homeReport,
  homeSteps,
  homeTools,
} from "@/components/marketing/home-copy";
import { FeatureIcon, FeatureTile, PackTile, SectionHeader, glassTile } from "@/components/marketing/home-parts";
import { pillarPages } from "@/components/marketing/pillar-copy";
import { specSlug } from "@/components/marketing/spec-slug";
import { LiquidMetalHero } from "@/components/ui/liquid-metal-hero";
import { isStripeConfigured } from "@/lib/env";
import {
  packsForCredits,
  paidTiers,
  tierDisplayName,
  typicalPackCredits,
  typicalPackLines,
} from "@/lib/marketing-facts";
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

const container = "mx-auto max-w-6xl px-6";
const sectionSpace = "py-16 sm:py-24";

/** Link tile on night: channels, guides and free tools. */
const linkTile =
  "group flex h-full flex-col rounded-2xl bg-white/[0.04] p-6 shadow-sheen ring-1 ring-inset ring-white/10 transition-[box-shadow,background-color] duration-200 hover:bg-white/[0.06] hover:ring-white/20 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white";

/**
 * The headline's wine line keeps a tight night halo, so it stays above 3:1
 * even where the metal shows through the scrim around it. The halo is static
 * text paint: no per frame cost over the shader. The lighter option still
 * open for the founder is one class away: text-wine-300.
 */
const headlineWine =
  "block text-wine-500 [text-shadow:0_0_0.15rem_var(--color-night),0_0_0.35rem_var(--color-night),0_0_0.75rem_var(--color-night),0_0_1.5rem_rgb(7_8_13/0.9)]";

export default function HomePage() {
  const paid = paidTiers();
  const lowest = paid[0];
  const highest = paid[paid.length - 1];
  const packCredits = typicalPackCredits();
  const packLines = typicalPackLines();

  return (
    // overflow-x-clip, not overflow-hidden: it clips the wide glow layers
    // without making this div a scroll container, which would stop the
    // .reveal view() timelines and the sticky FAQ aside from tracking the page.
    <div className="theme-base relative overflow-x-clip bg-night text-ink-100">
      <JsonLd
        data={jsonLdGraph([
          organizationJsonLd(),
          websiteJsonLd(),
          softwareApplicationJsonLd(),
          faqPageJsonLd(homeFaqs.map((faq) => ({ question: faq.q, answer: faq.a }))),
        ])}
      />

      {/* 1. Liquid metal hero: the brand moment, the SEO headline and the two main actions. */}
      <LiquidMetalHero
        titleId="home-hero-title"
        badge={homeHero.eyebrow}
        title={
          <>
            <span className="block">Shot once.</span>{" "}
            <span className={headlineWine}>Ready everywhere.</span>
          </>
        }
        subtitle={homeHero.lead}
        primaryCtaLabel={homeHeroCtas.primary.label}
        primaryCtaHref={homeHeroCtas.primary.href}
        secondaryCtaLabel={homeHeroCtas.secondary.label}
        secondaryCtaHref={homeHeroCtas.secondary.href}
        note={homeHeroNote}
        features={homeHeroFeatures.map((feature) => ({
          label: feature.label,
          icon: <FeatureIcon feature={feature.key} />,
        }))}
      />

      {/* Sections 2 to 4 share one glow layer, so there is no seam under the hero's fade. */}
      <div className="relative">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 bg-[radial-gradient(40rem_60rem_at_0%_36rem,rgb(45_212_191/0.12),transparent_70%),radial-gradient(56rem_36rem_at_100%_70rem,rgb(236_72_153/0.1),transparent_70%),radial-gradient(36rem_24rem_at_45%_110rem,rgb(139_92_246/0.07),transparent)]"
        />

        {/* 2. Before and after: the product promise in the first scroll. */}
        <section aria-labelledby="home-proof-title" className="relative">
          {/* Phones read the header, then the slider. On desktop the slider spans
              three rows and the header sits centered beside it. The hero above
              already carries both calls to action, so this section only proves
              the promise. The slider column holds body text, so it never fades. */}
          <div
            className={cn(
              container,
              sectionSpace,
              "grid grid-cols-1 gap-10 lg:grid-cols-12 lg:grid-rows-[1fr_auto_1fr] lg:gap-x-12 lg:gap-y-8",
            )}
          >
            <div className="min-w-0 lg:col-span-5 lg:col-start-8 lg:row-start-2">
              <SectionHeader
                id="home-proof-title"
                align="left"
                eyebrow={homeProof.eyebrow}
                title={homeProof.title}
                titleMuted={homeProof.titleMuted}
                lead={homeHero.proof}
              />
              <div className="mt-6 rounded-2xl bg-white/[0.04] p-5 ring-1 ring-inset ring-teal-400/25">
                <p className="font-display text-lg font-semibold text-white">{homeProof.differenceTitle}</p>
                <p className="mt-2 text-sm leading-relaxed text-ink-200">{homeProof.difference}</p>
              </div>
              <p className="mt-6 text-sm">
                <Link href="/gallery" className="font-medium text-teal-brand underline-offset-4 hover:underline">
                  {homeProof.galleryLink}
                </Link>
              </p>
            </div>
            <div className="min-w-0 lg:col-span-7 lg:col-start-1 lg:row-span-3 lg:row-start-1">
              <div className="rounded-3xl bg-white/[0.04] p-2 shadow-[0_2.5rem_7.5rem_-2.5rem_rgb(45_212_191/0.35)] ring-1 ring-inset ring-white/10">
                <BeforeAfterSlider beforeSrc={beforeDemoImage} afterSrc={afterDemoImage} />
              </div>
              <p className="mt-3 text-center font-mono text-xs text-ink-400">{homeHero.sliderCaption}</p>
              <FeatureTile featureKey="fidelity" className="mt-6" />
            </div>
          </div>
        </section>

        {/* 3. How it works: no prompts, three steps. */}
        <section aria-labelledby="home-how-title" className="relative">
          <div className={cn(container, sectionSpace)}>
            <SectionHeader
              id="home-how-title"
              title={homeHowItWorks.title}
              lead={homeFeaturesIntro}
            />
            <ol className="mt-14 grid gap-10 md:grid-cols-3 md:gap-8">
              {homeSteps.map((step, index) => (
                <li key={step.title} className="reveal flex gap-5 md:block">
                  <span
                    aria-hidden="true"
                    className="hidden h-px w-full bg-gradient-to-r from-teal-brand/50 via-white/10 to-transparent md:mb-6 md:block"
                  />
                  <span
                    aria-hidden="true"
                    className="w-20 shrink-0 font-display text-5xl font-bold leading-none text-transparent [-webkit-text-stroke:1px_rgb(45_212_191/0.7)] md:w-auto md:text-7xl"
                  >
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <div className="md:mt-5">
                    <h3 className="text-lg font-semibold text-white">{step.title}</h3>
                    <p className="mt-2 text-sm text-ink-300">{step.body}</p>
                  </div>
                </li>
              ))}
            </ol>
          </div>
        </section>

        {/* 4. What a pack contains: the files of the typical pack, from the estimate the new pack form uses. */}
        <section aria-labelledby="home-pack-title" className="relative">
          <div className={cn(container, sectionSpace)}>
            <SectionHeader
              id="home-pack-title"
              eyebrow={homePack.eyebrow}
              title={homePack.title}
              titleMuted={homePack.titleMuted}
              lead={homePack.intro}
            />
            <div className="mt-12 grid grid-flow-dense auto-rows-[minmax(10rem,auto)] grid-cols-2 gap-4 lg:grid-cols-4">
              {packLines.map((line) => (
                <PackTile key={line.label} line={line} className="reveal" />
              ))}
              <FeatureTile featureKey="brandKit" className="reveal col-span-2" />
              <div className="reveal col-span-2 flex items-center rounded-2xl bg-teal-brand/[0.06] p-6 ring-1 ring-inset ring-teal-brand/20">
                <p className="text-base font-medium text-white sm:text-lg">{homePack.summary}</p>
              </div>
            </div>
            <div className="mt-14">
              <p className="font-mono text-xs font-semibold uppercase tracking-[0.2em] text-ink-400">
                {homePack.onTheWay}
              </p>
              <div className="mt-4 grid gap-4 md:grid-cols-2">
                <FeatureTile featureKey="freshCreativeDrop" />
                <FeatureTile featureKey="directPublishing" />
              </div>
            </div>
          </div>
        </section>
      </div>

      {/* 5. Proof on every file: the compliance report. */}
      <section aria-labelledby="home-report-title" className="border-y border-white/10 bg-white/[0.02]">
        {/* grid-cols-1, not the implicit auto column: a track that grows to the
            example report's min-content width would overflow a phone. */}
        <div className={cn(container, sectionSpace, "grid grid-cols-1 gap-12 lg:grid-cols-12 lg:items-center")}>
          <div className="min-w-0 lg:col-span-5">
            <SectionHeader
              id="home-report-title"
              align="left"
              eyebrow={homeReport.eyebrow}
              title={homeReport.title}
              titleMuted={homeReport.titleMuted}
              lead={homeReport.lead}
            />
            <FeatureTile featureKey="compliance" className="mt-8" />
            <p className="mt-6 text-sm text-ink-300">{homeReport.note}</p>
          </div>
          <div className="min-w-0 lg:col-span-7">
            <div className="rounded-3xl bg-white/[0.04] p-3 shadow-[0_2.5rem_7.5rem_-2.5rem_rgb(45_212_191/0.3)] ring-1 ring-inset ring-white/10 sm:p-4">
              <ComplianceBadgeDemo />
            </div>
          </div>
        </div>
      </section>

      {/* 6. Channels, each linking to its requirements page. */}
      <section aria-labelledby="home-channels-title">
        <div className={cn(container, sectionSpace)}>
          <div className="grid grid-cols-1 gap-10 lg:grid-cols-12 lg:items-end">
            <SectionHeader
              id="home-channels-title"
              align="left"
              className="lg:col-span-7"
              title={homeChannels.title}
              titleMuted={homeChannels.titleMuted}
            />
            <FeatureTile featureKey="channels" body={homeChannels.tileBody} className="lg:col-span-5" />
          </div>
          {/* The first channel spans both columns on phones, so nine tiles fill five full rows. */}
          <ul className="mt-12 grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-3">
            {homeChannelTiles.map((tile, index) => (
              <li key={tile.name} className={cn("reveal", index === 0 ? "col-span-2 lg:col-span-1" : null)}>
                <Link
                  href={`/channels/${specSlug(tile.specId)}/image-requirements`}
                  className={cn(linkTile, "p-4 sm:p-6")}
                >
                  <span className="font-display text-lg font-bold text-white sm:text-xl">{tile.name}</span>
                  <span className="mt-2 flex-1 text-sm text-ink-400">{tile.files}</span>
                  <span className="mt-4 text-sm font-medium text-teal-brand underline-offset-4 group-hover:underline">
                    {homeChannels.linkLabel}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* 7. Pricing, from the seed tiers. */}
      <section aria-labelledby="home-pricing-title" className="border-y border-white/10 bg-white/[0.02]">
        <div className={cn(container, sectionSpace)}>
          <SectionHeader id="home-pricing-title" title={homePricing.title} />
          <p className="mx-auto mt-4 max-w-2xl text-center text-base text-ink-300 sm:text-lg" data-testid="home-pack-size">
            {lowest && highest ? `Plans from $${lowest.monthlyUsd} to $${highest.monthlyUsd} per month. ` : null}
            A typical listing pack of still images uses about {packCredits} credits.
          </p>
          {isStripeConfigured() ? null : (
            <p className="mx-auto mt-2 max-w-2xl text-center text-sm text-ink-400">
              Paid plans open soon. You can start on the free plan today.
            </p>
          )}
          <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-6">
            <Card
              className={cn(
                glassTile,
                "reveal flex flex-col p-8 ring-1 ring-inset ring-wine-700/60 sm:col-span-2 lg:col-span-2 lg:row-span-2",
              )}
            >
              <p className="font-mono text-xs font-semibold uppercase tracking-wider text-ink-400">
                {homePricing.freeTitle}
              </p>
              <p className="mt-4 text-base text-white">{homePricing.freeBody}</p>
              <p className="mt-2 text-sm text-ink-400">{homePricing.noCard}</p>
              <Link
                href={homeHeroCtas.primary.href}
                className={buttonVariants({ variant: "secondary", size: "lg", className: "mt-8 w-full lg:mt-auto" })}
              >
                {homeHeroCtas.primary.label}
              </Link>
            </Card>
            {paid.map((tier) => (
              <Card key={tier.key} className={cn(glassTile, "reveal p-6 lg:col-span-2")}>
                <p className="font-mono text-xs font-semibold uppercase tracking-wider text-ink-400">
                  {tierDisplayName(tier.key)}
                </p>
                <p className="mt-2 font-display text-4xl font-bold text-white">${tier.monthlyUsd}</p>
                <p className="mt-2 text-sm text-ink-300">
                  {tier.creditsPerMonth.toLocaleString("en-US")} credits per month
                </p>
                <p className="mt-1 text-xs text-ink-400">
                  About {packsForCredits(tier.creditsPerMonth).toLocaleString("en-US")} listing packs a month
                </p>
              </Card>
            ))}
          </div>
          <div className="mt-10 flex flex-col items-center gap-4 text-center">
            <p className="text-sm text-ink-400">{homePricing.unusedCredits}</p>
            <Link href="/pricing" className={buttonVariants({ variant: "glass", size: "lg" })}>
              {homePricing.fullPricing}
            </Link>
          </div>
        </div>
      </section>

      {/* 8. FAQ. The same questions feed the FAQPage JSON-LD above, in order. */}
      <section aria-labelledby="home-faq-title">
        <div className={cn(container, sectionSpace, "grid grid-cols-1 gap-10 lg:grid-cols-12")}>
          <div className="min-w-0 lg:col-span-4">
            <div className="lg:sticky lg:top-24">
              <SectionHeader
                id="home-faq-title"
                align="left"
                title={homeFaqAside.title}
                lead={homeFaqAside.body}
              />
              <Link
                href="/help"
                className="mt-4 inline-block text-sm font-medium text-teal-brand underline-offset-4 hover:underline"
              >
                {homeFaqAside.link}
              </Link>
            </div>
          </div>
          <div className="min-w-0 space-y-3 lg:col-span-8">
            {homeFaqs.map((faq) => (
              <details
                key={faq.q}
                className="group rounded-2xl bg-white/[0.04] p-5 ring-1 ring-inset ring-white/10 transition-shadow open:shadow-sheen open:ring-white/20"
              >
                <summary className="cursor-pointer list-none text-base font-semibold text-white marker:content-none">
                  <span className="flex items-center justify-between gap-4">
                    {faq.q}
                    <svg
                      className="size-4 shrink-0 text-teal-brand transition-transform group-open:rotate-180"
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

      {/* 9. Guides and free tools: internal links and a no signup way in. */}
      <section aria-labelledby="home-guides-title" className="border-t border-white/10">
        <div className={cn(container, sectionSpace)}>
          <SectionHeader id="home-guides-title" eyebrow={homeGuides.eyebrow} title={homeGuides.title} />
          <nav aria-label="Guides" className="mt-12">
            <ul className="grid gap-4 md:grid-cols-2">
              {pillarPages.map((guide) => (
                <li key={guide.path} className="reveal">
                  <Link href={guide.path} className={linkTile}>
                    <span className="text-lg font-semibold text-white">{guide.name}</span>
                    <span className="mt-2 flex-1 text-sm text-ink-300">{guide.description}</span>
                    <span className="mt-4 text-sm font-medium text-teal-brand underline-offset-4 group-hover:underline">
                      {homeGuides.readGuide}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
          <h3 className="mt-14 font-mono text-xs font-semibold uppercase tracking-[0.2em] text-ink-400">
            {homeGuides.toolsTitle}
          </h3>
          <ul className="mt-4 grid gap-4 md:grid-cols-3">
            {homeTools.map((tool) => (
              <li key={tool.href} className="reveal">
                <Link href={tool.href} className={cn(linkTile, "p-5")}>
                  <span className="text-base font-semibold text-white">{tool.name}</span>
                  <span className="mt-2 text-sm text-ink-300">{tool.body}</span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* 10. Closing call to action, bookended by the static CSS metal (no second
          WebGL context). The metal shows at the edges; a pool of night sits
          behind the text so it keeps its contrast. */}
      <section aria-labelledby="home-closing-title" className="relative isolate overflow-hidden border-t border-white/10">
        <div aria-hidden="true" className="hero-metal-fallback absolute inset-0 -z-10" />
        <div aria-hidden="true" className="closing-metal-scrim absolute inset-0 -z-10" />
        <div className="reveal mx-auto max-w-3xl px-6 py-24 text-center sm:py-32">
          <h2
            id="home-closing-title"
            className="text-balance font-display text-3xl font-bold uppercase tracking-tight text-white sm:text-4xl lg:text-5xl"
          >
            {homeClosing.title}
          </h2>
          <p className="mx-auto mt-4 max-w-xl text-base text-ink-300 sm:text-lg">{homeClosing.body}</p>
          <div className="mt-8">
            <EmailCapture />
          </div>
          <p className="mt-6 text-sm text-ink-400">
            {homeClosingAlt.before}{" "}
            <Link href={homeHeroCtas.secondary.href} className="font-medium text-ink-200 underline hover:text-white">
              {homeClosingAlt.link}
            </Link>
            {homeClosingAlt.after}
          </p>
        </div>
      </section>
    </div>
  );
}
