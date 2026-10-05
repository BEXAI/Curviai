import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { tiers, topUps, tick } from "@curvi/pipeline/seed";
import { CRON_JOBS } from "../cron-health";
import { readInlineRunnerConfig } from "./inline-runner";

const root = new URL("../../../../../", import.meta.url);
// ESLint pins this YAML parser in the lockfile; no production dependency.
const require = createRequire(import.meta.url);
const yaml = createRequire(require.resolve("eslint"))("js-yaml") as { load(text: string): Blueprint };
type Entry = { key?: string; value?: string; sync?: boolean; generateValue?: boolean; fromGroup?: string };
type Service = { name: string; type: string; schedule?: string; runtime: string; buildCommand?: string; dockerfilePath?: string; dockerCommand?: string; autoDeployTrigger?: string; envVars: Entry[] };
type Blueprint = { services: Service[]; envVarGroups: Array<{ name: string; envVars: Entry[] }> };
const blueprint = yaml.load(readFileSync(new URL("render.yaml", root), "utf8"));
const checklist = readFileSync(new URL("docs/LAUNCH_CHECKLIST.md", root), "utf8");
const inventory = checklist.slice(checklist.indexOf("## Production environment inventory"));
const keys = (entries: Entry[]) => entries.flatMap((entry) => entry.key ? [entry.key] : []);
const service = (name: string) => blueprint.services.find((entry) => entry.name === name)!;

/** Finite exceptions, each documented in the inventory. Never a prefix exemption. */
const EXTERNAL_ENV = new Set([
  "BACKUP_DATABASE_URL", "BACKUP_AGE_RECIPIENT", "BACKUP_R2_ACCOUNT_ID", "BACKUP_R2_BUCKET",
  "BACKUP_R2_ACCESS_KEY_ID", "BACKUP_R2_SECRET_ACCESS_KEY", "HEALTHCHECKS_BACKUP_URL",
  "ALLOW_DEMO_MODE", "APPDATA", "CI", "CURVI_API_KEY", "CURVI_API_URL", "CURVI_CONFIG_DIR",
  "CURVI_DEMO_ACQUISITION", "CURVI_RSS_TEST", "GITHUB_RUN_ID", "INIT_CWD", "NEXT_MANUAL_SIG_HANDLE",
  "NEXT_PUBLIC_ENV_LABEL", "NEXT_RUNTIME", "OPS_OPERATOR_EMAIL", "OPS_RELEASE_EMAIL", "OPS_SITE_URL", "PORT", "RENDER_API_KEY",
  "RENDER_BACKUP_CRON_ID", "RENDER_GIT_COMMIT", "RENDER_SERVICE_ID", "STAGING_DATABASE_URL",
  "STAGING_SUPABASE_URL", "STRIPE_E2E", "TEST_DATABASE_URL", "TRIGGER_SECRET_KEY", "XDG_CONFIG_HOME",
  "SMOKE_BASE_URL", "SMOKE_MODE", "SMOKE_API_KEY", "SMOKE_USER_EMAIL", "SMOKE_USER_PASSWORD",
  "SMOKE_ALLOW_PACKS", "SMOKE_ALLOW_PRODUCTION_PACK", "SMOKE_WORKSPACE_EXCLUDED", "SMOKE_EXPECTED_SHA",
  "STAGING_OPS_SITE_URL", "STAGING_CRON_SECRET", "STAGING_OPS_RELEASE_TOKEN", "STAGING_OPS_RELEASE_EMAIL",
  "STAGING_RENDER_API_KEY", "STAGING_RENDER_SERVICE_ID", "STAGING_RENDER_BACKUP_CRON_ID", "BACKUP_TIMESTAMP", "TMPDIR",
]);
// Known provider enums/path labels (and Supabase auth events), not environment names. A new uppercase
// literal must be classified explicitly so injected readers cannot evade CI.
const NOT_ENV = new Set(["BLOCK_REASON_UNSPECIFIED", "DRINKING_CUP", "ERR_JOSE_GENERIC", "IMAGE_OTHER", "IMAGE_PROHIBITED_CONTENT", "IMAGE_RECITATION", "IMAGE_SAFETY", "IN_PROGRESS", "IN_QUEUE", "PASSWORD_RECOVERY", "PHASE_19", "PROHIBITED_CONTENT", "SIGNED_IN", "SIGNED_OUT"]);
const VARIABLE = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/;
function namesIn(text: string, path = "fixture.ts"): Set<string> {
  const names = new Set<string>();
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  function visit(node: ts.Node) {
    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && VARIABLE.test(node.text) && !NOT_ENV.has(node.text)) names.add(node.text);
    if (ts.isPropertyAccessExpression(node) && /(?:^|\.)env$/.test(node.expression.getText(file)) && /^[A-Z][A-Z0-9_]+$/.test(node.name.text)) names.add(node.name.text);
    if (ts.isCallExpression(node)) {
      const call = node.expression.getText(file).split(".").at(-1);
      const argument = node.arguments[0];
      if (["optionalEnv", "requireEnv", "readEnv"].includes(call ?? "") && argument && ts.isStringLiteral(argument) && /^[A-Z][A-Z0-9_]*$/.test(argument.text)) names.add(argument.text);
      const targetKey = node.arguments[1];
      if (call === "targetValue" && targetKey && ts.isStringLiteral(targetKey)) names.add(`STAGING_${targetKey.text}`);
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return names;
}
function sourceFiles(path: string): string[] {
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    if (["node_modules", "dist", "eval", "testing", ".next"].includes(entry.name)) return [];
    const full = join(path, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.(?:[cm]?ts|tsx|js)$/.test(entry.name) && !/\.(?:test|spec)\./.test(entry.name) ? [full] : [];
  });
}
const files = ["apps/web/src", "apps/web/scripts", "trigger/src", "packages", "e2e/smoke"].flatMap((path) => sourceFiles(new URL(path, root).pathname));
files.push(new URL("apps/web/next.config.ts", root).pathname);
const discovered = new Set(files.flatMap((path) => [...namesIn(readFileSync(path, "utf8"), path)]));
// Computed names follow the real seeds, so a new tier/cadence cannot be missed.
for (const tier of tiers.filter((item) => item.monthlyUsd > 0)) {
  for (const cadence of ["MONTHLY", "ANNUAL"]) discovered.add(`STRIPE_PRICE_${tier.key.toUpperCase()}_${cadence}`);
  for (const suffix of ["", "_ANNUAL"]) discovered.add(`STRIPE_PORTAL_UPGRADE_CONFIG_${tier.key.toUpperCase()}${suffix}`);
}
for (const topUp of topUps) discovered.add(`STRIPE_PRICE_TOPUP_${topUp.credits}`);
const BACKUP_ENV = ["BACKUP_DATABASE_URL", "BACKUP_AGE_RECIPIENT", "BACKUP_R2_ACCOUNT_ID", "BACKUP_R2_BUCKET", "BACKUP_R2_ACCESS_KEY_ID", "BACKUP_R2_SECRET_ACCESS_KEY", "HEALTHCHECKS_BACKUP_URL"];
const SHARED_ENV = ["NEXT_PUBLIC_SITE_URL", "CRON_SECRET", "NODE_ENV"];
const deploymentNames = new Set([...blueprint.services.flatMap((item) => keys(item.envVars)), ...blueprint.envVarGroups.flatMap((group) => keys(group.envVars))]);
function missingNames(names: Iterable<string>, declared = deploymentNames): string[] {
  return [...names].filter((name) => !EXTERNAL_ENV.has(name) && !declared.has(name)).sort();
}
function misplacedSecrets(input: Blueprint): string[] {
  const allowed = { Curviai: new Set([...deploymentNames].filter((key) => !BACKUP_ENV.includes(key) && key !== "HEALTHCHECKS_TICK_URL")), "curvi-tick": new Set(["HEALTHCHECKS_TICK_URL"]) };
  return input.services.flatMap((item) => keys(item.envVars).filter((key) => !allowed[item.name as keyof typeof allowed]?.has(key)).map((key) => `${item.name}:${key}`));
}

describe("production deploy configuration", () => {
  it("covers direct, injected and dynamically named environment reads", () => {
    expect([...namesIn('optionalEnv("NEW_SERVICE_TOKEN"); requireEnv("SECOND_API_KEY"); process.env.DIRECT; env.NESTED_SECRET; const KEY = "DYNAMIC_API_KEY"; readEnv(KEY);')].sort()).toEqual(["DIRECT", "DYNAMIC_API_KEY", "NESTED_SECRET", "NEW_SERVICE_TOKEN", "SECOND_API_KEY"]);
    expect(missingNames(discovered)).toEqual([]);
    expect(missingNames(["UNDECLARED_API_KEY"])).toEqual(["UNDECLARED_API_KEY"]);
  });
  it("documents every source/deployment name and explicit exception", () => {
    expect(inventory.startsWith("## Production environment inventory")).toBe(true);
    for (const name of new Set([...discovered, ...deploymentNames, ...EXTERNAL_ENV])) expect(inventory, name).toContain(`| \`${name}\` |`);
  });
  it("isolates each cron's credentials from the web service", () => {
    expect(blueprint.envVarGroups).toHaveLength(1);
    expect(keys(blueprint.envVarGroups[0].envVars).sort()).toEqual([...SHARED_ENV].sort());
    expect(blueprint.envVarGroups[0].envVars.find((item) => item.key === "CRON_SECRET")).toEqual({ key: "CRON_SECRET", generateValue: true });
    expect(service("curvi-backup")).toBeUndefined();
    for (const name of BACKUP_ENV) expect(deploymentNames.has(name), name).toBe(false);
    expect(keys(service("curvi-tick").envVars)).toEqual(["HEALTHCHECKS_TICK_URL"]);
    for (const item of blueprint.services) expect(item.envVars.filter((entry) => entry.fromGroup)).toEqual([{ fromGroup: "curvi-common" }]);
    expect(misplacedSecrets(blueprint)).toEqual([]);
    const corrupted = structuredClone(blueprint);
    corrupted.services.find((item) => item.name === "Curviai")!.envVars.push({ key: "BACKUP_R2_SECRET_ACCESS_KEY", sync: false });
    expect(misplacedSecrets(corrupted)).toContain("Curviai:BACKUP_R2_SECRET_ACCESS_KEY");
  });
  it("does not commit secrets or retired Trigger.dev configuration", () => {
    const publicDefaults = new Set(["NODE_VERSION", "CURVI_INLINE_PACK_CONCURRENCY"]);
    for (const item of blueprint.services) for (const entry of item.envVars) {
      if (entry.key && !publicDefaults.has(entry.key)) expect(entry, `${item.name}:${entry.key}`).toEqual({ key: entry.key, sync: false });
    }
    expect(deploymentNames.has("TRIGGER_SECRET_KEY")).toBe(false);
    expect(service("Curviai").autoDeployTrigger).toBe("checksPass");
    expect(service("Curviai").buildCommand).toContain("--prod=false");
    expect([...deploymentNames].filter((name) => EXTERNAL_ENV.has(name))).toEqual([]);
    expect(new Set(keys(service("Curviai").envVars)).size).toBe(keys(service("Curviai").envVars).length);
  });
  it("maps the tick service to registered work without provisioning backups", () => {
    expect(blueprint.services.map((item) => item.name).sort()).toEqual(["Curviai", "curvi-tick"]);
    expect(blueprint.services.filter((item) => item.type === "cron").map((item) => item.name)).toEqual(["curvi-tick"]);
    expect(CRON_JOBS.map((job) => job.name)).not.toContain("backup");
    expect(CRON_JOBS.filter((job) => "run" in job).length).toBeGreaterThan(0);
    const item = service("curvi-tick");
    expect(item.schedule).toBe(`*/${tick.everyMinutes} * * * *`);
    expect(item.runtime).toBe("docker");
    expect(item.dockerfilePath).toBe("./ops/cron/Dockerfile");
    expect(item.dockerCommand).toBe("/usr/local/bin/curvi-tick");
    const docker = readFileSync(new URL("ops/cron/Dockerfile", root), "utf8");
    expect(docker).toContain("COPY ops/cron/tick.sh /usr/local/bin/curvi-tick");
    const commands = [...docker.matchAll(/^CMD (.+)$/gm)].map((match) => JSON.parse(match[1]) as string[]);
    expect(commands).toEqual([[item.dockerCommand]]);
    expect(docker).toContain("COPY ops/cron/backup.sh /usr/local/bin/curvi-backup");
    expect(docker).toMatch(/^ENTRYPOINT \[\]$/m);
    expect(docker).toMatch(/^USER postgres$/m);
  });
  it("documents founder env-example verification without reading the protected file", () => {
    expect(inventory).toContain("`.env.example` was not read");
    expect(inventory).toContain("Founder verification required");
    expect(files.some((path) => path.split("/").at(-1)?.startsWith(".env"))).toBe(false);
  });
  it("reads the documented inline run cap", () => {
    expect(readInlineRunnerConfig((name) => name === "CURVI_INLINE_PACK_MAX_RUN_MS" ? "120000" : undefined).maxRunMs).toBe(120_000);
  });
});
