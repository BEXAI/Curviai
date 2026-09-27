import type { Metadata } from "next";
import Link from "next/link";
import { Badge, Card, CardContent, CardHeader, CardTitle, buttonVariants } from "@curvi/ui";
import { BeforeAfterSlider } from "@/components/marketing/before-after-slider";
import { ComplianceBadgeDemo } from "@/components/marketing/compliance-badge-demo";
import { afterDemoImage, beforeDemoImage } from "@/components/marketing/demo-images";
import { EmailCapture } from "@/components/marketing/email-capture";
import { UploadBox } from "@/components/marketing/upload-box";

export const metadata: Metadata = {
  title: "Curvi. Shot once. Ready everywhere.",
  description:
    "Studio product photos and videos for every marketplace, from one photo, without changing your product.",
};

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

const faqs = [
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
  },
  {
    q: "How do credits work?",
    a: "Simple deterministic assets cost half a credit. A generative still costs one credit, video costs more. A typical full pack uses about 40 to 60 credits, and plans start at 200 credits for $29 per month.",
  },
  {
    q: "What if a file fails a marketplace check?",
    a: "It does not leave the pipeline. Curvi measures every output against the channel spec and regenerates or fixes it before you ever see it. The report shows the measured numbers.",
  },
  {
    q: "Can I try it without a card?",
    a: "Yes. The free plan includes 15 credits once, enough for a compliant main image, two lifestyle shots and a share page. The free tools on this site need no account at all.",
  },
];

export default function HomePage() {
  return (
    <div>
      <section className="relative overflow-hidden">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 bg-[radial-gradient(60rem_32rem_at_70%_-20%,rgb(253_127_17/0.08),transparent)]"
        />
        <div className="relative mx-auto grid max-w-6xl items-center gap-12 px-6 pb-20 pt-16 lg:grid-cols-2 lg:pt-24">
        <div className="animate-fade-in-up">
          <Badge variant="outline" className="mb-5">
            Built for marketplace sellers
          </Badge>
          <h1 className="font-display text-4xl font-bold tracking-tight text-ink-950 sm:text-5xl">
            Shot once. Ready everywhere.
          </h1>
          <p className="mt-4 text-lg text-ink-600">
            Studio product photos and videos for every marketplace, from one photo, without changing
            your product.
          </p>
          <p className="mt-3 text-base font-medium text-ink-800">
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
          <p className="mt-2 text-center text-xs text-ink-400">
            Drag the divider. Same bottle, same label, new everything else.
          </p>
        </div>
        </div>
      </section>

      <section className="border-y border-ink-100 bg-ink-50">
        <div className="mx-auto max-w-6xl px-6 py-16">
          <h2 className="text-center font-display text-3xl font-bold tracking-tight text-ink-950">How it works</h2>
          <div className="mt-10 grid gap-8 md:grid-cols-3">
            {steps.map((step, index) => (
              <div key={step.title} className="rounded-xl bg-white p-6 shadow-sm">
                <span className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-accent-500 text-sm font-bold text-white">
                  {index + 1}
                </span>
                <h3 className="mt-4 text-lg font-semibold text-ink-950">{step.title}</h3>
                <p className="mt-2 text-sm text-ink-600">{step.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-6 py-16">
        <h2 className="text-center font-display text-3xl font-bold tracking-tight text-ink-950">
          Everything a listing needs, nothing you have to prompt
        </h2>
        <p className="mx-auto mt-3 max-w-2xl text-center text-ink-600">
          No prompts anywhere. Upload, review, publish.
        </p>
        <div className="mt-10 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {features.map((feature) => (
            <Card key={feature.title} className="transition-shadow hover:shadow-raised">
              <CardHeader>
                <span className="mb-1 inline-flex size-9 items-center justify-center rounded-lg bg-accent-500/10 text-accent-600">
                  <svg viewBox="0 0 20 20" fill="none" className="size-5" aria-hidden="true">
                    {feature.icon}
                  </svg>
                </span>
                <CardTitle className="text-base">{feature.title}</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-ink-600">{feature.body}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      </section>

      <section className="border-y border-ink-100 bg-ink-50">
        <div className="mx-auto max-w-6xl px-6 py-16">
          <h2 className="text-center font-display text-3xl font-bold tracking-tight text-ink-950">
            Proof on every file, not promises
          </h2>
          <p className="mx-auto mt-3 max-w-2xl text-center text-ink-600">
            When the badge turns green it is because the pixels were measured. Here is the report a
            main image ships with.
          </p>
          <div className="mt-10">
            <ComplianceBadgeDemo />
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-6 py-16">
        <h2 className="text-center font-display text-3xl font-bold tracking-tight text-ink-950">Simple credit pricing</h2>
        <p className="mx-auto mt-3 max-w-2xl text-center text-ink-600">
          Plans from $29 to $349 per month. A typical full pack uses about 40 to 60 credits.
        </p>
        <div className="mt-10 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
          {[
            { name: "Starter", price: "$29", credits: "200 credits" },
            { name: "Growth", price: "$79", credits: "600 credits" },
            { name: "Pro", price: "$149", credits: "1,300 credits" },
            { name: "Agency", price: "$349", credits: "3,500 credits" },
          ].map((tier) => (
            <div key={tier.name} className="rounded-xl border border-ink-100 p-6 text-center">
              <p className="text-sm font-semibold text-ink-500">{tier.name}</p>
              <p className="mt-2 text-3xl font-bold text-ink-950">{tier.price}</p>
              <p className="mt-1 text-sm text-ink-600">{tier.credits} per month</p>
            </div>
          ))}
        </div>
        <div className="mt-8 text-center">
          <Link href="/pricing" className={buttonVariants({ size: "lg" })}>
            See full pricing
          </Link>
        </div>
      </section>

      <section className="border-t border-ink-100">
        <div className="mx-auto max-w-3xl px-6 py-16">
          <h2 className="text-center font-display text-3xl font-bold tracking-tight text-ink-950">Questions, answered</h2>
          <div className="mt-8 space-y-3">
            {faqs.map((faq) => (
              <details key={faq.q} className="group rounded-xl border border-ink-100 bg-white p-5 open:shadow-sm">
                <summary className="cursor-pointer list-none text-sm font-semibold text-ink-900 marker:content-none">
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
                <p className="mt-3 text-sm text-ink-600">{faq.a}</p>
              </details>
            ))}
          </div>
        </div>
      </section>

      <section className="bg-ink-950">
        <div className="mx-auto max-w-3xl px-6 py-16 text-center">
          <h2 className="font-display text-3xl font-bold tracking-tight text-white">
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
