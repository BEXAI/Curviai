import { setTimeout as delay } from "node:timers/promises";
import { createDb, platformSettings, sql } from "@curvi/db";
import { opsSwitchDefaults, recipeSeedRows } from "@curvi/pipeline/seed";
import { runGuardedMigration } from "../src/lib/ops/migrate";
import { compareRecipes, readRecipeRows } from "../src/lib/recipe-drift";
import { parseScriptArgs, runScript, ScriptRefusal } from "./cli";
import { command, jsonRequest, latestMigration, repositoryRoot, siteOrigin, targetEnvironment, targetValue } from "./ops-client";

void runScript(async (argv, io) => {
  const args = parseScriptArgs(argv, { env: { type: "string" }, seed: { type: "boolean", default: false } });
  const target = targetEnvironment(args.env);
  const root = repositoryRoot();
  const origin = siteOrigin(targetValue(target, "OPS_SITE_URL"));
  const cronSecret = targetValue(target, "CRON_SECRET");
  const url = targetValue(target, "DATABASE_URL");
  if (target === "staging" && (url === targetValue("prod", "DATABASE_URL", false) || origin === targetValue("prod", "OPS_SITE_URL", false))) throw new ScriptRefusal("Staging must use a separate database and site.");
  const latest = latestMigration(root);
  const db = createDb(url, { max: 1, prepare: false });
  try {
    await runGuardedMigration({ seed: args.seed === true, expectedMigration: latest.tag }, {
      wait: (ms) => delay(ms), log: io.out,
      async migrate() { await command("pnpm", ["--filter", "@curvi/db", "db:migrate"], root, { ...process.env, DATABASE_URL: url }); },
      async appliedMigration() {
        const result = await db.execute(sql`select created_at from drizzle.__drizzle_migrations order by created_at desc limit 1`);
        return Number((result as unknown as { created_at: string }[])[0]?.created_at) === latest.when ? latest.tag : null;
      },
      async healthSchema() { return (await jsonRequest<{ checks: { schema: string } }>(`${origin}/api/health`, cronSecret)).checks.schema; },
      async drift() {
        const stored = await db.select({ key: platformSettings.key, value: platformSettings.value }).from(platformSettings).where(sql`${platformSettings.key} like 'ops:%'`);
        const values = new Map(stored.map((row) => [row.key, row.value]));
        return {
          recipes: compareRecipes(await readRecipeRows(db), recipeSeedRows),
          switches: Object.entries(opsSwitchDefaults).map(([key, policy]) => {
            const value = values.get(key);
            // Flag metadata can contain operator email or free text; show only
            // the effective primitive switch value and default comparison.
            const candidate = value ?? policy.default;
            const raw = candidate && typeof candidate === "object" && "on" in candidate ? (candidate as { on: unknown }).on : candidate;
            const effective = raw === null || typeof raw === "boolean" || typeof raw === "number" ? raw : "invalid stored value";
            const fallback = typeof policy.default === "object" && policy.default !== null ? policy.default.on : policy.default;
            return { key, stored: values.has(key), value: effective, default: fallback, differs: JSON.stringify(effective) !== JSON.stringify(fallback), preserved: true };
          }),
        };
      },
      async seed() { await command("pnpm", ["db:seed"], root, { ...process.env, DATABASE_URL: url }); },
    });
  } finally { await db.$client.end({ timeout: 5 }); }
});
