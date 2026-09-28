import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Terms of service",
  description: "The terms that govern your use of Curvi.",
};

export default function TermsPage() {
  return (
    <div className="mx-auto max-w-3xl px-6 py-16">
      <h1 className="text-3xl font-bold tracking-tight text-ink-950">Terms of service</h1>
      <p className="mt-2 text-sm text-ink-500">Last updated September 28, 2026</p>
      <div className="mt-8 space-y-6 text-sm leading-relaxed text-ink-700">
        <section>
          <h2 className="text-base font-semibold text-ink-950">The service</h2>
          <p className="mt-2">
            Curvi turns your product photos into marketplace ready image and video packs. You get the
            outputs your plan covers, measured against each channel&apos;s published rules at the time of
            generation. Marketplaces change their rules, so always confirm current policies before
            publishing.
          </p>
        </section>
        <section>
          <h2 className="text-base font-semibold text-ink-950">Your content</h2>
          <p className="mt-2">
            You keep all rights to the photos you upload and the outputs Curvi generates for you. You
            confirm you have the rights to the material you upload. You may not upload content that is
            unlawful, infringes someone else&apos;s rights, or depicts real people without their permission.
          </p>
        </section>
        <section>
          <h2 className="text-base font-semibold text-ink-950">Credits and billing</h2>
          <p className="mt-2">
            Plans include a monthly credit allowance. Credits are consumed when an output passes
            quality checks. Failed outputs are not charged. Unused monthly credits follow the rollover
            policy shown on the pricing page. Fees are billed in advance and are non refundable except
            where the law requires otherwise.
          </p>
        </section>
        <section>
          <h2 className="text-base font-semibold text-ink-950">Acceptable use</h2>
          <p className="mt-2">
            Do not use Curvi to create misleading listings, counterfeit goods imagery, or content that
            violates a marketplace&apos;s policies. We may suspend accounts that do.
          </p>
        </section>
        <section>
          <h2 className="text-base font-semibold text-ink-950">Warranty and liability</h2>
          <p className="mt-2">
            Curvi is provided as is. We do not guarantee that any marketplace will accept a given
            image. To the maximum extent the law allows, our liability is limited to the amount you
            paid us in the twelve months before the claim.
          </p>
        </section>
        <section>
          <h2 className="text-base font-semibold text-ink-950">Changes and contact</h2>
          <p className="mt-2">
            We may update these terms and will note the date above when we do. Questions go to{" "}
            <a href="mailto:hello@curvi.ai" className="font-medium text-ink-900 underline">
              hello@curvi.ai
            </a>
            .
          </p>
        </section>
      </div>
    </div>
  );
}
