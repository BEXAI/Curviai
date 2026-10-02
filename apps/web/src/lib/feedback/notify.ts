import type { Db } from "@curvi/db";
import { PgCapStore } from "@curvi/trigger/cap-store";
import { sendFounderEmail } from "@curvi/trigger/spend-alerts";
import { siteUrl } from "@/lib/env";
import type { FeedbackAnswer } from "./types";

export async function notifyUnusableFeedback(
  jobId: string, answer: FeedbackAnswer,
  deps: { claim(key: string): Promise<boolean>; release(key: string): Promise<void>; send: typeof sendFounderEmail },
) {
  if (answer.usable !== "not_yet") return;
  const key = `feedback:${jobId}`;
  if (!await deps.claim(key)) return;
  try {
    const sent = await deps.send({ subject: "A pack needs your attention", text: `${siteUrl()}/app/jobs/${jobId}\n\n${answer.comment ?? "No comment added."}` });
    if (!sent.ok) await deps.release(key);
  } catch { await deps.release(key); }
}
export function feedbackNotifier(db: Db) {
  const store = new PgCapStore(db);
  return (jobId: string, answer: FeedbackAnswer) => notifyUnusableFeedback(jobId, answer, { claim: (key) => store.claim(key), release: (key) => store.release(key), send: sendFounderEmail });
}
