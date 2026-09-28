/**
 * GET /api/account/export
 * Downloads the workspace's data as one JSON file (lib/trust/export.ts):
 * products with their photos, packs with their files, the brand kit and the
 * credit history, each stored object with a link that works for 24 hours.
 * Owners and admins only, since the file carries every photo and pack of the
 * workspace. Never cached.
 */

import { NextResponse } from "next/server";
import { isR2Configured } from "@/lib/env";
import { resolveSignedIn } from "@/lib/http/services";
import { presignObjectGet } from "@/lib/r2";
import { isDbMode } from "@/lib/services";
import { getDb } from "@/lib/services/db";
import { getSessionUser } from "@/lib/supabase/server";
import {
  buildDbExport,
  buildServicesExport,
  EXPORT_LINK_TTL_SECONDS,
  exportFilename,
  type AccountExport,
} from "@/lib/trust/export";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  const resolved = await resolveSignedIn("Sign in to export your data.");
  if ("response" in resolved) {
    return resolved.response;
  }
  const { services, workspace } = resolved;
  if (workspace.role !== "owner" && workspace.role !== "admin") {
    return NextResponse.json({ error: "Only owners and admins can export the workspace's data." }, { status: 403 });
  }

  const now = new Date();
  let body: AccountExport;
  try {
    if (isDbMode()) {
      const user = await getSessionUser();
      const sign = isR2Configured() ? (key: string) => presignObjectGet(key, EXPORT_LINK_TTL_SECONDS) : null;
      body = await buildDbExport(getDb(), workspace, user?.email ?? null, sign, now);
    } else {
      body = await buildServicesExport(services, workspace, now);
    }
  } catch (err) {
    console.error(`[export] could not build the export of workspace ${workspace.id}`, err);
    return NextResponse.json({ error: "We could not build your export right now. Try again in a minute." }, { status: 503 });
  }

  return new NextResponse(JSON.stringify(body, null, 2), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="${exportFilename(now)}"`,
      "Cache-Control": "no-store",
    },
  });
}
