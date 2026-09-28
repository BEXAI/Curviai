/**
 * GET /api/health
 * Liveness and readiness in one fast check, used by Render's healthCheckPath
 * and by uptime monitors: 200 when this instance can serve, 503 when the
 * database does not answer, the database is behind this build's migrations,
 * or the instance is draining for shutdown. Demo mode (no database) always
 * reports ok. The response carries no secrets; see lib/service-health.ts.
 * Provider configuration detail stays on /api/health/providers.
 */

import { NextResponse } from "next/server";
import { sql } from "@curvi/db";
import { isR2Configured, optionalEnv } from "@/lib/env";
import { DEFAULT_PROVIDER_ENTRIES } from "@/lib/health";
import { currentInlinePackRunner } from "@/lib/jobs/inline-runner";
import { isDbMode } from "@/lib/services";
import { getDb } from "@/lib/services/db";
import { runHealthCheck, type SchemaCache } from "@/lib/service-health";

export const dynamic = "force-dynamic";

const globalScope = globalThis as typeof globalThis & { __curviHealthSchemaCache?: SchemaCache };

function schemaCache(): SchemaCache {
  globalScope.__curviHealthSchemaCache ??= { schemaCurrent: false, applied: null };
  return globalScope.__curviHealthSchemaCache;
}

/** Configuration a db mode instance needs to deliver packs, as stable codes. */
function configWarnings(): string[] {
  const warnings: string[] = [];
  if (!isR2Configured()) {
    warnings.push("storage_not_configured");
  }
  const configuredKinds = new Set(
    DEFAULT_PROVIDER_ENTRIES.filter((entry) => optionalEnv(entry.envVar)).map((entry) => entry.kind),
  );
  if (!configuredKinds.has("llm")) {
    warnings.push("no_llm_provider");
  }
  if (!configuredKinds.has("image")) {
    warnings.push("no_image_provider");
  }
  return warnings;
}

export async function GET(): Promise<NextResponse> {
  const result = await runHealthCheck({
    mode: isDbMode() ? "db" : "demo",
    pingDatabase: async () => {
      await getDb().execute(sql`select 1`);
    },
    latestAppliedMigration: async () => {
      const rows = await getDb().execute<{ latest: string | number | null }>(
        sql`select max(created_at)::text as latest from drizzle.__drizzle_migrations`,
      );
      const latest = rows[0]?.latest;
      return latest === null || latest === undefined ? null : Number(latest);
    },
    runnerStats: () => currentInlinePackRunner()?.stats() ?? null,
    configWarnings,
    commit: optionalEnv("RENDER_GIT_COMMIT") ?? null,
    cache: schemaCache(),
  });
  return NextResponse.json(result.body, {
    status: result.status,
    headers: { "Cache-Control": "no-store" },
  });
}
