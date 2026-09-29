import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OUTPUT_OPTIONS_SWITCH_CACHE_MS,
  outputOptionsAvailable,
  outputOptionsSwitchOn,
  resetOutputOptionsSwitchForTests,
} from "./features";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  resetOutputOptionsSwitchForTests();
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
