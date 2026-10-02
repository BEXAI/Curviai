import type { Metadata } from "next";
import Link from "next/link";
import { LegalHeader, LegalLineText, LegalSection, MailLink } from "@/components/marketing/legal-parts";
import { entitySentence, replySentence } from "@/lib/legal/copy";
import { LEGAL_FACTS } from "@/lib/legal/facts";
import { RETENTION_RIGHTS, retentionRows } from "@/lib/legal/retention";
import { subprocessorsInUse } from "@/lib/legal/subprocessors";
import { joinList } from "@/lib/marketing-facts";
import { pageMetadata } from "@/lib/seo";
import { assistantPrivacy, collectAssistants, sharingAssistants } from "./privacy-copy";

export const metadata: Metadata = pageMetadata({
  title: "Privacy policy",
  description: "How Curvi handles your data and uploads.",
  path: "/privacy",
});

// Retention numbers, contact details and the processor list come from
// lib/legal (docs/phases/PHASE_20.md P20-23). Changing what this page says
// moves privacyLastUpdated in lib/legal/facts.ts.
export default function PrivacyPage() {
  const facts = LEGAL_FACTS;
  const processors = subprocessorsInUse().map((vendor) => vendor.name);
  return (
    <div className="mx-auto max-w-3xl px-6 py-16">
      <LegalHeader title="Privacy policy" lastUpdated={facts.privacyLastUpdated} />
      <div className="mt-8 space-y-6 text-sm leading-relaxed text-ink-700">
        <section>
          <h2 className="text-base font-semibold text-ink-950">What we collect</h2>
          <p className="mt-2">
            Your account email, the product photos and notes you upload, the outputs we generate for
            you, and usage records such as credits spent and job history. Payment details are handled
            by our payment processor and never stored by us. If you leave your email on one of our free
            tools, we keep that email, which tool you used and whether you ticked the box to get tips
            and offers.{" "}
            {collectAssistants}
          </p>
        </section>
        <section>
          <h2 className="text-base font-semibold text-ink-950">How we use it</h2>
          <p className="mt-2">
            To run the service: analyzing your photos, generating your packs, billing your plan and
            supporting your account. We send your photos to AI providers only to process your own
            requests, on API tiers that do not train on your inputs.
          </p>
          <p className="mt-2" data-testid="privacy-email">
            We email you about your account, the packs you make and your payments. If you have an
            account, we also send a few emails with product tips and offers, such as a reminder to
            make your first pack. Each of those has a one click unsubscribe link, and you can turn them
            off any time under Settings, Emails. If you left your email on a free tool, we send you
            tips and offers only if you ticked the box to get them, and we email you when packs are
            back only if you asked us to. We send email through Resend, and we keep a record of which
            emails we sent and who unsubscribed, stored as a scrambled code of your address rather
            than the address itself.
          </p>
        </section>
        <section>
          <h2 className="text-base font-semibold text-ink-950">Sharing</h2>
          <p className="mt-2">
            We do not sell your data. We share it only with the infrastructure providers that run the
            service, such as hosting, storage, authentication, email delivery (Resend) and AI
            processing, each bound by their own data agreements. When you publish a share page for a pack, the images on it and the
            product title are public to anyone with the link, and to everyone if you also list it in
            the gallery. Share page images are served without their original photo metadata. You can
            take a share page down at any time. {sharingAssistants}
          </p>
          <p className="mt-2" data-testid="privacy-processors">
            The companies that process data for us today are {joinList(processors)}. Our{" "}
            <Link href="/legal/subprocessors" className="font-medium text-ink-900 underline">
              subprocessors page
            </Link>{" "}
            says what each one does and what it receives.
          </p>
        </section>
        <section data-testid="privacy-assistants">
          <h2 className="text-base font-semibold text-ink-950">{assistantPrivacy.heading}</h2>
          <p className="mt-2">{assistantPrivacy.signIn}</p>
          <p className="mt-2">{assistantPrivacy.received}</p>
          <p className="mt-2">{assistantPrivacy.sentIntro}</p>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            {assistantPrivacy.sent.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
          <p className="mt-2">{assistantPrivacy.retention}</p>
        </section>
        <LegalSection id="retention" heading="Retention and deletion" testId="privacy-retention">
          <div className="mt-3 overflow-x-auto rounded-lg border border-ink-100">
            <table className="w-full min-w-[32rem] text-left text-sm">
              <thead className="bg-ink-50 text-ink-900">
                <tr>
                  <th scope="col" className="px-4 py-2 font-semibold">
                    What
                  </th>
                  <th scope="col" className="px-4 py-2 font-semibold">
                    How long we keep it
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {retentionRows(facts).map((row) => (
                  <tr key={row.key} data-testid={`retention-${row.key}`} className="align-top">
                    <th scope="row" className="px-4 py-3 font-medium text-ink-900">
                      {row.what}
                    </th>
                    <td className="px-4 py-3">{row.howLong}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-3">{RETENTION_RIGHTS}</p>
        </LegalSection>
        <section>
          <h2 className="text-base font-semibold text-ink-950">Cookies and analytics</h2>
          <p className="mt-2">
            We use essential cookies to keep you signed in. We also use analytics cookies from PostHog
            to learn which pages help sellers, and the OpenAI Ads pixel to measure which ads bring
            sellers here, but only if you accept them in the cookie banner. If you decline, or have not
            chosen yet, neither of them loads and no analytics or advertising cookie is set. You can
            change your choice at any time from Cookie settings in the site footer.
          </p>
          <p className="mt-2" data-testid="privacy-signup-source">
            If you accept, we also keep one first party cookie for 90 days that remembers the first
            page you opened here, the site that sent you and any campaign tags in that link. When you
            create an account, we store with it how you found us: that first visit if you accepted,
            the campaign tags and share or referral code in the link you followed, the page where
            you clicked Start free, and your answer to &quot;How did you hear about Curvi?&quot; if you
            gave one. We use it only to learn which places bring sellers, and you can ask us to
            delete it any time. Declining cookies deletes that cookie.
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
        <LegalSection id="contact" heading="Who we are and how to reach us" testId="privacy-contact">
          <p className="mt-2">
            <LegalLineText line={entitySentence(facts)} />
          </p>
          <p className="mt-2">
            Privacy questions and requests go to <MailLink email={facts.support.email} />. {replySentence(facts)}
          </p>
        </LegalSection>
      </div>
    </div>
  );
}
