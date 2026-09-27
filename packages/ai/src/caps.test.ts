import { describe, expect, it } from "vitest";
import { dailyWorkspaceCeilingMicros, InMemoryCapStore, SPEND_CAPS, SpendCaps } from "./caps";

function setup(startDate = "2026-09-27T10:00:00Z") {
  const state = { date: new Date(startDate) };
  const store = new InMemoryCapStore();
  const caps = new SpendCaps(store, () => state.date);
  return { state, store, caps };
}

describe("SpendCaps", () => {
  it("fixes the platform constants from section 4.4", () => {
    expect(SPEND_CAPS.perImageAssetMicros).toBe(600_000);
    expect(SPEND_CAPS.perVideoAssetMicros).toBe(3_000_000);
    expect(SPEND_CAPS.perPackMicros).toBe(8_000_000);
    expect(SPEND_CAPS.globalDailyAlertMicros).toBe(50_000_000);
    expect(SPEND_CAPS.globalDailyHardStopMicros).toBe(150_000_000);
    expect(dailyWorkspaceCeilingMicros(1_000_000)).toBe(3_000_000);
  });

  it("blocks the pack when cumulative cost would cross the cap", async () => {
    const { caps } = setup();
    expect((await caps.checkAndReservePack("job1", 5_000_000)).allowed).toBe(true);
    expect((await caps.checkAndReservePack("job1", 2_500_000)).allowed).toBe(true);

    const blocked = await caps.checkAndReservePack("job1", 1_000_000);
    expect(blocked.allowed).toBe(false);
    expect(blocked.reservedMicros).toBe(0);
    expect(blocked.totalMicros).toBe(7_500_000);
    expect(blocked.reason).toContain("cap");

    const exact = await caps.checkAndReservePack("job1", 500_000);
    expect(exact.allowed).toBe(true);
    expect(exact.totalMicros).toBe(8_000_000);
  });

  it("tracks packs independently and supports release", async () => {
    const { caps } = setup();
    const first = await caps.checkAndReservePack("job1", 8_000_000);
    expect(first.allowed).toBe(true);
    expect((await caps.checkAndReservePack("job2", 1_000_000)).allowed).toBe(true);

    expect((await caps.checkAndReservePack("job1", 1)).allowed).toBe(false);
    await caps.release(first.key, 2_000_000);
    expect((await caps.checkAndReservePack("job1", 2_000_000)).allowed).toBe(true);
  });

  it("enforces the per asset caps", async () => {
    const { caps } = setup();
    expect((await caps.checkAndReserveImageAsset("a1", 600_000)).allowed).toBe(true);
    expect((await caps.checkAndReserveImageAsset("a1", 1)).allowed).toBe(false);
    expect((await caps.checkAndReserveImageAsset("a2", 600_001)).allowed).toBe(false);

    expect((await caps.checkAndReserveVideoAsset("v1", 3_000_000)).allowed).toBe(true);
    expect((await caps.checkAndReserveVideoAsset("v1", 1)).allowed).toBe(false);
  });

  it("enforces the workspace daily ceiling and resets on a new day", async () => {
    const { caps, state } = setup();
    const plan = 1_000_000;
    expect((await caps.checkAndReserveWorkspaceDay("w1", plan, 3_000_000)).allowed).toBe(true);
    expect((await caps.checkAndReserveWorkspaceDay("w1", plan, 1)).allowed).toBe(false);
    expect((await caps.checkAndReserveWorkspaceDay("w2", plan, 1)).allowed).toBe(true);

    state.date = new Date("2026-09-28T10:00:00Z");
    expect((await caps.checkAndReserveWorkspaceDay("w1", plan, 3_000_000)).allowed).toBe(true);
  });

  it("alerts at the global daily line and hard stops at the ceiling", async () => {
    const { caps } = setup();
    const quiet = await caps.checkAndReserveGlobalDay(49_000_000);
    expect(quiet.allowed).toBe(true);
    expect(quiet.alert).toBeUndefined();

    const alerted = await caps.checkAndReserveGlobalDay(2_000_000);
    expect(alerted.allowed).toBe(true);
    expect(alerted.alert).toBe(true);

    const atStop = await caps.checkAndReserveGlobalDay(99_000_000);
    expect(atStop.allowed).toBe(true);
    expect(atStop.totalMicros).toBe(150_000_000);

    const blocked = await caps.checkAndReserveGlobalDay(1);
    expect(blocked.allowed).toBe(false);
    expect(blocked.alert).toBe(true);
  });

  it("rolls back when concurrent reservations overshoot", async () => {
    const store = new InMemoryCapStore();
    let injected = false;
    const racingStore = {
      async get(key: string) {
        const value = await store.get(key);
        if (!injected) {
          injected = true;
          await store.add(key, 7_000_000);
        }
        return value;
      },
      add: (key: string, delta: number) => store.add(key, delta),
    };
    const caps = new SpendCaps(racingStore);
    const result = await caps.checkAndReservePack("job1", 2_000_000);
    expect(result.allowed).toBe(false);
    expect(await store.get(result.key)).toBe(7_000_000);
  });

  it("rejects negative reservations", async () => {
    const { caps } = setup();
    await expect(caps.checkAndReservePack("job1", -1)).rejects.toThrow(/non negative/);
  });

  it("honors a raised global hard stop, the founder's env knob", async () => {
    const caps = new SpendCaps(new InMemoryCapStore(), () => new Date("2026-09-27T12:00:00Z"), {
      globalDailyHardStopMicros: 200_000_000,
    });
    const big = await caps.checkAndReserveGlobalDay(180_000_000);
    expect(big.allowed).toBe(true);
    expect(big.alert).toBe(true);
    const over = await caps.checkAndReserveGlobalDay(30_000_000);
    expect(over.allowed).toBe(false);
  });
});
