/** Operator-only case reads and writes. Pages/actions also require a verified MFA session. */
import { sql, type Db } from "@curvi/db";
import { packCasesPolicy } from "@curvi/pipeline/seed";
import { opsEmails } from "@/lib/ops";
import { isUuid } from "@/lib/validation/ids";
import { addEvent, iso, missing, project, publicColumns, rows, type CaseRow } from "@/lib/cases/db-store";
import { CaseRefusal, operatorCaseInput, type OperatorCaseInput } from "@/lib/cases/types";
import { writeOpsAudit } from "./audit";

function checkOperator(actor: { userId: string; email: string }) {
  if (!isUuid(actor.userId) || !opsEmails().includes(actor.email.trim().toLowerCase())) throw new CaseRefusal("not_operator", "Operator access is required.");
}
export async function operatorCases(db: Db, actor: { userId: string; email: string }, caseId?: string) {
  checkOperator(actor);
  if (caseId && !isUuid(caseId)) return [];
  const found = rows<CaseRow>(await db.execute(sql`select ${publicColumns} from pack_cases c ${caseId ? sql`where c.id=${caseId}::uuid` : sql`where c.status <> 'resolved'`} order by c.updated_at, c.id limit ${packCasesPolicy.operatorPageSize}`));
  return Promise.all(found.map(async (row) => ({ workspaceId: row.workspace_id, case: await project(db, row, new Date()), notes: caseId ? rows<{ id: string; message: string; created_at: Date | string }>(await db.execute(sql`select id,message,created_at from pack_case_notes where case_id=${row.id}::uuid and workspace_id=${row.workspace_id}::uuid order by created_at desc limit 100`)).map((note) => ({ id: note.id, message: note.message, createdAt: iso(note.created_at) })) : [] })));
}
export async function updateOperatorCase(db: Db, actor: { userId: string; email: string }, caseId: string, raw: OperatorCaseInput) {
  checkOperator(actor);
  if (!isUuid(caseId)) throw missing();
  const input = operatorCaseInput.parse(raw);
  if (input.private && input.status) throw new CaseRefusal("invalid_reference", "Change a status with a seller-visible explanation.");
  await db.transaction(async (tx) => {
    const row = rows<CaseRow>(await tx.execute(sql`select ${publicColumns} from pack_cases c where c.id=${caseId}::uuid for update`))[0];
    if (!row) throw missing();
    // The audit dedupe key also covers private notes, which have no customer-visible event.
    if (rows(await tx.execute(sql`select id from ops_audit where action='case.update' and target_id=${caseId} and detail->>'requestId'=${input.requestId}`)).length) return;
    if (input.private) {
      await tx.execute(sql`insert into pack_case_notes(workspace_id,case_id,actor_user_id,message) values(${row.workspace_id}::uuid,${caseId}::uuid,${actor.userId}::uuid,${input.message})`);
    } else {
      const status = input.status ?? row.status;
      if (row.status === "resolved" && status !== "resolved") throw new CaseRefusal("resolved", "The reporting seller or workspace owner must explicitly reopen this case.");
      await tx.execute(sql`update pack_cases set status=${status},updated_at=now(),resolved_at=case when ${status}='resolved' then coalesce(resolved_at,now()) else null end where id=${caseId}::uuid`);
      await addEvent(tx, row, actor.userId, "operator", input.requestId, input.message, status);
    }
    await writeOpsAudit(tx, { operatorEmail: actor.email, action: "case.update", targetKind: "case", targetId: caseId, workspaceId: row.workspace_id, detail: { requestId: input.requestId, private: input.private, status: input.status ?? null } });
  });
}
