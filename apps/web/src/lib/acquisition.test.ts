import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@curvi/db";
import { events } from "@curvi/db/schema";
import { createTestDb } from "@curvi/db/testing";
import { acquisitionGate, falBalanceLines, falBalanceProbePolicy } from "@curvi/pipeline/seed";
import {
  ACQUISITION_STATE_SETTING,
  acquisitionStatus,
  configuredCutoutAccounts,
  demoAcquisition,
  evaluateAcquisition,
  noteChange,
  readManualPause,
  recordAcquisitionChange,
  resetAcquisitionForTests,
  type AcquisitionInputs,
} from "./acquisition";

// The acquisition gate (docs/phases/PHASE_18.md P18-03): each input that
// closes it, the cache, and a change recorded once across processes.

const NOW = Date.parse("2026-10-01T12:00:00Z");
const fresh = new Date(NOW - 10 * 60_000).toISOString();
const stale = new Date(NOW - (falBalanceProbePolicy.staleAfterMinutes + 1) * 60_000).toISOString();
const below = falBalanceLines.pauseUsd - 0.5;
const above = falBalanceLines.pauseUsd + 0.5;

function inputs(overrides: Partial<AcquisitionInputs> = {}): AcquisitionInputs {
  return { manualPause: false, preflight: "ok", cutoutBalances: [], now: NOW, ...overrides };
}

describe("evaluateAcquisition", () => {
  it("is open when nothing closes it", () => {
    expect(evaluateAcquisition(inputs())).toEqual({ state: "open", reason: null });
    expect(evaluateAcquisition(inputs({ preflight: "scenes_paused" }))).toEqual({ state: "open", reason: null });
  });

  it("waitlists on the founder's switch, before anything else", () => {
    expect(evaluateAcquisition(inputs({ manualPause: true, preflight: "packs_paused" }))).toEqual({
      state: "waitlist",
      reason: "manual",
    });
  });

  it("waitlists while the preflight pauses packs", () => {
    expect(evaluateAcquisition(inputs({ preflight: "packs_paused" }))).toEqual({ state: "waitlist", reason: "packs_paused" });
  });

  it("waitlists only when every configured cutout account is fresh and below the pause line", () => {
    const a = { provider: "fal-birefnet", balanceUsd: below, balanceAt: fresh };
    const b = { provider: "fal-birefnet-backup", balanceUsd: below, balanceAt: fresh };
    expect(evaluateAcquisition(inputs({ cutoutBalances: [a] }))).toEqual({ state: "waitlist", reason: "fal_balance" });
    expect(evaluateAcquisition(inputs({ cutoutBalances: [a, b] })).state).toBe("waitlist");
    // The backup still has money.
    expect(evaluateAcquisition(inputs({ cutoutBalances: [a, { ...b, balanceUsd: above }] })).state).toBe("open");
    // An account nobody can read never counts as below.
    expect(evaluateAcquisition(inputs({ cutoutBalances: [a, { ...b, balanceUsd: null, balanceAt: null }] })).state).toBe("open");
    // A reading older than the stale line no longer counts (a stopped cron).
    expect(evaluateAcquisition(inputs({ cutoutBalances: [{ ...a, balanceAt: stale }] })).state).toBe("open");
    // Exactly at the line is not below it.
    expect(evaluateAcquisition(inputs({ cutoutBalances: [{ ...a, balanceUsd: falBalanceLines.pauseUsd }] })).state).toBe("open");
  });
});

describe("demo mode and configuration", () => {
  it("is open in demo mode unless CURVI_DEMO_ACQUISITION=waitlist", () => {
    expect(demoAcquisition(() => undefined)).toEqual({ state: "open", reason: null });
    expect(demoAcquisition(() => "waitlist")).toEqual({ state: "waitlist", reason: "demo" });
    expect(demoAcquisition(() => " WAITLIST ")).toEqual({ state: "waitlist", reason: "demo" });
    expect(demoAcquisition(() => "yes")).toEqual({ state: "open", reason: null });
  });

  it("counts a cutout account as configured by its inference key", () => {
    expect(configuredCutoutAccounts((n) => (n === "FAL_KEY" ? "k" : undefined)).map((a) => a.provider)).toEqual(["fal-birefnet"]);
    expect(configuredCutoutAccounts(() => undefined)).toEqual([]);
  });
});

describe("acquisitionStatus cache", () => {
  afterEach(() => resetAcquisitionForTests());

  it("reuses the gate for the seeded cache seconds, and fresh skips the cache", async () => {
    let clock = NOW;
    let mode = "waitlist";
    const deps = { now: () => clock, readEnv: (n: string) => (n === "CURVI_DEMO_ACQUISITION" ? mode : undefined) };
    expect((await acquisitionStatus(deps)).state).toBe("waitlist");
    mode = "open";
    clock += (acquisitionGate.cacheSeconds - 1) * 1000;
    expect((await acquisitionStatus(deps)).state).toBe("waitlist");
    expect((await acquisitionStatus({ ...deps, fresh: true })).state).toBe("open");
    mode = "waitlist";
    clock += 2_000;
    expect((await acquisitionStatus(deps)).state).toBe("open");
    clock += acquisitionGate.cacheSeconds * 1000;
    expect((await acquisitionStatus(deps)).state).toBe("waitlist");
  });
});

describe("recording a change", () => {
  let created: Awaited<ReturnType<typeof createTestDb>>;
  let db: Db;

  beforeAll(async () => {
    created = await createTestDb();
    db = created.db as unknown as Db;
  });

  afterAll(async () => {
    await created.client.close();
  });

  it("reads only a stored true as the founder's pause", async () => {
    expect(await readManualPause(db)).toBe(false);
    await created.client.query(`insert into platform_settings (key, value) values ('ops:acquisition_paused', 'false'::jsonb)`);
    expect(await readManualPause(db)).toBe(false);
    await created.client.query(`update platform_settings set value = 'true'::jsonb where key = 'ops:acquisition_paused'`);
    expect(await readManualPause(db)).toBe(true);
    await created.client.query(`update platform_settings set value = '"true"'::jsonb where key = 'ops:acquisition_paused'`);
    expect(await readManualPause(db)).toBe(false);
  });

  it("takes a first open reading as a baseline, then records each change once", async () => {
    const open = { state: "open", reason: null } as const;
    const paused = { state: "waitlist", reason: "fal_balance" } as const;
    expect(await recordAcquisitionChange(db, open)).toBe(false);
    expect(await recordAcquisitionChange(db, open)).toBe(false);
    expect(await recordAcquisitionChange(db, paused)).toBe(true);
    // A second process computing the same pause does not record it again.
    expect(await recordAcquisitionChange(db, paused)).toBe(false);
    expect(await recordAcquisitionChange(db, open)).toBe(true);
    const row = await created.client.query<{ value: { state: string } }>(`select value from platform_settings where key = $1`, [
      ACQUISITION_STATE_SETTING,
    ]);
    expect(row.rows[0].value.state).toBe("open");
  });

  it("writes the funnel event for a pause and a resume, with no workspace", async () => {
    await created.client.query(`delete from platform_settings where key = $1`, [ACQUISITION_STATE_SETTING]);
    await created.client.query(`delete from events`);
    const silent = { warn: () => {}, error: () => {} };
    await noteChange(db, { state: "waitlist", reason: "manual" }, new Date(NOW), silent);
    await noteChange(db, { state: "waitlist", reason: "manual" }, new Date(NOW + 1000), silent);
    await noteChange(db, { state: "open", reason: null }, new Date(NOW + 2000), silent);
    const rows = await created.db.select().from(events);
    expect(rows.map((r) => [r.name, r.workspaceId, r.props])).toEqual([
      ["funnel.acquisition_paused", null, { reason: "manual" }],
      ["funnel.acquisition_resumed", null, { reason: null }],
    ]);
  });
});
