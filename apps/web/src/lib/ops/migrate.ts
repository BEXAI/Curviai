import { backupReportSchema } from "./backups";

export function backupActivity(events: { event: { type: string; timestamp: string } }[], now: number): "idle" | "running" | "unknown" {
  let started = -Infinity;
  let ended = -Infinity;
  for (const { event } of events) {
    if (!["cron_job_run_started", "cron_job_run_ended"].includes(event.type)) continue;
    const at = Date.parse(event.timestamp);
    if (!Number.isFinite(at) || at > now + 5_000) return "unknown";
    if (event.type === "cron_job_run_started") started = Math.max(started, at);
    else ended = Math.max(ended, at);
  }
  if (!Number.isFinite(Math.max(started, ended))) return "unknown";
  // Equal timestamps are ambiguous: never risk canceling a new run.
  return started >= ended ? "running" : "idle";
}

export interface FreshBackup { startedAt: string; finishedAt: string; recordedAt: string; key: string }
export function freshBackup(value: unknown, now: number, after?: number): FreshBackup | null {
  if (!value || typeof value !== "object") return null;
  const { recordedAt, ...report } = value as Record<string, unknown>;
  if (typeof recordedAt !== "string" || !backupReportSchema.safeParse(report).success) return null;
  const started = Date.parse(String(report.startedAt));
  const finished = Date.parse(String(report.finishedAt));
  const recorded = Date.parse(recordedAt);
  if (![started, finished, recorded].every(Number.isFinite) || started > finished || finished > recorded || recorded > now || now - started >= 3_600_000 || (after !== undefined && started < after)) return null;
  return { startedAt: String(report.startedAt), finishedAt: String(report.finishedAt), recordedAt, key: String(report.key) };
}
export interface MigrationDeps {
  now(): number;
  wait(ms: number): Promise<void>;
  readBackup(): Promise<unknown>;
  backupState(): Promise<"idle" | "running" | "unknown">;
  triggerBackup(): Promise<void>;
  migrate(): Promise<void>;
  appliedMigration(): Promise<string | null>;
  healthSchema(): Promise<string>;
  drift(): Promise<unknown>;
  seed(): Promise<void>;
  log(message: string): void;
}
export async function runGuardedMigration(options: { backupNow: boolean; seed: boolean; expectedMigration: string }, deps: MigrationDeps): Promise<void> {
  let backup = freshBackup(await deps.readBackup(), deps.now());
  if (options.backupNow) {
    const state = await deps.backupState();
    if (state !== "idle") throw new Error(state === "running" ? "A backup is already running. Wait for its report." : "Backup activity could not be confirmed. Refusing to cancel a possible active backup.");
    const requestedAt = deps.now();
    await deps.triggerBackup();
    const deadline = requestedAt + 30 * 60_000;
    do {
      backup = freshBackup(await deps.readBackup(), deps.now(), requestedAt);
      if (backup) break;
      if (deps.now() >= deadline) throw new Error("No completed backup report arrived within 30 minutes. No migration was run.");
      await deps.wait(5_000);
    } while (!backup);
  }
  if (!backup) throw new Error("No valid backup from the last hour. Run a backup first or use --backup-now.");
  deps.log(`Verified completed backup ${backup.key}.`);
  if (options.seed) deps.log(`Seed drift before changes (operator switches are preserved):\n${JSON.stringify(await deps.drift(), null, 2)}`);
  await deps.migrate();
  if (await deps.appliedMigration() !== options.expectedMigration) throw new Error("Drizzle did not record the expected migration. Seeding was not run.");
  if (options.seed) await deps.seed();
  // The old deployment may know only an earlier journal; the owner connection
  // above verifies the exact newest mark, and health must remain compatible.
  for (let attempt = 0; attempt < 12; attempt++) {
    if (await deps.healthSchema() === "current") { deps.log("Migration verified. Application schema is current."); return; }
    if (attempt < 11) await deps.wait(5_000);
  }
  throw new Error("Migrations applied, but application health did not confirm a current schema. Inspect health before releasing.");
}
