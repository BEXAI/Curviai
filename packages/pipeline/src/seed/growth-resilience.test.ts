import { describe, expect, it } from "vitest";
import { platformSettingSeedRows } from "./credits";
import { opsSwitchDefaults } from "./operations";
import {
  ACQUISITION_PAUSED_SETTING,
  DEPLOY_RESTARTS_SETTING,
  acquisitionGate,
  deployRestarts,
  growthPlatformSettingSeedRows,
  resilienceSwitches,
} from "./growth";
import { cutoutModelSeedRows } from "./models";
import { falBalanceAccounts, falBalanceLines, falBalanceProbePolicy } from "./monitoring";
import * as seed from "./index";

// Lane 2 Resilience seed (docs/phases/PHASE_18.md P18-03 and P18-23, founder
// decision 8). The numbers are the decision defaults; a change is a seed
// change, never code (CLAUDE.md rule 2).

describe("fal balance lines (decision 8)", () => {
  it("alerts below $15 and pauses acquisition below $3", () => {
    expect(falBalanceLines).toEqual({ alertUsd: 15, pauseUsd: 3 });
    expect(falBalanceLines.pauseUsd).toBeLessThan(falBalanceLines.alertUsd);
  });

  it("probes one admin key per cutout account, matched to the chain's keys", () => {
    expect(falBalanceAccounts.map((a) => [a.adminKeyEnv, a.keyEnv])).toEqual([
      ["FAL_ADMIN_KEY", "FAL_KEY"],
      ["FAL_ADMIN_KEY_BACKUP", "FAL_KEY_BACKUP"],
    ]);
    for (const account of falBalanceAccounts) {
      const row = cutoutModelSeedRows.find((r) => r.providerName === account.provider);
      expect(row?.keyEnv, account.provider).toBe(account.keyEnv);
    }
  });

  it("times a probe out after 5 seconds and writes a balance event at most hourly", () => {
    expect(falBalanceProbePolicy.timeoutMs).toBe(5_000);
    expect(falBalanceProbePolicy.eventEveryMinutes).toBe(60);
    expect(falBalanceProbePolicy.staleAfterMinutes).toBeGreaterThan(15);
  });

  it("is reachable through the seed index", () => {
    expect(seed.falBalanceLines).toBe(falBalanceLines);
    expect(seed.falBalanceAccounts).toBe(falBalanceAccounts);
    expect(seed.deployRestarts).toBe(deployRestarts);
    expect(seed.acquisitionGate).toBe(acquisitionGate);
  });
});

describe("acquisition gate", () => {
  it("switches every call to action within 60 seconds of a pause", () => {
    expect(acquisitionGate.cacheSeconds + acquisitionGate.statusMaxAgeSeconds).toBeLessThanOrEqual(60);
  });

  it("ships acquisition_paused off as an operator switch the seed never writes", () => {
    // P20-20: an operator switch under its ops: key, never seeded, so no
    // later seed resets it; a missing row reads as the default.
    expect(resilienceSwitches).toEqual([]);
    expect(growthPlatformSettingSeedRows.filter((row) => row.key.endsWith("acquisition_paused"))).toEqual([]);
    expect(platformSettingSeedRows.filter((row) => row.key.endsWith("acquisition_paused"))).toEqual([]);
    expect(opsSwitchDefaults[ACQUISITION_PAUSED_SETTING]).toMatchObject({ default: false, onReadError: false });
  });
});

describe("deploy restarts", () => {
  it("restarts a pack once, and looks for restarted packs every 30 seconds", () => {
    expect(deployRestarts.max).toBe(1);
    expect(deployRestarts.pickupIntervalSeconds).toBe(30);
    expect(deployRestarts.pickupBatch).toBeGreaterThan(0);
  });

  it("ships switched off until its gate, an operator switch the seed never writes", () => {
    // P20-20: an operator switch under its ops: key, never seeded, so no
    // later seed resets it; a missing row reads as the default.
    expect(platformSettingSeedRows.filter((row) => row.key.endsWith("deploy_restarts_enabled"))).toEqual([]);
    expect(opsSwitchDefaults[DEPLOY_RESTARTS_SETTING]).toMatchObject({ default: false, onReadError: false });
  });
});
