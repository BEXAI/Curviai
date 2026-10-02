import { z } from "zod";
import { packCasesPolicy } from "@curvi/pipeline/seed";
import { uuidSchema } from "@/lib/validation/ids";

export const CASE_CATEGORIES = ["fidelity", "compliance", "missing_output", "credits", "other"] as const;
export const CASE_STATUSES = ["received", "reviewing", "awaiting_seller", "resolved"] as const;
export type CaseStatus = typeof CASE_STATUSES[number];
export const CASE_LABELS = { fidelity: "Product appearance", compliance: "Channel requirements", missing_output: "Missing output", credits: "Credits for this pack", other: "Something else" };
export const STATUS_LABELS: Record<CaseStatus, string> = { received: "Received", reviewing: "Reviewing", awaiting_seller: "Waiting for your reply", resolved: "Resolved" };
const message = z.string().trim().min(10).max(packCasesPolicy.messageMaxChars).refine((value) => !/[\u0000-\u0008\u000b-\u001f\u007f]/.test(value), "Remove control characters.");
export const createCaseInput = z.object({
  category: z.enum(CASE_CATEGORIES), description: message, requestId: uuidSchema,
  shotId: z.string().trim().min(1).max(160).optional(), versionId: uuidSchema.optional(),
}).strict();
export type CreateCaseInput = z.infer<typeof createCaseInput>;
export const replyCaseInput = z.object({ requestId: uuidSchema, message, reopen: z.boolean().default(false) }).strict();
export type ReplyCaseInput = z.infer<typeof replyCaseInput>;
export const operatorCaseInput = z.object({ requestId: uuidSchema, message, status: z.enum(CASE_STATUSES).optional(), private: z.boolean().default(false) }).strict();
export type OperatorCaseInput = z.infer<typeof operatorCaseInput>;
export interface CaseActor { workspaceId: string; userId: string }
export interface CaseEvent { id: string; actor: "seller" | "operator" | "system"; status: CaseStatus | null; message: string; createdAt: string }
/** Explicit public projection. Operator notes and operator identity never enter it. */
export interface PackCase {
  id: string; jobId: string; category: typeof CASE_CATEGORIES[number]; status: CaseStatus; description: string;
  shotId: string | null; versionId: string | null; feedbackLinked: boolean; supportLinked: boolean;
  createdAt: string; updatedAt: string; resolvedAt: string | null; canReopen: boolean; events: CaseEvent[];
}
export interface CaseList { cases: PackCase[]; sourceUnavailable: boolean }
export class CaseRefusal extends Error {
  constructor(readonly reason: "not_found" | "open_case" | "resolved" | "reopen_expired" | "invalid_reference" | "not_operator" | "request_reused", message: string) { super(message); this.name = "CaseRefusal"; }
}
export function canReopen(resolvedAt: string | Date | null, now = new Date()): boolean {
  if (!resolvedAt) return false;
  const age = now.getTime() - new Date(resolvedAt).getTime();
  return age >= 0 && age <= packCasesPolicy.reopenDays * 86_400_000;
}
