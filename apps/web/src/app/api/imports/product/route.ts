/**
 * POST /api/imports/product
 * Reads a pasted Shopify or Amazon product link and returns the title,
 * description, bullet points and photo list the new pack form prefills
 * from. The server fetches the seller supplied URL, so the fetch is SSRF
 * safe (lib/url-import/safe-fetch.ts: https only, public addresses only,
 * rechecked on every redirect, capped in time and size). Signed in members
 * only, never client seats, and rate limited by IP and by workspace.
 * Nothing is stored here; the photo import route stores the chosen photo.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { limitByIp, limitByUser } from "@/lib/rate-limit";
import { getServices } from "@/lib/services";
import { resolveWorkspace } from "@/lib/services/workspace-response";
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
  const ipLimited = await limitByIp(request, "imports.product");
  if (ipLimited) {
    return ipLimited;
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Request body must be JSON." }, { status: 400 });
  }
  const parsed = ImportRequest.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Paste a product link.", reason: "invalid_url" }, { status: 400 });
  }

  const services = getServices();
  const resolved = await resolveWorkspace(services, "Sign in to import a product.", { ensure: true });
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

  const result = await importProduct(parsed.data.url);
  if (!result.ok) {
    return NextResponse.json({ error: result.message, reason: result.reason }, { status: FAILURE_STATUS[result.reason] });
  }
  return NextResponse.json({ product: result.product });
}
