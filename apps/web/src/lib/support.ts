import { z } from "zod";
import { supportReplyTime } from "@/lib/legal/copy";
import { LEGAL_FACTS } from "@/lib/legal/facts";

export const SUPPORT_FAILURE = `We could not send your message. Email ${LEGAL_FACTS.support.email} instead.`;
export const SUPPORT_SUCCESS = `Thanks. We got your message and will reply within ${supportReplyTime(LEGAL_FACTS)}.`;
export const supportInput = z.object({
  topic: z.enum(["pack", "billing", "account", "other"]),
  message: z.string().trim().min(10).max(2000),
  email: z.string().trim().email().max(254).optional(),
  job: z.string().uuid().optional(),
  website: z.string().max(200).optional(),
  requestId: z.string().uuid(),
  captchaToken: z.string().max(2048).optional(),
});
export type SupportInput = z.infer<typeof supportInput>;
export interface SupportActor { userId: string; email: string; workspaceId: string | null }
export interface SupportDeps {
  ownsJob(workspaceId: string, jobId: string): Promise<boolean>;
  deliver(input: { key: string; email: string; topic: SupportInput["topic"]; message: string; job: string | null; workspaceId: string | null }): Promise<boolean>;
  acknowledge(input: { key: string; email: string; workspaceId: string | null }): Promise<void>;
  record(input: { topic: string; job: string | null; workspaceId: string | null }): Promise<void>;
}
/** Job context is dropped unless ownership was established by the server. */
export async function submitSupport(input: SupportInput, actor: SupportActor | null, humanVerified: boolean, deps: SupportDeps): Promise<boolean> {
  if (input.website) return true;
  const email = actor?.email ?? input.email;
  if (!email || !z.string().email().safeParse(email).success) return false;
  const workspaceId = actor?.workspaceId ?? null;
  const job = input.job && workspaceId && await deps.ownsJob(workspaceId, input.job) ? input.job : null;
  const key = `support:${actor?.userId ?? "visitor"}:${input.requestId}`;
  if (!await deps.deliver({ key, email, topic: input.topic, message: input.message, job, workspaceId })) return false;
  await deps.record({ topic: input.topic, job, workspaceId }).catch(() => {});
  if (actor || humanVerified) await deps.acknowledge({ key: `${key}:reply`, email, workspaceId }).catch(() => {});
  return true;
}
