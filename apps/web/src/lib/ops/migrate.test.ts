import { describe, expect, it, vi } from "vitest";
import { runGuardedMigration, type MigrationDeps } from "./migrate";

function fixture(): MigrationDeps {
  return {
    wait: vi.fn(async () => {}),
    migrate: vi.fn(async () => {}), appliedMigration: vi.fn(async () => "0044_new"), healthSchema: vi.fn(async () => "current"),
    drift: vi.fn(async () => ({ recipes: [{ issue: "body" }], switches: [{ key: "ops:packs_paused", value: true, preserved: true }] })),
    seed: vi.fn(async () => {}), log: vi.fn(),
  };
}
describe("guarded migration", () => {
  const options = { seed: false, expectedMigration: "0044_new" };
  it("migrates without a backup dependency and verifies the journal before health", async () => {
    const deps = fixture();
    await runGuardedMigration(options, deps);
    expect(deps.migrate).toHaveBeenCalledOnce();
    expect(deps.appliedMigration).toHaveBeenCalledOnce();
    expect(vi.mocked(deps.migrate).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(deps.appliedMigration).mock.invocationCallOrder[0]!);
    expect(vi.mocked(deps.appliedMigration).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(deps.healthSchema).mock.invocationCallOrder[0]!);
    expect(deps.seed).not.toHaveBeenCalled();
    expect(deps.drift).not.toHaveBeenCalled();
    expect(deps.wait).not.toHaveBeenCalled();
    expect(deps.log).toHaveBeenCalledExactlyOnceWith("Migration verified. Application schema is current.");
  });
  it("shows recipe and switch drift before migrating, then verifies bookkeeping before seeding", async () => {
    const deps = fixture();
    await runGuardedMigration({ ...options, seed: true }, deps);
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining('\"preserved\": true'));
    const order = [deps.drift, deps.migrate, deps.appliedMigration, deps.seed, deps.healthSchema].map((call) => vi.mocked(call).mock.invocationCallOrder[0]!);
    expect(order.every((at, index) => index === 0 || at > order[index - 1]!)).toBe(true);
    expect(deps.seed).toHaveBeenCalledOnce();
  });
  it.each([null, "0043_previous", "0045_unexpected"])("does not seed or claim healthy when migration bookkeeping is %s", async (applied) => {
    const deps = fixture(); deps.appliedMigration = vi.fn(async () => applied);
    await expect(runGuardedMigration({ ...options, seed: true }, deps)).rejects.toThrow("Drizzle");
    expect(deps.seed).not.toHaveBeenCalled();
    expect(deps.healthSchema).not.toHaveBeenCalled();
  });
  it("does not migrate if drift inspection fails before an explicit seed", async () => {
    const deps = fixture(); deps.drift = vi.fn(async () => { throw new Error("drift unavailable"); });
    await expect(runGuardedMigration({ ...options, seed: true }, deps)).rejects.toThrow("drift unavailable");
    expect(deps.migrate).not.toHaveBeenCalled();
    expect(deps.seed).not.toHaveBeenCalled();
  });
  it("does not inspect bookkeeping, seed, or claim health after a migration failure", async () => {
    const deps = fixture(); deps.migrate = vi.fn(async () => { throw new Error("migration failed"); });
    await expect(runGuardedMigration({ ...options, seed: true }, deps)).rejects.toThrow("migration failed");
    expect(deps.appliedMigration).not.toHaveBeenCalled();
    expect(deps.seed).not.toHaveBeenCalled();
    expect(deps.healthSchema).not.toHaveBeenCalled();
  });
  it("does not claim health when seeding fails", async () => {
    const deps = fixture(); deps.seed = vi.fn(async () => { throw new Error("seed failed"); });
    await expect(runGuardedMigration({ ...options, seed: true }, deps)).rejects.toThrow("seed failed");
    expect(deps.healthSchema).not.toHaveBeenCalled();
  });
  it("waits for the application schema cache to become current without repeating writes", async () => {
    const deps = fixture();
    vi.mocked(deps.healthSchema).mockResolvedValueOnce("behind").mockResolvedValueOnce("behind");
    await runGuardedMigration({ ...options, seed: true }, deps);
    expect(deps.healthSchema).toHaveBeenCalledTimes(3);
    expect(deps.wait).toHaveBeenCalledTimes(2);
    expect(deps.wait).toHaveBeenCalledWith(5_000);
    expect(deps.migrate).toHaveBeenCalledOnce();
    expect(deps.seed).toHaveBeenCalledOnce();
  });
  it("fails after the bounded schema health checks and never reports success", async () => {
    const deps = fixture(); deps.healthSchema = vi.fn(async () => "behind");
    await expect(runGuardedMigration(options, deps)).rejects.toThrow("application health did not confirm a current schema");
    expect(deps.healthSchema).toHaveBeenCalledTimes(12);
    expect(deps.wait).toHaveBeenCalledTimes(11);
    expect(deps.migrate).toHaveBeenCalledOnce();
    expect(deps.log).not.toHaveBeenCalled();
  });
});
