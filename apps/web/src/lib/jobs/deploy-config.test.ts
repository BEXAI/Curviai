import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readInlineRunnerConfig } from "./inline-runner";

// The environment variables batch 1 added must be declared in render.yaml and
// explained in the launch checklist, so the founder can set them (rule 8).
const root = new URL("../../../../../", import.meta.url);
const renderYaml = readFileSync(new URL("render.yaml", root), "utf8");
const checklist = readFileSync(new URL("docs/LAUNCH_CHECKLIST.md", root), "utf8");

const BATCH_1_ENV = [
  "STRIPE_TAX_ENABLED",
  "FOUNDER_ALERT_EMAIL",
  "FOUNDER_ALERT_FROM",
  "CURVI_INLINE_PACK_CONCURRENCY",
  "CURVI_SHUTDOWN_GRACE_MS",
  "CURVI_INLINE_PACK_MAX_RUN_MS",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
];

/** The envVars entry for a key: its own lines up to the next entry. */
function renderEntry(key: string): string | null {
  const match = new RegExp(`- key: ${key}\\n((?:\\s+(?!- key:)[^\\n]*\\n)*)`).exec(renderYaml);
  return match ? match[0] : null;
}

describe("batch 1 deploy configuration", () => {
  it("declares every new variable in render.yaml, secrets without a value", () => {
    for (const key of BATCH_1_ENV) {
      const entry = renderEntry(key);
      expect(entry, key).not.toBeNull();
      expect(entry, key).toMatch(/sync: false|value: "/);
    }
    expect(renderEntry("UPSTASH_REDIS_REST_TOKEN")).toMatch(/sync: false/);
    expect(renderEntry("UPSTASH_REDIS_REST_TOKEN")).not.toMatch(/value:/);
  });

  it("explains every new variable in the launch checklist's table", () => {
    const section = checklist.slice(checklist.indexOf("## Environment variables added in batch 1"));
    expect(section.startsWith("## Environment variables added in batch 1")).toBe(true);
    for (const key of BATCH_1_ENV) {
      expect(section, key).toContain(`| \`${key}\` |`);
      expect(section, key).toContain(`${key}=`);
    }
  });

  it("puts the seed between the migrations and the push in the deploy order", () => {
    const order = checklist.slice(checklist.indexOf("## Deploy order for batch 1"), checklist.indexOf("## 1."));
    const migrate = order.indexOf("apply migrations 0011, 0012 and 0013");
    const seed = order.indexOf("pnpm db:seed");
    const push = order.indexOf("push main");
    const healthPath = order.indexOf("health check path");
    expect(migrate).toBeGreaterThan(-1);
    expect(seed).toBeGreaterThan(migrate);
    expect(push).toBeGreaterThan(seed);
    expect(healthPath).toBeGreaterThan(push);
  });

  it("reads the run cap variable the checklist documents", () => {
    expect(readInlineRunnerConfig((name) => (name === "CURVI_INLINE_PACK_MAX_RUN_MS" ? "120000" : undefined)).maxRunMs).toBe(
      120_000,
    );
  });
});
