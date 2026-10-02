import { NextResponse } from "next/server";
import { sameOriginOrRefuse } from "@/lib/http/same-origin";
import { resolveSignedIn } from "@/lib/http/services";
import { limitByIp, limitByUser, userRateLimitSubject } from "@/lib/rate-limit";
import { isShotId, shotOpResponse } from "@/lib/services/shot-op-response";
import { isUuid } from "@/lib/validation/ids";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string; shotId: string }> },
): Promise<NextResponse> {
  const crossSite = sameOriginOrRefuse(request);
  if (crossSite) {
    return crossSite;
  }
  const ipLimited = await limitByIp(request, "jobs.create");
  if (ipLimited) {
    return ipLimited;
  }
  const { id, shotId } = await context.params;
  if (!isUuid(id) || !isShotId(shotId)) {
    return NextResponse.json({ error: "Shot not found." }, { status: 404 });
  }
  const resolved = await resolveSignedIn("Sign in to make another version.");
  if ("response" in resolved) {
    return resolved.response;
  }
  if (resolved.workspace.role === "client") return NextResponse.json({ error: "Only owners, admins and editors can make another version." }, { status: 403 });
  const { services } = resolved;
  const userLimited = await limitByUser("jobs.create", await userRateLimitSubject(resolved.workspace.id));
  if (userLimited) {
    return userLimited;
  }
  return shotOpResponse(await services.regenerateShot(resolved.workspace.id, id, shotId));
}
