import type { CaseActor, CaseList, CreateCaseInput, PackCase, ReplyCaseInput } from "./types";
export interface CaseStore {
  list(actor: CaseActor, jobId: string): Promise<CaseList | null>;
  create(actor: CaseActor, jobId: string, input: CreateCaseInput, supportRequestId?: string): Promise<{ case: PackCase; created: boolean }>;
  reply(actor: CaseActor, jobId: string, caseId: string, input: ReplyCaseInput): Promise<PackCase>;
}
