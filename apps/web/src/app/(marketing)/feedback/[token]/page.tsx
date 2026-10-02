import type { Metadata } from "next";
import Link from "next/link";
import { FeedbackLinkForm } from "@/components/marketing/feedback-link-form";
import { FEEDBACK_COPY } from "@/lib/feedback/copy";
import { resolveFeedbackLink } from "@/lib/feedback/link-actor";
import { feedbackLinksEnabled } from "@/lib/feedback/link";
import { pageMetadata } from "@/lib/seo";

/**
 * /feedback/{token} (docs/phases/PHASE_18.md P18-05): the pack feedback
 * questions from a signed link, so the day 2 email (P18-07) can ask without a
 * sign in. The token names one pack and one person and expires
 * (lib/feedback/link.ts). Never indexed; an invalid link shows one plain
 * line and a way into the app.
 */

export const metadata: Metadata = pageMetadata({
  title: FEEDBACK_COPY.linkPageTitle,
  description: FEEDBACK_COPY.title,
  path: "/feedback",
  noIndex: true,
});
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ token: string }> };

function Notice({ text, jobId }: { text: string; jobId?: string }) {
  return (
    <div className="mx-auto max-w-xl px-6 py-16" data-testid="feedback-link-notice">
      <h1 className="text-3xl font-bold tracking-tight text-ink-950">{FEEDBACK_COPY.linkPageTitle}</h1>
      <p className="mt-3 text-ink-600">{text}</p>
      <p className="mt-6 text-sm">
        <Link href={jobId ? `/app/jobs/${jobId}#feedback` : "/app"} className="font-medium text-ink-900 underline">
          {FEEDBACK_COPY.openPack}
        </Link>
      </p>
    </div>
  );
}

export default async function FeedbackLinkPage({ params }: Params) {
  const { token } = await params;
  if (!feedbackLinksEnabled()) {
    return <Notice text={FEEDBACK_COPY.linkUnavailable} />;
  }
  let target: Awaited<ReturnType<typeof resolveFeedbackLink>> = null;
  try {
    target = await resolveFeedbackLink(token);
  } catch (err) {
    console.error("[feedback] could not read a feedback link", err instanceof Error ? err.message : err);
    return <Notice text={FEEDBACK_COPY.linkUnavailable} />;
  }
  if (!target) {
    return <Notice text={FEEDBACK_COPY.linkInvalid} />;
  }
  const status = await target.store.status(target.actor, target.jobId);
  if (!status) {
    return <Notice text={FEEDBACK_COPY.linkInvalid} />;
  }
  if (status.answered) {
    return <Notice text={FEEDBACK_COPY.already} jobId={target.jobId} />;
  }
  if (!status.eligible) {
    return <Notice text={FEEDBACK_COPY.notReady} jobId={target.jobId} />;
  }
  return (
    <div className="mx-auto max-w-xl px-6 py-16" data-testid="feedback-link-page">
      <h1 className="text-3xl font-bold tracking-tight text-ink-950">{FEEDBACK_COPY.title}</h1>
      <p className="mt-3 text-ink-600">{FEEDBACK_COPY.intro}</p>
      <FeedbackLinkForm token={token} />
    </div>
  );
}
