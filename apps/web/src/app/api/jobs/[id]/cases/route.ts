import { NextResponse } from "next/server";
import { caseActor, getCaseStore } from "@/lib/cases";
import { caseError } from "@/lib/cases/http";
import { createCaseInput } from "@/lib/cases/types";
import { readJsonCapped } from "@/lib/http/json-body";
import { sameOriginOrRefuse } from "@/lib/http/same-origin";
import { resolveSignedIn } from "@/lib/http/services";
import { limitByIp, limitByUser } from "@/lib/rate-limit";
import { isUuid } from "@/lib/validation/ids";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };
async function resolve(id: string) {
  if (!isUuid(id)) return { response: NextResponse.json({ error: "Pack not found." }, { status: 404 }) };
  const result = await resolveSignedIn("Sign in to view your cases.");
  if ("response" in result) return result;
  const actor = await caseActor(result.workspace.id);
  return actor ? { actor } : { response: NextResponse.json({ error: "Sign in to view your cases." }, { status: 401 }) };
}
export async function GET(_request: Request, context: Context) {
  const { id } = await context.params, resolved = await resolve(id);
  if ("response" in resolved) return resolved.response;
  try {
    const result = await getCaseStore().list(resolved.actor, id);
    return NextResponse.json(result ?? { error: "Pack not found." }, { status: result ? 200 : 404, headers: { "Cache-Control": "no-store" } });
  } catch (error) { return caseError(error); }
}
export async function POST(request: Request, context: Context) {
  const refused = sameOriginOrRefuse(request) ?? await limitByIp(request, "support.contact");
  if (refused) return refused;
  const { id } = await context.params, resolved = await resolve(id);
  if ("response" in resolved) return resolved.response;
  const limited = await limitByUser("support.contact", resolved.actor.userId);
  if (limited) return limited;
  const body = await readJsonCapped(request); if (!body.ok) return body.response;
  const input = createCaseInput.safeParse(body.data);
  if (!input.success) return NextResponse.json({ error: "Choose a category and write 10 to 2,000 characters." }, { status: 400 });
  try {
    const result = await getCaseStore().create(resolved.actor, id, input.data);
    return NextResponse.json(result, { status: result.created ? 201 : 200, headers: { "Cache-Control": "no-store" } });
  } catch (error) { return caseError(error); }
}
