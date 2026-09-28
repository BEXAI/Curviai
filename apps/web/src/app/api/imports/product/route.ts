/**
 * POST /api/imports/product
 * Reads a pasted Shopify or Amazon product link and returns the title,
 * description, bullet points and photo list the new pack form prefills
 * from. The server fetches the seller supplied URL, so the fetch is SSRF
 * safe (lib/url-import/safe-fetch.ts: https only, public addresses only,
 * rechecked on every redirect, capped in time and size). Signed in members
 * only, never client seats, and rate limited by IP and by workspace. A
 * cross site Origin is refused and the caller is resolved before the
 * (capped) body is read.
 * Nothing is stored here; the photo import route stores the chosen photo.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { readJsonCapped } from "@/lib/http/json-body";
import { sameOriginOrRefuse } from "@/lib/http/same-origin";
import { resolveSignedIn } from "@/lib/http/services";
import { limitByIp, limitByUser } from "@/lib/rate-limit";
import { importProduct, type ImportFailureReason } from "@/lib/url-import/import-product";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ImportRequest = z.object({
  url: z.string().trim().min(1).max(2048),
});

const FAILURE_STATUS: Record<ImportFailureReason, number> = {
  invalid_url: 400,
  blocked_host: 400,
  unsupported: 400,
  not_found: 422,
  blocked: 422,
  too_large: 422,
  timeout: 504,
  unreachable: 502,
};

export async function POST(request: Request): Promise<NextResponse> {
  const crossSite = sameOriginOrRefuse(request);
  if (crossSite) {
    return crossSite;
  }
  const ipLimited = await limitByIp(request, "imports.product");
  if (ipLimited) {
    return ipLimited;
  }

  const resolved = await resolveSignedIn("Sign in to import a product.", { ensure: true });
  if ("response" in resolved) {
    return resolved.response;
  }
  const { workspace } = resolved;
  if (workspace.role === "client") {
    return NextResponse.json(
      { error: "Client seats can review assets but cannot start packs.", reason: "forbidden" },
      { status: 403 },
    );
  }

  const workspaceLimited = await limitByUser("imports.product", `ws:${workspace.id}`);
  if (workspaceLimited) {
    return workspaceLimited;
  }

  const body = await readJsonCapped(request);
  if (!body.ok) {
    return body.response;
  }
  const parsed = ImportRequest.safeParse(body.data);
  if (!parsed.success) {
    return NextResponse.json({ error: "Paste a product link.", reason: "invalid_url" }, { status: 400 });
  }

  const result = await importProduct(parsed.data.url);
  if (!result.ok) {
    return NextResponse.json({ error: result.message, reason: result.reason }, { status: FAILURE_STATUS[result.reason] });
  }
  return NextResponse.json({ product: result.product });
}
