"use server";

import { after } from "next/server";
import { revalidatePath } from "next/cache";
import { requireOperator } from "@/lib/ops/access";
import { operateJob } from "@/lib/ops/jobs";
import { getDb } from "@/lib/services/db";
import { claimRestartedJobs } from "@/lib/jobs/restart";
import { runnerId } from "@/lib/jobs/runner-owner";
import { getInlinePackRunner } from "@/lib/jobs/enqueue";

export async function jobAction(form: FormData): Promise<void> {
  const session = await requireOperator();
  if (form.get("confirm") !== "yes") throw new Error("Confirm this pack action.");
  const action = form.get("action");
  if (action !== "settle" && action !== "requeue") throw new Error("Unknown pack action.");
  const jobId = String(form.get("jobId") ?? "");
  const result = await operateJob(getDb(), { jobId, action, forced: form.get("force") === "yes", operator: session.user.email! });
  if (result.requeued) after(async () => {
    const payloads = await claimRestartedJobs(getDb(), { runnerId: runnerId(), jobId, limit: 1 });
    await Promise.all(payloads.map((payload) => getInlinePackRunner().submit(payload)));
  });
  revalidatePath(`/app/ops/jobs/${jobId}`);
}
