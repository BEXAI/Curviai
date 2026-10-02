import { NextResponse } from "next/server";
import { caseActor, getCaseStore } from "@/lib/cases";
import { caseError } from "@/lib/cases/http";
import { replyCaseInput } from "@/lib/cases/types";
import { readJsonCapped } from "@/lib/http/json-body";
import { sameOriginOrRefuse } from "@/lib/http/same-origin";
import { resolveSignedIn } from "@/lib/http/services";
import { limitByIp, limitByUser } from "@/lib/rate-limit";
import { isUuid } from "@/lib/validation/ids";
export const dynamic = "force-dynamic";
export async function POST(request: Request, context: { params: Promise<{ id: string; caseId: string }> }) {
  const refused = sameOriginOrRefuse(request) ?? await limitByIp(request, "support.contact");
  if (refused) return refused;
  const { id, caseId } = await context.params;
  if (!isUuid(id) || !isUuid(caseId)) return NextResponse.json({ error: "Case not found." }, { status: 404 });
  const resolved = await resolveSignedIn("Sign in to reply."); if ("response" in resolved) return resolved.response;
  const actor = await caseActor(resolved.workspace.id); if (!actor) return NextResponse.json({ error: "Sign in to reply." }, { status: 401 });
  const limited = await limitByUser("support.contact", actor.userId); if (limited) return limited;
  const body = await readJsonCapped(request); if (!body.ok) return body.response;
  const input = replyCaseInput.safeParse(body.data);
  if (!input.success) return NextResponse.json({ error: "Write a reply of 10 to 2,000 characters." }, { status: 400 });
  try { return NextResponse.json({ case: await getCaseStore().reply(actor, id, caseId, input.data) }, { headers: { "Cache-Control": "no-store" } }); }
  catch (error) { return caseError(error); }
}
