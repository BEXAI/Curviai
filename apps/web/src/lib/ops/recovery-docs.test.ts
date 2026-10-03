import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = new URL("../../../../../", import.meta.url);
const read = (path: string) => readFileSync(fileURLToPath(new URL(path, root)), "utf8");
const recovery = read("docs/ops/DISASTER_RECOVERY.md");

describe("recovery and staging documentation", () => {
  it("names every production service, cron and configured environment key", () => {
    const blueprint = read("render.yaml");
    const names = [...blueprint.matchAll(/^\s{4}name:\s*(\S+)/gm)].map((match) => match[1]);
    const keys = [...blueprint.matchAll(/^\s+- key:\s*([A-Z][A-Z0-9_]+)/gm)].map((match) => match[1]);
    expect(names.length).toBeGreaterThan(0);
    expect(keys.length).toBeGreaterThan(10);
    for (const name of [...names, ...keys]) expect(recovery, `Missing recovery setting: ${name}`).toContain(`\`${name}\``);
  });
  it("names every variable in the launch checklist's environment tables", () => {
    const keys = read("docs/LAUNCH_CHECKLIST.md").split("\n")
      .filter((line) => line.startsWith("|"))
      .flatMap((line) => [...line.split("|")[1].matchAll(/`([A-Z][A-Z0-9_]+)`/g)].map((match) => match[1]));
    expect(new Set(keys).size).toBeGreaterThan(20);
    for (const key of keys) expect(recovery, `Missing launch setting: ${key}`).toContain(`\`${key}\``);
  });
  it("keeps data review and schema/grant validation ahead of reconnecting without a backup prerequisite", () => {
    const review = recovery.indexOf("4. **Review before changing data.**");
    const validate = recovery.indexOf("5. **Validate before any app connection.**");
    const reconnect = recovery.indexOf("6. **Reconnect in order.**");
    expect(review).toBeGreaterThan(0);
    expect(validate).toBeGreaterThan(review);
    expect(reconnect).toBeGreaterThan(validate);
    expect(recovery).toContain("migration history, row-level security, table grants, ledger function grants, tenant isolation");
    expect(recovery).toContain("Code rollback alone does not roll back data.");
    expect(recovery).toContain("Never place a live database dump, Auth data or secrets in GitHub.");
    expect(recovery).toContain("Local disk and GitHub preserve source code, not live database rows");
    expect(recovery).toContain("no password-only in-app bypass");
    expect(read("docs/ops/BACKUP_RESTORE.md")).toContain("retired");
    expect(recovery).not.toContain("**Authenticate/decrypt.**");
  });
  it("staging explicitly selects free isolated resources without enabling provider canaries or OAuth", () => {
    const blueprint = read("render.staging.yaml");
    expect(blueprint).toMatch(/plan: free/);
    expect(blueprint).toMatch(/autoDeployTrigger: checksPass/);
    expect(blueprint).toMatch(/key: CURVI_INLINE_PACK_CONCURRENCY\s+value: "1"/);
    expect(blueprint).toMatch(/key: NEXT_PUBLIC_ENV_LABEL\s+value: staging/);
    expect(blueprint).toMatch(/key: R2_BUCKET_PRIVATE\s+value: curvi-staging/);
    expect(blueprint).toMatch(/key: CURVI_PROVIDER_CANARY_ENABLED\s+value: "0"/);
    expect(blueprint).toMatch(/key: MCP_OAUTH_ENABLED\s+value: "0"/);
    expect(blueprint).not.toMatch(/sk_(live|test)_\w+/);
    expect(read("docs/ops/STAGING.md")).toContain("Staging is never a restore target");
  });
  it("daily external and paid smoke jobs require explicit repository opt-ins", () => {
    const workflow = read(".github/workflows/smoke.yml");
    expect(workflow).toContain("vars.SMOKE_PUBLIC_ENABLED == '1'");
    expect(workflow).toContain("vars.SMOKE_STAGING_ENABLED == '1'");
    expect(workflow).toContain("vars.SMOKE_STAGING_PACK_ENABLED == '1'");
    expect(workflow).toContain("vars.SMOKE_SYNTHETIC_ENABLED == '1' && vars.SMOKE_WORKSPACE_EXCLUDED == '1'");
    expect(read("playwright.smoke.config.ts")).not.toMatch(/\bwebServer\s*:/);
    expect(read("e2e/smoke/pack.smoke.ts")).not.toMatch(/\{ request, page \}/);
  });
});
