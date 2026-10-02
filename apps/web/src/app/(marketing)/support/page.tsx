import { SUPPORT_FAILURE } from "@/lib/support";
import type { Metadata } from "next";
import Link from "next/link";
import { SUPPORT_EMAIL, supportCopy } from "@/components/marketing/support-copy";
import { pageMetadata } from "@/lib/seo";
import { SupportForm } from "@/components/marketing/support-form";
import { getSessionUser } from "@/lib/supabase/server";

export const metadata: Metadata = pageMetadata({
  title: supportCopy.title,
  description: supportCopy.metaDescription,
  path: "/support",
});

/** /support (PHASE_19 P19-23): the support URL the plugin listing names. */
export default async function SupportPage() {
  const user = await getSessionUser();
  const [beforeEmail, afterEmail] = supportCopy.lead.split(SUPPORT_EMAIL);
  return (
    <div className="mx-auto max-w-3xl px-6 py-16">
      <h1 className="text-3xl font-bold tracking-tight text-ink-950">{supportCopy.title}</h1>
      <p className="mt-4 text-lg text-ink-600" data-testid="support-lead">
        {beforeEmail}
        <a href={`mailto:${SUPPORT_EMAIL}`} className="font-medium text-ink-900 underline">
          {SUPPORT_EMAIL}
        </a>
        {afterEmail}
      </p>
      <SupportForm signedIn={Boolean(user?.email_confirmed_at)} failureMessage={SUPPORT_FAILURE} />
      <div className="mt-10 space-y-8 text-sm leading-relaxed text-ink-700">
        <section>
          <h2 className="text-base font-semibold text-ink-950">{supportCopy.helpHeading}</h2>
          <p className="mt-2">{supportCopy.helpBody}</p>
          <Link href="/help" className="mt-2 inline-block font-medium text-ink-900 underline">
            {supportCopy.helpLink}
          </Link>
        </section>
        <section data-testid="support-connections">
          <h2 className="text-base font-semibold text-ink-950">{supportCopy.connectionsHeading}</h2>
          <p className="mt-2">{supportCopy.connectionsBody}</p>
          <Link href="/app/settings/connections" className="mt-2 inline-block font-medium text-ink-900 underline">
            {supportCopy.connectionsLink}
          </Link>
        </section>
        <section>
          <h2 className="text-base font-semibold text-ink-950">{supportCopy.policiesHeading}</h2>
          <p className="mt-2">{supportCopy.policiesBody}</p>
          <p className="mt-2 space-x-4">
            <Link href="/privacy" className="font-medium text-ink-900 underline">
              Privacy policy
            </Link>
            <Link href="/terms" className="font-medium text-ink-900 underline">
              Terms of service
            </Link>
          </p>
        </section>
      </div>
    </div>
  );
}
