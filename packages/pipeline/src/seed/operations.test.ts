import { describe, expect, it } from "vitest";
import * as seed from "./index";
import {
  OPS_SWITCH_PREFIX,
  isOpsSwitchKey,
  opsGrants,
  opsSwitchDefaults,
  opsSwitchLegacyKeys,
  type OpsSwitchDefault,
} from "./operations";

// docs/phases/PHASE_20.md P20-20 and principle 2: operator switches live
// under ops: keys, fall back to opsSwitchDefaults, and are never seeded.

function holdsKind(kind: OpsSwitchDefault["kind"], value: unknown): boolean {
  switch (kind) {
    case "boolean":
      return typeof value === "boolean";
    case "flag":
      return typeof value === "object" && value !== null && typeof (value as { on?: unknown }).on === "boolean";
    case "usd":
      return value === null || (typeof value === "number" && Number.isFinite(value) && value >= 0);
  }
}

describe("opsSwitchDefaults", () => {
  const entries = Object.entries(opsSwitchDefaults) as Array<[string, OpsSwitchDefault]>;

  it("keys every switch under the ops: prefix", () => {
    expect(entries.length).toBeGreaterThan(0);
    for (const [key] of entries) {
      expect(key.startsWith(OPS_SWITCH_PREFIX)).toBe(true);
      expect(isOpsSwitchKey(key)).toBe(true);
    }
    expect(isOpsSwitchKey("output_options_enabled")).toBe(false);
    expect(isOpsSwitchKey("ops:unknown")).toBe(false);
    expect(isOpsSwitchKey("toString")).toBe(false);
  });

  it("gives each switch a default and a read error value of its kind", () => {
    for (const [, spec] of entries) {
      expect(holdsKind(spec.kind, spec.default)).toBe(true);
      expect(holdsKind(spec.kind, spec.onReadError)).toBe(true);
    }
  });

  it("keeps kill switches failing closed and pauses failing open", () => {
    expect(opsSwitchDefaults["ops:output_options_enabled"]).toMatchObject({ default: true, onReadError: false });
    expect(opsSwitchDefaults["ops:free_preview_enabled"].onReadError).toBe(false);
    expect(opsSwitchDefaults["ops:packs_paused"].onReadError).toEqual({ on: false });
    expect(opsSwitchDefaults["ops:deploy_pending"].onReadError).toEqual({ on: false });
    expect(opsSwitchDefaults["ops:global_hard_stop_usd"]).toMatchObject({ default: null, onReadError: null });
  });

  it("is never seeded", () => {
    expect(seed.platformSettingSeedRows.filter((row) => row.key.startsWith(OPS_SWITCH_PREFIX))).toEqual([]);
  });

  it("maps each switch that had another key to it, and the seed never writes that old key", () => {
    const legacy = Object.entries(opsSwitchLegacyKeys);
    expect(legacy.length).toBeGreaterThan(0);
    for (const [key, old] of legacy) {
      expect(isOpsSwitchKey(key)).toBe(true);
      expect(key).toBe(`${OPS_SWITCH_PREFIX}${old}`);
    }
    expect(new Set(legacy.map(([, old]) => old)).size).toBe(legacy.length);
    // A switch has one home: once it moved to ops:, a seeded old row would
    // be a second value nobody reads (P20-20). PHASE_18's keepStored rows
    // for these keys leave growth.ts when the phases are combined.
    const oldKeys = new Set<string>(legacy.map(([, old]) => old));
    expect(seed.platformSettingSeedRows.filter((row) => oldKeys.has(row.key))).toEqual([]);
    expect(seed.platformSettingSeedRows.some((row) => row.key === "output_options_enabled")).toBe(false);
  });

  it("is exported from the seed index with the other Phase 20 seed files", () => {
    expect(seed.opsSwitchDefaults).toBe(opsSwitchDefaults);
    expect(seed.OPS_SWITCH_PREFIX).toBe("ops:");
  });
});

describe("opsGrants (P20-66 operator credit grant caps)", () => {
  it("caps one grant and the month with positive whole credits, one grant within the month", () => {
    expect(Number.isInteger(opsGrants.maxCreditsPerGrant)).toBe(true);
    expect(Number.isInteger(opsGrants.maxCreditsPerMonth)).toBe(true);
    expect(opsGrants.maxCreditsPerGrant).toBeGreaterThan(0);
    expect(opsGrants.maxCreditsPerGrant).toBeLessThanOrEqual(opsGrants.maxCreditsPerMonth);
  });

  it("is exported from the seed index", () => {
    expect(seed.opsGrants).toBe(opsGrants);
  });
});
