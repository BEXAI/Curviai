import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tick } from "@curvi/pipeline/seed";
const script = fileURLToPath(new URL("../../../ops/cron/tick.sh", import.meta.url));
let dir: string;
const secret = "fake-cron-capability";
const monitor = "https://hc-ping.com/fake-monitor-id";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "curvi-tick-test-"));
  mkdirSync(join(dir, "bin")); mkdirSync(join(dir, "tmp"));
  writeFileSync(join(dir, "args"), ""); writeFileSync(join(dir, "requests"), "");
  writeFileSync(join(dir, "bin/curl"), `#!/bin/bash
printf '%s\\n' "$*" >> "$FAKE_DIR/args"
url=""; previous=""
for argument in "$@"; do
  case "$previous" in
    --config) url="$(sed -n 's/^url = "\\(.*\\)"$/\\1/p' "$argument")" ;;
    --header) cp "\${argument#@}" "$FAKE_DIR/header" ;;
  esac
  case "$argument" in https://*) url="$argument" ;; esac
  previous="$argument"
done
printf '%s\\n' "$url" >> "$FAKE_DIR/requests"
case "$url" in
  */api/cron/tick) exit "\${FAKE_TICK_EXIT:-0}" ;;
  */fake-monitor-id) exit "\${FAKE_PING_EXIT:-0}" ;;
esac
exit 0
`);
  chmodSync(join(dir, "bin/curl"), 0o755);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
function run(overrides: Record<string, string | undefined> = {}) {
  const result = spawnSync("bash", [script], { encoding: "utf8", env: {
    NODE_ENV: "test", PATH: `${join(dir, "bin")}:/usr/bin:/bin`, TMPDIR: join(dir, "tmp"), FAKE_DIR: dir,
    NEXT_PUBLIC_SITE_URL: "https://curvi.example/", CRON_SECRET: secret, HEALTHCHECKS_TICK_URL: monitor, ...overrides,
  } });
  return { ...result, requests: readFileSync(join(dir, "requests"), "utf8").trim().split("\n").filter(Boolean), args: readFileSync(join(dir, "args"), "utf8") };
}
describe("tick shell transport", () => {
  it("POSTs once with a hidden credential and pings success after work", () => {
    const result = run();
    expect(result.status).toBe(0);
    expect(result.requests).toEqual([`${monitor}/start`, "https://curvi.example/api/cron/tick", monitor]);
    expect(result.args).toContain("--request POST");
    expect(result.args).toContain("--max-time 300");
    expect(tick.budgetSeconds).toBeLessThan(300);
    expect(result.args).not.toContain(secret);
    expect(result.args).not.toContain(monitor);
    expect(readFileSync(join(dir, "header"), "utf8")).toBe(`authorization: Bearer ${secret}\n`);
    expect(readdirSync(join(dir, "tmp"))).toEqual([]);
  });
  it("fails on HTTP/network failure, sends only a failure heartbeat and does not retry work", () => {
    const result = run({ FAKE_TICK_EXIT: "22" });
    expect(result.status).toBe(1);
    expect(result.requests).toEqual([`${monitor}/start`, "https://curvi.example/api/cron/tick", `${monitor}/fail`]);
    expect(result.stderr).not.toContain(secret);
    expect(readdirSync(join(dir, "tmp"))).toEqual([]);
  });
  it("works without an optional monitor and fails visibly when a configured success ping fails", () => {
    expect(run({ HEALTHCHECKS_TICK_URL: "" }).status).toBe(0);
    expect(run({ FAKE_PING_EXIT: "7" }).status).toBe(1);
  });
  it("rejects missing credentials, unsafe origins and newline/config injection before calling curl", () => {
    for (const override of [{ CRON_SECRET: "" }, { CRON_SECRET: "secret\nheader" }, { NEXT_PUBLIC_SITE_URL: "http://curvi.example" }, { NEXT_PUBLIC_SITE_URL: "https://curvi.example\nhttps://evil.example" }, { NEXT_PUBLIC_SITE_URL: "https://user:pass@curvi.example" }, { HEALTHCHECKS_TICK_URL: 'https://monitor.example/"\nurl = "https://evil.example' }]) {
      const result = run(override);
      expect(result.status).toBe(2);
      expect(result.requests).toEqual([]);
    }
  });
});
