import { describe, expect, it, vi } from "vitest";
import { backupActivity, freshBackup, runGuardedMigration, type MigrationDeps } from "./migrate";

const NOW = Date.UTC(2026, 9, 2, 12);
const backup = (started = NOW - 60_000) => ({
  key: "daily/2026/10/02/curvi-20261002T120000Z.tar.age", monthlyKey: null,
  bytes: 100, sha256: "a".repeat(64), counts: { "public.workspaces": 1 }, ledgerTotalTenths: 0,
  latestMigration: "1", serverVersion: "17.6", pgDumpVersion: "17.6",
  startedAt: new Date(started).toISOString(), finishedAt: new Date(started + 10_000).toISOString(), recordedAt: new Date(started + 11_000).toISOString(),
});
function fixture() {
  let now = NOW;
  const deps: MigrationDeps = {
    now: () => now, wait: vi.fn(async (ms) => { now += ms; }), readBackup: vi.fn(async () => backup()),
    backupState: vi.fn(async () => "idle" as const), triggerBackup: vi.fn(async () => {}),
    migrate: vi.fn(async () => {}), appliedMigration: vi.fn(async () => "0044_new"), healthSchema: vi.fn(async () => "current"),
    drift: vi.fn(async () => ({ recipes: [{ issue: "body" }], switches: [{ key: "ops:packs_paused", value: true, preserved: true }] })),
    seed: vi.fn(async () => {}), log: vi.fn(),
  };
  return deps;
}
describe("guarded migration", () => {
  it("refuses unknown or tied Render backup events, and detects a newer running backup", () => {
    const event = (type: string, offset: number) => ({ event: { type, timestamp: new Date(NOW + offset).toISOString() } });
    expect(backupActivity([], NOW)).toBe("unknown");
    expect(backupActivity([{ event: { type: "cron_job_run_ended", timestamp: "invalid" } }], NOW)).toBe("unknown");
    expect(backupActivity([event("cron_job_run_started", -20_000), event("cron_job_run_ended", -10_000)], NOW)).toBe("idle");
    expect(backupActivity([event("cron_job_run_ended", -20_000), event("cron_job_run_started", -10_000)], NOW)).toBe("running");
    expect(backupActivity([event("cron_job_run_ended", -10_000), event("cron_job_run_started", -10_000)], NOW)).toBe("running");
  });
  const options = { backupNow: false, seed: false, expectedMigration: "0044_new" };
  it("refuses an old or invalid backup before writes", async () => {
    const deps = fixture(); deps.readBackup = async () => backup(NOW - 3_600_000);
    await expect(runGuardedMigration(options, deps)).rejects.toThrow("last hour");
    expect(deps.migrate).not.toHaveBeenCalled();
    expect(freshBackup({ ...backup(), sha256: "invalid" }, NOW)).toBeNull();
    expect(freshBackup(backup(NOW), NOW)).toBeNull();
  });
  it.each(["running", "unknown"] as const)("refuses backup-now when backup activity is %s", async (state) => {
    const deps = fixture(); deps.backupState = async () => state;
    await expect(runGuardedMigration({ ...options, backupNow: true }, deps)).rejects.toThrow();
    expect(deps.triggerBackup).not.toHaveBeenCalled(); expect(deps.migrate).not.toHaveBeenCalled();
  });
  it("waits for a new completed backup rather than accepting the old report", async () => {
    const deps = fixture();
    deps.readBackup = async () => deps.now() < NOW + 15_000 ? backup() : backup(NOW);
    await runGuardedMigration({ ...options, backupNow: true }, deps);
    expect(deps.wait).toHaveBeenCalledTimes(3);
    expect(deps.migrate).toHaveBeenCalledTimes(1);
  });
  it("shows recipe and switch drift before seeding and verifies bookkeeping", async () => {
    const deps = fixture();
    await runGuardedMigration({ ...options, seed: true }, deps);
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining('"preserved": true'));
    expect(vi.mocked(deps.drift).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(deps.seed).mock.invocationCallOrder[0]!);
    expect(deps.seed).toHaveBeenCalledOnce();
  });
  it("does not seed when migration bookkeeping differs", async () => {
    const deps = fixture(); deps.appliedMigration = async () => "0043_previous";
    await expect(runGuardedMigration({ ...options, seed: true }, deps)).rejects.toThrow("Drizzle");
    expect(deps.seed).not.toHaveBeenCalled();
  });
});
