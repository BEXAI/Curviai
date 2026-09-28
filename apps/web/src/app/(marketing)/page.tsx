import type { Metadata } from "next";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle, buttonVariants } from "@curvi/ui";
import { creditCosts, tierByKey, tiers } from "@curvi/pipeline/seed";
import { JsonLd } from "@/components/json-ld";
import { BeforeAfterSlider } from "@/components/marketing/before-after-slider";
import { ComplianceBadgeDemo } from "@/components/marketing/compliance-badge-demo";
import { afterDemoImage, beforeDemoImage } from "@/components/marketing/demo-images";
import { EmailCapture } from "@/components/marketing/email-capture";
import { UploadBox } from "@/components/marketing/upload-box";
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

const steps = [
  {
    title: "Upload one photo",
    body: "A phone photo of your product is enough. Curvi masks the product so its pixels are locked before anything else happens.",
  },
  {
    title: "Curvi builds the pack",
    body: "Compliant main image, lifestyle scenes, channel crops and video render on a live progress board. Every file is measured against the channel rules.",
  },
  {
    title: "Download or publish",
    body: "Files come correctly sized and named per channel, with a compliance report on each. Publish straight to Shopify or download the pack.",
  },
];

const features = [
  {
    title: "Fidelity lock",
    body: "Your real product pixels are never regenerated. Labels, logos and textures in the output match your photo exactly.",
    icon: (
      <>
        <rect x="5" y="9" width="10" height="7.5" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
        <path d="M7.5 9V6.5a2.5 2.5 0 0 1 5 0V9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </>
    ),
  },
  {
    title: "Compliance report",
    body: "Every file ships with measured checks: background value, fill percent, resolution and text policy per channel.",
    icon: (
      <>
        <circle cx="10" cy="10" r="6.75" stroke="currentColor" strokeWidth="1.5" />
        <path d="m7 10 2 2 4-4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </>
    ),
  },
  {
    title: "Every channel",
    body: "Amazon, Shopify, Google, Walmart, Etsy, eBay, TikTok Shop, Meta and Pinterest, each at the right size with the right file name.",
    icon: (
      <>
        <rect x="3.5" y="3.5" width="5.5" height="5.5" rx="1" stroke="currentColor" strokeWidth="1.5" />
        <rect x="11" y="3.5" width="5.5" height="5.5" rx="1" stroke="currentColor" strokeWidth="1.5" />
        <rect x="3.5" y="11" width="5.5" height="5.5" rx="1" stroke="currentColor" strokeWidth="1.5" />
        <rect x="11" y="11" width="5.5" height="5.5" rx="1" stroke="currentColor" strokeWidth="1.5" />
      </>
    ),
  },
  {
    title: "Brand kit",
    body: "Colors, fonts and scene styles saved once, applied to every pack, so your catalog looks like one brand.",
    icon: (
      <>
        <circle cx="7.25" cy="8" r="3.5" stroke="currentColor" strokeWidth="1.5" />
        <circle cx="12.75" cy="8" r="3.5" stroke="currentColor" strokeWidth="1.5" />
        <circle cx="10" cy="12.75" r="3.5" stroke="currentColor" strokeWidth="1.5" />
      </>
    ),
  },
  {
    title: "Fresh Creative Drop",
    body: "Every Monday, new seasonal and ad variants for your top products land in your library, ready to approve.",
    icon: (
      <>
        <rect x="3.75" y="5" width="12.5" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
        <path d="M3.75 8.5h12.5M7.5 3.25v3M12.5 3.25v3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </>
    ),
  },
  {
    title: "Direct publishing",
    body: "Push approved images straight to Shopify, and export packs organized for Seller Central uploads.",
    icon: (
      <>
        <path d="M10 13V4.5M6.5 8 10 4.5 13.5 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M4.5 15.75h11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </>
    ),
  },
];

// Answers marked structured: false mention features that do not ship yet
// (video, share pages, paid checkout), so they stay out of the FAQPage JSON-LD
// that answer engines quote. Remove the flag once the feature is live.
const faqs: { q: string; a: string; structured?: false }[] = [
  {
    q: "Does the AI change my product?",
    a: "No. Curvi masks your product first and only rebuilds what is around it, backgrounds, lighting and scenes. Product pixels inside the mask are never regenerated, which is why labels never warp.",
  },
  {
    q: "What do I need to start?",
    a: "One photo per product. A phone photo on a table works. Higher resolution photos give the pack more room for large formats.",
  },
  {
    q: "Which channels are covered?",
    a: "Amazon main and secondary images, A plus modules, Shopify product and banner sizes, Google Merchant, Walmart, Etsy, eBay, TikTok Shop, Meta feed and story, Pinterest, plus listing and social video formats.",
    structured: false,
  },
  {
    q: "How do credits work?",
    a: `Simple deterministic assets cost half a credit. A generative still costs ${creditCosts.generativeStill} credit, video costs more. A typical full pack uses about 40 to 60 credits, and plans start at ${tierByKey("starter").creditsPerMonth} credits for $${tierByKey("starter").monthlyUsd} per month.`,
    structured: false,
  },
  {
    q: "What if a file fails a marketplace check?",
    a: "It does not leave the pipeline. Curvi measures every output against the channel spec and regenerates or fixes it before you ever see it. The report shows the measured numbers.",
  },
  {
    q: "Can I try it without a card?",
    a: "Yes. The free plan includes 15 credits once, enough for a compliant main image, two lifestyle shots and a share page. The free tools on this site need no account at all.",
    structured: false,
  },
];

export default function HomePage() {
  return (
    <div className="bg-night text-ink-100">
      <JsonLd
        data={jsonLdGraph([
          organizationJsonLd(),
          websiteJsonLd(),
          softwareApplicationJsonLd(),
          faqPageJsonLd(
            faqs.filter((faq) => faq.structured !== false).map((faq) => ({ question: faq.q, answer: faq.a })),
          ),
        ])}
      />
      <section className="relative overflow-hidden">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 bg-[radial-gradient(64rem_36rem_at_70%_-20%,rgb(253_127_17/0.16),transparent),radial-gradient(40rem_24rem_at_10%_110%,rgb(253_127_17/0.07),transparent)]"
        />
        <div className="relative mx-auto grid max-w-6xl items-center gap-12 px-6 pb-20 pt-16 lg:grid-cols-2 lg:pt-24">
        <div className="animate-fade-in-up">
          <p className="mb-5 font-mono text-xs font-semibold uppercase tracking-wider text-accent-400">
            Built for marketplace sellers
          </p>
          <h1 className="font-display text-4xl font-bold uppercase leading-tight tracking-tight text-white sm:text-5xl">
            Shot once. <span className="block text-accent-400">Ready everywhere.</span>
          </h1>
          <p className="mt-4 text-lg text-ink-300">
            Studio product photos and videos for every marketplace, from one photo, without changing
            your product.
          </p>
          <p className="mt-3 text-base font-medium text-ink-200">
            The pack that passes Amazon, Google and Shopify the first time. We keep your real product
            pixels, so labels never warp.
          </p>
          <div className="mt-8">
            <UploadBox />
          </div>
        </div>
        <div className="animate-fade-in-up [animation-delay:120ms]">
          <BeforeAfterSlider
            beforeSrc={beforeDemoImage}
            afterSrc={afterDemoImage}
            beforeLabel="Your photo"
            afterLabel="Curvi output"
          />
          <p className="mt-2 text-center font-mono text-xs text-ink-500">
            Drag the divider. Same bottle, same label, new everything else.
          </p>
        </div>
        </div>
      </section>

      <section className="border-y border-white/10 bg-white/[0.02]">
        <div className="mx-auto max-w-6xl px-6 py-16">
          <h2 className="text-center font-display text-3xl font-bold uppercase tracking-tight text-white">How it works</h2>
          <div className="mt-10 grid gap-8 md:grid-cols-3">
            {steps.map((step, index) => (
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
        <p className="mx-auto mt-3 max-w-2xl text-center text-ink-300">
          No prompts anywhere. Upload, review, publish.
        </p>
        <div className="mt-10 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {features.map((feature) => (
            <Card
              key={feature.title}
              className="border-white/10 bg-white/5 shadow-sheen transition-colors hover:bg-white/[0.08]"
            >
              <CardHeader>
                <span className="mb-1 inline-flex size-9 items-center justify-center rounded-lg bg-accent-500/15 text-accent-400">
                  <svg viewBox="0 0 20 20" fill="none" className="size-5" aria-hidden="true">
                    {feature.icon}
                  </svg>
                </span>
                <CardTitle className="text-base text-white">{feature.title}</CardTitle>
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
            When the badge turns green it is because the pixels were measured. Here is the report a
            main image ships with.
          </p>
          <div className="mt-10">
            <ComplianceBadgeDemo />
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-6 py-16">
        <h2 className="text-center font-display text-3xl font-bold uppercase tracking-tight text-white">Simple credit pricing</h2>
        <p className="mx-auto mt-3 max-w-2xl text-center text-ink-300">
          Plans from ${tierByKey("starter").monthlyUsd} to ${tierByKey("agency").monthlyUsd} per month. A
          typical full pack uses about 40 to 60 credits.
        </p>
        <div className="mt-10 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
          {tiers
            .filter((t) => t.key !== "free")
            .map((t) => ({
              name: t.key.charAt(0).toUpperCase() + t.key.slice(1),
              price: `$${t.monthlyUsd}`,
              credits: `${t.creditsPerMonth.toLocaleString("en-US")} credits`,
            }))
            .map((tier) => (
            <div
              key={tier.name}
              className="rounded-xl bg-white/5 p-6 text-center shadow-sheen ring-1 ring-inset ring-white/10"
            >
              <p className="font-mono text-xs font-semibold uppercase tracking-wider text-ink-400">{tier.name}</p>
              <p className="mt-2 text-3xl font-bold text-white">{tier.price}</p>
              <p className="mt-1 text-sm text-ink-300">{tier.credits} per month</p>
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
            {faqs.map((faq) => (
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
          className="pointer-events-none absolute inset-0 bg-[radial-gradient(48rem_24rem_at_50%_120%,rgb(253_127_17/0.14),transparent)]"
        />
        <div className="relative mx-auto max-w-3xl px-6 py-16 text-center">
          <h2 className="font-display text-3xl font-bold uppercase tracking-tight text-white">
            Your next pack is one photo away
          </h2>
          <p className="mx-auto mt-3 max-w-xl text-ink-300">
            Start free with 15 credits. Get a compliant main image, two lifestyle shots and a share
            page for your first product.
          </p>
          <div className="mt-8">
            <EmailCapture />
          </div>
        </div>
      </section>
    </div>
  );
}
