import type { Metadata } from "next";
import Link from "next/link";
import { verifyUnsubscribeToken } from "@curvi/email";
import { UnsubscribeForm } from "@/components/marketing/unsubscribe-form";
import { UNSUBSCRIBE_HOME_LINK, UNSUBSCRIBE_INVALID, UNSUBSCRIBE_QUESTION, UNSUBSCRIBE_TITLE } from "@/lib/email/copy";
import { linkSecret } from "@/lib/email/config";
import { pageMetadata } from "@/lib/seo";

export const metadata: Metadata = pageMetadata({
  title: "Unsubscribe",
  description: "Stop tips and offers from Curvi.",
  path: "/email/unsubscribe",
  noIndex: true,
});

export const dynamic = "force-dynamic";

/**
 * The unsubscribe page a marketing email's footer links to
 * (docs/phases/PHASE_18.md P18-06): one confirm button, so a link scanner
 * that opens the page unsubscribes nobody. The token is checked here so a
 * forged link says so before anyone clicks; the button posts it to
 * /api/email/unsubscribe, which checks it again.
 */
export default async function UnsubscribePage({ searchParams }: { searchParams: Promise<{ t?: string | string[] }> }) {
  const { t } = await searchParams;
  const token = typeof t === "string" ? t : null;
  const valid = verifyUnsubscribeToken(linkSecret(), token) !== null;
  return (
    <div className="mx-auto max-w-md px-6 py-16" data-testid="unsubscribe-page">
      <h1 className="text-3xl font-bold tracking-tight text-ink-950">{UNSUBSCRIBE_TITLE}</h1>
      {valid && token ? (
        <>
          <p className="mt-3 text-ink-600">{UNSUBSCRIBE_QUESTION}</p>
          <UnsubscribeForm token={token} />
        </>
      ) : (
        <p className="mt-3 text-ink-600" role="alert" data-testid="unsubscribe-invalid">
          {UNSUBSCRIBE_INVALID}
        </p>
      )}
      <p className="mt-8 text-sm">
        <Link href="/" className="font-medium text-ink-900 underline">
          {UNSUBSCRIBE_HOME_LINK}
        </Link>
      </p>
    </div>
  );
}
