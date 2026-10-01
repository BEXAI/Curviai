import type { Metadata } from "next";
import { pageMetadata } from "@/lib/seo";

export const metadata: Metadata = pageMetadata({
  title: "Privacy policy",
  description: "How Curvi handles your data and uploads.",
  path: "/privacy",
});

export default function PrivacyPage() {
  return (
    <div className="mx-auto max-w-3xl px-6 py-16">
      <h1 className="text-3xl font-bold tracking-tight text-ink-950">Privacy policy</h1>
      <p className="mt-2 text-sm text-ink-500">Last updated October 1, 2026</p>
      <div className="mt-8 space-y-6 text-sm leading-relaxed text-ink-700">
        <section>
          <h2 className="text-base font-semibold text-ink-950">What we collect</h2>
          <p className="mt-2">
            Your account email, the product photos and notes you upload, the outputs we generate for
            you, and usage records such as credits spent and job history. Payment details are handled
            by our payment processor and never stored by us. If you leave your email on one of our free
            tools, we keep that email and which tool you used, to follow up about Curvi.
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
            own data agreements. When you publish a share page for a pack, the images on it and the
            product title are public to anyone with the link, and to everyone if you also list it in
            the gallery. Share page images are served without their original photo metadata. You can
            take a share page down at any time.
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
          <h2 className="text-base font-semibold text-ink-950">Cookies and analytics</h2>
          <p className="mt-2">
            We use essential cookies to keep you signed in. We also use analytics cookies from PostHog
            to learn which pages help sellers, and the OpenAI Ads pixel to measure which ads bring
            sellers here, but only if you accept them in the cookie banner. If you decline, or have not
            chosen yet, neither of them loads and no analytics or advertising cookie is set. You can
            change your choice at any time from Cookie settings in the site footer.
          </p>
        </section>
        <section data-testid="privacy-visitor-count">
          <h2 className="text-base font-semibold text-ink-950">How we count visitors</h2>
          <p className="mt-2">
            We count visits to this site ourselves, without cookies and without storing anything on
            your device. When a page opens, your browser tells our server which page it was, any
            campaign tags in its link and, for the first page of a visit, which site sent you there.
            Our server mixes your IP address and browser details with a random code that changes every
            day and a secret key that is kept apart from our database. We keep only the scrambled
            result and whether the page was opened on a phone, tablet or computer. We never store your
            IP address or your full browser details. Each daily code is deleted once two days have
            passed, and copies in our database backups expire on the backup schedule. Without the daily
            code, the scrambled result cannot be traced back to an IP address or matched with a visit
            on another day. We use the count only to see how many people visit, never to identify
            anyone.
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
