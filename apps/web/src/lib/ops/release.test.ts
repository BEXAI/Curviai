import { describe, expect, it, vi } from "vitest";
import { runRelease, type ReleaseDeps, type ReleaseHealth } from "./release";

const EXPECTED = { tag: "0044_new", when: 1234 };
const SHA = "a".repeat(40);
const health = (now = Date.UTC(2026, 9, 2, 12, 34)): ReleaseHealth => ({ status: "ok", mode: "db", commit: SHA.slice(0, 7), checks: { database: "ok", schema: "current" }, migrations: { applied: "0044_new" }, packs: { running: 0 }, details: { release: { appliedWhen: 1234, runningPacks: 0, checkedAt: new Date(now).toISOString() } } });
function fixture() {
  let now = Date.UTC(2026, 9, 2, 12, 34);
  const calls: string[] = [];
  const deps: ReleaseDeps = {
    now: () => now,
    wait: vi.fn(async (ms) => { calls.push(`wait:${ms}`); now += ms; }),
    preflight: vi.fn(async () => ({ sha: SHA, clean: true, pushed: true, ciPassed: true })),
    health: vi.fn(async () => health(now)),
    setPending: vi.fn(async (on) => { calls.push(`pending:${on}`); }),
    currentDeploy: vi.fn(async () => ({ id: "old", status: "live", commit: { id: "b".repeat(40) } })),
    disableAutoDeploy: vi.fn(async () => { calls.push("auto:off"); }),
    createDeploy: vi.fn(async () => { calls.push("deploy"); return { id: "new", status: "build_in_progress" }; }),
    readDeploy: vi.fn(async () => ({ id: "new", status: "live", commit: { id: SHA } })),
    probeProviders: vi.fn(async () => true), smoke: vi.fn(async () => {}),
    confirm: vi.fn(async () => false), rollback: vi.fn(async () => ({ id: "rollback", status: "live" })),
    tag: vi.fn(async () => { calls.push("tag"); }), log: vi.fn(),
  };
  return { deps, calls };
}
describe("guarded release", () => {
  it("preserves auto deploy unless an explicit disable action is supplied", async () => {
    const { deps, calls } = fixture();
    delete deps.disableAutoDeploy;
    await runRelease(EXPECTED, deps);
    expect(calls).not.toContain("auto:off");
  });
  it("waits for the cached switch and idle packs, pins the full Render SHA, tags only after probes and smoke", async () => {
    const { deps, calls } = fixture();
    let reads = 0;
    deps.health = vi.fn(async () => ({ ...health(deps.now()), details: { release: { appliedWhen: 1234, runningPacks: reads++ === 1 ? 1 : 0, checkedAt: new Date(deps.now()).toISOString() } } }));
    const result = await runRelease(EXPECTED, deps);
    expect(calls).toEqual(["pending:true", "wait:30000", "wait:5000", "auto:off", "deploy", "wait:5000", "tag", "pending:false"]);
    expect(deps.createDeploy).toHaveBeenCalledWith(SHA);
    expect(result.tag).toBe("release-20261002-1234");
  });
  it.each(["clean", "pushed", "ciPassed"] as const)("refuses when %s is false before any write", async (field) => {
    const { deps } = fixture();
    deps.preflight = async () => ({ sha: SHA, clean: true, pushed: true, ciPassed: true, [field]: false });
    await expect(runRelease(EXPECTED, deps)).rejects.toThrow("clean tree");
    expect(deps.setPending).not.toHaveBeenCalled();
  });
  it("stops before deployment when the database is missing a migration", async () => {
    const { deps } = fixture();
    await expect(runRelease({ tag: "0045_next", when: 5678 }, deps)).rejects.toThrow("ops:migrate");
    expect(deps.createDeploy).not.toHaveBeenCalled();
    expect(deps.setPending).not.toHaveBeenCalled();
  });
  it("accepts the exact fresh migration timestamp even when the old public tag is stale", async () => {
    const { deps } = fixture();
    deps.health = async () => ({ ...health(deps.now()), migrations: { applied: "0043_previous" } });
    await expect(runRelease(EXPECTED, deps)).resolves.toMatchObject({ sha: SHA });
  });
  it("does not trust public local runner counts or absent protected details", async () => {
    const { deps } = fixture();
    deps.health = async () => ({ ...health(), details: undefined });
    await expect(runRelease(EXPECTED, deps)).rejects.toThrow("protected release health");
    expect(deps.setPending).not.toHaveBeenCalled();
  });
  it("clears the switch after SIGINT, even during the first cache wait", async () => {
    const { deps } = fixture();
    const signal = new AbortController();
    deps.wait = async () => { signal.abort(new Error("SIGINT")); };
    await expect(runRelease(EXPECTED, deps, signal.signal)).rejects.toThrow("SIGINT");
    expect(deps.setPending).toHaveBeenLastCalledWith(false);
    expect(deps.createDeploy).not.toHaveBeenCalled();
  });
  it("clears an uncertain pause write and never creates a deployment", async () => {
    const { deps } = fixture();
    deps.setPending = vi.fn(async (on) => { if (on) throw new Error("lost response"); });
    await expect(runRelease(EXPECTED, deps)).rejects.toThrow("lost response");
    expect(deps.setPending).toHaveBeenLastCalledWith(false);
    expect(deps.createDeploy).not.toHaveBeenCalled();
  });
  it.each(["sha", "probe", "smoke"])("offers rollback after failed %s verification but never rolls back without confirmation", async (failure) => {
    const { deps } = fixture();
    if (failure === "sha") deps.readDeploy = async () => ({ id: "new", status: "live", commit: { id: "b".repeat(40) } });
    if (failure === "probe") deps.probeProviders = async () => false;
    if (failure === "smoke") deps.smoke = async () => { throw new Error("page failed"); };
    await expect(runRelease(EXPECTED, deps)).rejects.toThrow();
    expect(deps.confirm).toHaveBeenCalledWith("rollback", expect.any(String));
    expect(deps.rollback).not.toHaveBeenCalled();
    expect(deps.tag).not.toHaveBeenCalled();
    expect(deps.setPending).toHaveBeenLastCalledWith(false);
  });
  it("uses only the prior deploy for an explicitly confirmed rollback", async () => {
    const { deps } = fixture();
    deps.probeProviders = async () => false;
    deps.confirm = async (reason) => reason === "rollback";
    await expect(runRelease(EXPECTED, deps)).rejects.toThrow("probe");
    expect(deps.rollback).toHaveBeenCalledWith("old");
    expect(deps.setPending).toHaveBeenLastCalledWith(false);
  });
  it("does not offer rollback when only the local release tag fails", async () => {
    const { deps } = fixture();
    deps.tag = async () => { throw new Error("tag already exists"); };
    await expect(runRelease(EXPECTED, deps)).rejects.toThrow("tag already exists");
    expect(deps.confirm).not.toHaveBeenCalled();
    expect(deps.rollback).not.toHaveBeenCalled();
    expect(deps.setPending).toHaveBeenLastCalledWith(false);
  });
  it("asks after the idle timeout and a refusal never bypasses running packs", async () => {
    const { deps } = fixture();
    deps.health = async () => ({ ...health(deps.now()), details: { release: { appliedWhen: 1234, runningPacks: 1, checkedAt: new Date(deps.now()).toISOString() } } });
    await expect(runRelease(EXPECTED, deps)).rejects.toThrow("packs were running");
    expect(deps.confirm).toHaveBeenCalledWith("packs_running", expect.any(String));
    expect(deps.createDeploy).not.toHaveBeenCalled();
    expect(deps.setPending).toHaveBeenLastCalledWith(false);
  });
});
