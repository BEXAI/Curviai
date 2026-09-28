import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Privacy policy",
  description: "How Curvi handles your data and uploads.",
};

export default function PrivacyPage() {
  return (
    <div className="mx-auto max-w-3xl px-6 py-16">
      <h1 className="text-3xl font-bold tracking-tight text-ink-950">Privacy policy</h1>
      <p className="mt-2 text-sm text-ink-500">Last updated September 28, 2026</p>
      <div className="mt-8 space-y-6 text-sm leading-relaxed text-ink-700">
        <section>
          <h2 className="text-base font-semibold text-ink-950">What we collect</h2>
          <p className="mt-2">
            Your account email, the product photos and notes you upload, the outputs we generate for
            you, and usage records such as credits spent and job history. Payment details are handled
            by our payment processor and never stored by us.
          </p>
        </section>
        <section>
          <h2 className="text-base font-semibold text-ink-950">How we use it</h2>
          <p className="mt-2">
            To run the service: analyzing your photos, generating your packs, billing your plan and
            supporting your account. We send your photos to AI providers only to process your own
            requests, on API tiers that do not train on your inputs.
          </p>
        </section>
        <section>
          <h2 className="text-base font-semibold text-ink-950">Sharing</h2>
          <p className="mt-2">
            We do not sell your data. We share it only with the infrastructure providers that run the
            service, such as hosting, storage, authentication and AI processing, each bound by their
            own data agreements.
          </p>
        </section>
        <section>
          <h2 className="text-base font-semibold text-ink-950">Retention and deletion</h2>
          <p className="mt-2">
            Your uploads and outputs stay in your workspace while your account is active. Source media
            is deleted within thirty days after account closure. You can request deletion of your data
            at any time and we honor applicable privacy laws, including GDPR and CCPA requests.
          </p>
        </section>
        <section>
          <h2 className="text-base font-semibold text-ink-950">Contact</h2>
          <p className="mt-2">
            Privacy questions and requests go to{" "}
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
