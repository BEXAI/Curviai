"use server";
import { revalidatePath } from "next/cache";
import { updateOperatorCase } from "@/lib/ops/cases";
import { operatorCaseInput } from "@/lib/cases/types";
import { requireOperator } from "@/lib/ops/access";
import { getDb } from "@/lib/services/db";
export async function caseAction(form: FormData): Promise<void> {
  const session = await requireOperator();
  const caseId = String(form.get("caseId") ?? ""), privateNote = form.get("private") === "yes";
  const input = operatorCaseInput.parse({ requestId: form.get("requestId"), message: form.get("message"), private: privateNote, ...(privateNote ? {} : { status: form.get("status") }) });
  await updateOperatorCase(getDb(), { userId: session.user.id, email: session.user.email! }, caseId, input);
  revalidatePath(`/app/ops/cases/${caseId}`); revalidatePath("/app/ops/cases");
}
