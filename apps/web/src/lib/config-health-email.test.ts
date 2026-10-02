import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb } from "@curvi/db/testing";
import { recipeSeedRows } from "@curvi/pipeline/seed";
import { liveProviderTargets } from "@curvi/trigger/provider-probes";
import { buildConfigReport, type ConfigReportDeps } from "./config-health";

// /api/health warns lifecycle_email_not_configured only while the
// lifecycle_email_enabled switch is on and a variable is missing (P18-06).

let client: Awaited<ReturnType<typeof createTestDb>>["client"];
let db: Awaited<ReturnType<typeof createTestDb>>["db"];

beforeAll(async () => {
  const created = await createTestDb();
  client = created.client;
  db = created.db;
});

afterAll(async () => {
  await client.close();
});

function deps(env: Record<string, string>): ConfigReportDeps {
  const readEnv = (name: string) => env[name];
  return {
    mode: "db",
    databaseOk: true,
    db: () => db,
    readEnv,
    storageConfigured: true,
    providerTargets: liveProviderTargets(readEnv),
    seedRecipes: recipeSeedRows,
    readTextFile: () => null,
    rssBytes: () => 1,
    now: () => new Date("2026-10-01T12:00:00Z"),
  };
}

describe("lifecycle email health", () => {
  it("is quiet while the switch is off and warns once it is on with the sender unset", async () => {
    const off = await buildConfigReport(deps({}));
    expect(off.warnings.map((w) => w.code)).not.toContain("lifecycle_email_not_configured");
    await client.query("insert into platform_settings (key, value) values ('ops:lifecycle_email_enabled', 'true'::jsonb)");
    const on = await buildConfigReport(deps({ RESEND_API_KEY: "re_secret_value" }));
    const warning = on.warnings.find((w) => w.code === "lifecycle_email_not_configured");
    expect(warning?.message).toContain("LIFECYCLE_EMAIL_FROM, LIFECYCLE_REPLY_TO are not set");
    expect(JSON.stringify(on)).not.toContain("re_secret_value");
  });
});
