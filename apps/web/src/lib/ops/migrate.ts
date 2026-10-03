export interface MigrationDeps {
  wait(ms: number): Promise<void>;
  migrate(): Promise<void>;
  appliedMigration(): Promise<string | null>;
  healthSchema(): Promise<string>;
  drift(): Promise<unknown>;
  seed(): Promise<void>;
  log(message: string): void;
}
export async function runGuardedMigration(options: { seed: boolean; expectedMigration: string }, deps: MigrationDeps): Promise<void> {
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
