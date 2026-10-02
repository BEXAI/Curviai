import { beforeEach, expect, it, vi } from "vitest";
import type { CronJobContext } from "@/lib/cron-health";
const invoke = vi.hoisted(() => vi.fn());
vi.mock("../purge-source-media/route", () => ({ POST: invoke }));
vi.mock("../billing-reconcile/route", () => ({ POST: invoke }));
vi.mock("../lifecycle/route", () => ({ POST: invoke }));
import { runScheduledJob } from "./jobs";

beforeEach(() => { invoke.mockReset(); });
it("rejects partial cleanup, failed sends and a truncated billing scan before tick freshness advances", async () => {
  for (const [name, body] of [
    ["purge-source-media", { ok: true, report: { objectsFailed: 1 } }],
    ["lifecycle", { ok: true, report: { failed: 1 } }],
    ["billing-reconcile", { ok: true, failed: [], truncated: true }],
  ] as const) {
    invoke.mockResolvedValueOnce(Response.json(body));
    await expect(runScheduledJob(name, {} as CronJobContext)).rejects.toThrow(/failed/);
  }
});
it("marks skipped optional work as skipped while accepting an unconfigured billing account", async () => {
  invoke.mockResolvedValueOnce(Response.json({ ok: true, skipped: "disabled" }));
  await expect(runScheduledJob("lifecycle", {} as CronJobContext)).rejects.toThrow(/disabled/);
  invoke.mockResolvedValueOnce(Response.json({ ok: true, skipped: "No Stripe key" }));
  await expect(runScheduledJob("billing-reconcile", {} as CronJobContext)).resolves.toBeUndefined();
});
