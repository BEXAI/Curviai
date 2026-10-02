import { deploy } from "@curvi/pipeline/seed";
import { OPS_SWITCH_CACHE_MS } from "../features";

export interface ReleaseHealth {
  status: "ok" | "degraded" | "down";
  mode: "db" | "demo";
  commit: string | null;
  checks: { schema: string; database: string };
  migrations: { applied: string | null };
  packs: { running: number } | null;
  details?: { release?: { appliedWhen: number | null; runningPacks: number | null; checkedAt: string } };
}
export interface RenderDeploy { id: string; status: string; commit?: { id: string } }
export interface ReleaseDeps {
  now(): number;
  wait(ms: number): Promise<void>;
  preflight(): Promise<{ sha: string; clean: boolean; pushed: boolean; ciPassed: boolean }>;
  health(): Promise<ReleaseHealth>;
  stagingSmoke?(sha: string): Promise<void>;
  setPending(on: boolean): Promise<void>;
  currentDeploy(): Promise<RenderDeploy>;
  disableAutoDeploy?(): Promise<void>;
  createDeploy(sha: string): Promise<RenderDeploy>;
  readDeploy(id: string): Promise<RenderDeploy>;
  probeProviders(): Promise<boolean>;
  smoke(): Promise<void>;
  confirm(reason: "packs_running" | "rollback", detail: string): Promise<boolean>;
  rollback(id: string): Promise<RenderDeploy>;
  tag(name: string, sha: string): Promise<void>;
  log(message: string): void;
}
export class ReleaseRefusal extends Error {}
export function assertMigrationApplied(applied: number | null | undefined, expected: { tag: string; when: number }): void {
  if (applied !== expected.when) throw new ReleaseRefusal(`The database has not confirmed ${expected.tag}. Run ops:migrate first.`);
}
function freshReleaseDetail(health: ReleaseHealth, now: number) {
  const detail = health.details?.release;
  const checked = Date.parse(detail?.checkedAt ?? "");
  if (!detail || !Number.isFinite(checked) || checked > now + 5_000 || now - checked > 60_000) throw new ReleaseRefusal("Fresh protected release health is unavailable. Confirm CRON_SECRET and deploy the health guard first.");
  return detail;
}
export function assertReleaseHealth(health: ReleaseHealth, sha?: string): void {
  if (health.mode !== "db" || health.status === "down" || health.checks.database !== "ok" || health.checks.schema !== "current") {
    throw new ReleaseRefusal("The application is not ready with a current database schema.");
  }
  if (sha && (health.commit === null || ![sha, sha.slice(0, 7)].includes(health.commit))) {
    throw new ReleaseRefusal("The application's commit does not match the release.");
  }
}

/** Side effects are injected so deploy, rollback and interruption paths run offline in tests. */
export async function runRelease(expectedMigration: { tag: string; when: number }, deps: ReleaseDeps, signal?: AbortSignal): Promise<{ sha: string; deployId: string; tag: string }> {
  const checkAbort = () => signal?.throwIfAborted();
  const pause = async (ms: number) => { checkAbort(); await deps.wait(ms); checkAbort(); };
  const preflight = await deps.preflight();
  checkAbort();
  if (!preflight.clean || !preflight.pushed || !preflight.ciPassed || !/^[a-f0-9]{40}$/.test(preflight.sha)) {
    throw new ReleaseRefusal("Release needs a clean tree, the exact HEAD pushed, and a successful CI run for that SHA.");
  }
  const health = await deps.health();
  assertMigrationApplied(freshReleaseDetail(health, deps.now()).appliedWhen, expectedMigration);
  assertReleaseHealth(health);
  await deps.stagingSmoke?.(preflight.sha);
  checkAbort();
  const previous = await deps.currentDeploy();
  if (previous.status !== "live") throw new ReleaseRefusal("No previous live deploy is available for rollback.");
  let mutationAttempted = false;
  let deploymentAttempted = false;
  let keepAliveAt = deps.now();
  const keepPending = async () => {
    // Refresh during long builds; each write still has the server's 30 minute expiry.
    if (deps.now() - keepAliveAt >= deploy.pendingMaxMinutes * 30_000) {
      await deps.setPending(true); keepAliveAt = deps.now();
    }
  };
  const waitLive = async (candidate: RenderDeploy) => {
    const until = deps.now() + 30 * 60_000;
    while (candidate.status !== "live") {
      checkAbort();
      if (["build_failed", "update_failed", "pre_deploy_failed", "canceled", "deactivated"].includes(candidate.status)) {
        throw new ReleaseRefusal(`Render deploy ended with ${candidate.status}.`);
      }
      if (deps.now() >= until) throw new ReleaseRefusal("Render deploy did not become live within 30 minutes.");
      await pause(5_000); await keepPending(); candidate = await deps.readDeploy(candidate.id);
    }
    return candidate;
  };
  try {
    // Clear even when the server accepted a write whose response was lost.
    mutationAttempted = true;
    await deps.setPending(true);
    await pause(OPS_SWITCH_CACHE_MS);
    let idleDeadline = deps.now() + deploy.idleWaitMinutes * 60_000;
    for (;;) {
      checkAbort();
      const idle = await deps.health();
      assertReleaseHealth(idle);
      const running = freshReleaseDetail(idle, deps.now()).runningPacks;
      if (running === null || !Number.isInteger(running) || running < 0) throw new ReleaseRefusal("Running pack count is unavailable.");
      if (running === 0) break;
      if (deps.now() >= idleDeadline) {
        // An affirmative answer extends the wait, never bypasses the drain.
        if (!(await deps.confirm("packs_running", "Packs are still running. Continue waiting?"))) throw new ReleaseRefusal("Release stopped while packs were running.");
        // The operator can leave this prompt open beyond the flag's expiry.
        await deps.setPending(true); keepAliveAt = deps.now();
        await pause(OPS_SWITCH_CACHE_MS);
        idleDeadline = deps.now() + deploy.idleWaitMinutes * 60_000;
      }
      await pause(5_000); await keepPending();
    }
    await deps.disableAutoDeploy?.();
    checkAbort();
    deploymentAttempted = true;
    const live = await waitLive(await deps.createDeploy(preflight.sha));
    if (live.commit?.id !== preflight.sha) throw new ReleaseRefusal("Render deployed a different commit.");
    const deployedHealth = await deps.health();
    assertReleaseHealth(deployedHealth, preflight.sha);
    assertMigrationApplied(freshReleaseDetail(deployedHealth, deps.now()).appliedWhen, expectedMigration);
    if (!(await deps.probeProviders())) throw new ReleaseRefusal("The provider health probe did not pass.");
    await deps.smoke();
    checkAbort();
    // A local tag error must never roll back a verified healthy deployment.
    deploymentAttempted = false;
    const stamp = new Date(deps.now()).toISOString().replace(/[-:]/g, "").slice(0, 13).replace("T", "-");
    const tag = `release-${stamp}`;
    await deps.tag(tag, preflight.sha);
    return { sha: preflight.sha, deployId: live.id, tag };
  } catch (error) {
    if (deploymentAttempted && !signal?.aborted && await deps.confirm("rollback", `Release verification failed. Roll back to ${previous.id}?`)) {
      await deps.setPending(true); keepAliveAt = deps.now();
      await pause(OPS_SWITCH_CACHE_MS);
      const beforeRollback = freshReleaseDetail(await deps.health(), deps.now());
      if (beforeRollback.runningPacks !== 0) throw new ReleaseRefusal("Packs are running again. Rollback was not started; wait for idle and retry from the operator console.");
      await waitLive(await deps.rollback(previous.id));
      deps.log(`Rollback to ${previous.id} became live. The release remains failed.`);
    }
    throw error;
  } finally {
    if (mutationAttempted) await deps.setPending(false);
  }
}
