import { afterEach, describe, expect, it, vi } from "vitest";
import { opsSwitchDefaults } from "@curvi/pipeline/seed";
import {
  OPS_SWITCH_CACHE_MS,
  OUTPUT_OPTIONS_SWITCH_CACHE_MS,
  forgetOpsSwitch,
  opsSwitch,
  outputOptionsAvailable,
  outputOptionsSwitchOn,
  resetOutputOptionsSwitchForTests,
} from "./features";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  resetOutputOptionsSwitchForTests();
  forgetOpsSwitch();
});

describe("outputOptionsAvailable (NEXT_PUBLIC_OUTPUT_OPTIONS)", () => {
  it("is on only for exactly 1", () => {
    vi.stubEnv("NEXT_PUBLIC_OUTPUT_OPTIONS", "1");
    expect(outputOptionsAvailable()).toBe(true);
    for (const value of ["0", "", "true", "yes", " 1"]) {
      vi.stubEnv("NEXT_PUBLIC_OUTPUT_OPTIONS", value);
      expect(outputOptionsAvailable()).toBe(false);
    }
  });

  it("is off when the variable is unset", () => {
    vi.stubEnv("NEXT_PUBLIC_OUTPUT_OPTIONS", undefined as unknown as string);
    expect(outputOptionsAvailable()).toBe(false);
  });
});

describe("outputOptionsSwitchOn (the output_options_enabled kill switch)", () => {
  it("is on only for a stored true, and fails closed on a missing row, another value or a failed read", async () => {
    expect(await outputOptionsSwitchOn(async () => true)).toBe(true);
    for (const value of [false, undefined, null, "true", 1]) {
      resetOutputOptionsSwitchForTests();
      expect(await outputOptionsSwitchOn(async () => value)).toBe(false);
    }
    resetOutputOptionsSwitchForTests();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(
      await outputOptionsSwitchOn(async () => {
        throw new Error("connection lost");
      }),
    ).toBe(false);
  });

  it("reuses the value it read for a short while, then reads again", async () => {
    let now = 1_000;
    const read = vi.fn(async () => true);
    expect(await outputOptionsSwitchOn(read, () => now)).toBe(true);
    now += OUTPUT_OPTIONS_SWITCH_CACHE_MS - 1;
    expect(await outputOptionsSwitchOn(async () => false, () => now)).toBe(true);
    expect(read).toHaveBeenCalledTimes(1);
    now += 2;
    expect(await outputOptionsSwitchOn(async () => false, () => now)).toBe(false);
  });
});

describe("opsSwitch (operator switches under ops: keys, P20-20)", () => {
  const missing = async () => undefined;
  const failing = async () => {
    throw new Error("connection lost");
  };

  it("reads every key's seed default when no row is stored", async () => {
    for (const [key, spec] of Object.entries(opsSwitchDefaults)) {
      forgetOpsSwitch();
      expect(await opsSwitch(key as keyof typeof opsSwitchDefaults, missing)).toEqual(spec.default);
    }
    forgetOpsSwitch();
    expect(await opsSwitch("ops:global_hard_stop_usd", async () => null)).toBeNull();
  });

  it("reads every key's read error value when the read fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const [key, spec] of Object.entries(opsSwitchDefaults)) {
      forgetOpsSwitch();
      expect(await opsSwitch(key as keyof typeof opsSwitchDefaults, failing)).toEqual(spec.onReadError);
    }
  });

  it("returns a stored value of the right shape and the read error value for any other", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await opsSwitch("ops:acquisition_paused", async () => true)).toBe(true);
    forgetOpsSwitch();
    expect(await opsSwitch("ops:output_options_enabled", async () => "true")).toBe(false);
    forgetOpsSwitch();
    expect(await opsSwitch("ops:global_hard_stop_usd", async () => 25)).toBe(25);
    for (const bad of [-1, Number.NaN, "25"]) {
      forgetOpsSwitch();
      expect(await opsSwitch("ops:global_hard_stop_usd", async () => bad)).toBeNull();
    }
    forgetOpsSwitch();
    expect(
      await opsSwitch("ops:packs_paused", async () => ({ on: true, message: "Back soon", setBy: "ops@curvi.ai", extra: 1 })),
    ).toEqual({ on: true, message: "Back soon", setBy: "ops@curvi.ai" });
    for (const bad of [true, [], { on: "yes" }, { on: true, message: 3 }]) {
      forgetOpsSwitch();
      expect(await opsSwitch("ops:packs_paused", async () => bad)).toEqual({ on: false });
    }
    expect(warn).toHaveBeenCalled();
  });

  it("reads a flag as off once its expiresAt has passed, even from the cache", async () => {
    let now = Date.parse("2026-10-01T12:00:00Z");
    const stored = { on: true, setAt: "2026-10-01T11:55:00Z", expiresAt: "2026-10-01T12:00:10Z", setBy: "release" };
    expect((await opsSwitch("ops:deploy_pending", async () => stored, () => now)).on).toBe(true);
    now += 10_000;
    const read = vi.fn(async () => stored);
    expect(await opsSwitch("ops:deploy_pending", read, () => now)).toEqual({ ...stored, on: false });
    expect(read).not.toHaveBeenCalled();
  });

  it("reuses the value it read per key for a short while, and forgets one key on request", async () => {
    let now = 1_000;
    const read = vi.fn(async () => true);
    expect(await opsSwitch("ops:referrals_enabled", read, () => now)).toBe(true);
    now += OPS_SWITCH_CACHE_MS - 1;
    expect(await opsSwitch("ops:referrals_enabled", async () => false, () => now)).toBe(true);
    expect(await opsSwitch("ops:lifecycle_email_enabled", async () => true, () => now)).toBe(true);
    expect(read).toHaveBeenCalledTimes(1);
    forgetOpsSwitch("ops:referrals_enabled");
    expect(await opsSwitch("ops:referrals_enabled", async () => false, () => now)).toBe(false);
    expect(await opsSwitch("ops:lifecycle_email_enabled", async () => false, () => now)).toBe(true);
    now += OPS_SWITCH_CACHE_MS;
    expect(await opsSwitch("ops:lifecycle_email_enabled", async () => false, () => now)).toBe(false);
  });

  it("passes its own key to the reader", async () => {
    const read = vi.fn(async () => undefined);
    await opsSwitch("ops:background_white_or_clear", read);
    expect(read).toHaveBeenCalledWith("ops:background_white_or_clear");
  });
});
