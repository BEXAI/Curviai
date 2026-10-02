/**
 * Product features that exist in code but are not offered yet. A flag stays
 * false until the feature really works end to end in production, so the app
 * never offers something it cannot deliver (Phase 10 decision 1).
 */

import {
  opsSwitchDefaults,
  type OpsFlag,
  type OpsSwitchDefault,
  type OpsSwitchKey,
  type OpsSwitchValue,
} from "@curvi/pipeline/seed";

/**
 * Concept Mode (text only renders with a visible Concept render label) needs
 * a concept text to image recipe and the corner label overlay in the
 * pipeline. Neither ships yet: a text only pack would end with no files, and
 * a photo pack would deliver composites without the label. While this is
 * false the new pack form hides the Concept option and the service rejects
 * mode "concept". The UI and service code paths stay in place for the day it
 * flips.
 */
export const CONCEPT_MODE_AVAILABLE = false;

/**
 * Seller output options (docs/phases/PHASE_15.md): the Look, Remove the
 * background, Background color, Extra images and Photo shape controls on the
 * new pack form. Set NEXT_PUBLIC_OUTPUT_OPTIONS=1 per environment once the
 * Trigger.dev worker that honors the options is deployed (worker first, then
 * the web app, then the flag). Read at call time on the server, and inlined
 * at build time in the browser.
 */
export function outputOptionsAvailable(): boolean {
  return process.env.NEXT_PUBLIC_OUTPUT_OPTIONS === "1";
}

/** The env flag as the page saw it at build or boot. */
export const OUTPUT_OPTIONS_AVAILABLE = outputOptionsAvailable();

/** The platform_settings row that switched output options off at runtime
 * before P20-20. Since then the switch is ops:output_options_enabled, read
 * through opsSwitch (DbService.outputOptionsEnabled); migration
 * ops_switches_and_audit copied this row there and leaves it in place for a
 * rollback, and ops_switches_contract (Lane 5b) deletes it together with
 * this constant and outputOptionsSwitchOn. Nothing seeds it any more. */
export const OUTPUT_OPTIONS_SWITCH_KEY = "output_options_enabled";

/** How long a server process reuses the kill switch it read. */
export const OUTPUT_OPTIONS_SWITCH_CACHE_MS = 30_000;

const switchScope = globalThis as typeof globalThis & {
  __curviOutputOptionsSwitch?: { on: boolean; at: number };
};

/**
 * The kill switch, read through `read` (the stored platform_settings value,
 * or undefined when the row is missing) and cached per process for
 * OUTPUT_OPTIONS_SWITCH_CACHE_MS. Fails closed: only a stored true turns
 * options on, so a missing row, any other value or a failed read keeps them
 * off. The reader is injected so this module stays client safe. The reader
 * before P20-20, kept until ops_switches_contract; nothing in the app calls
 * it now.
 */
export async function outputOptionsSwitchOn(
  read: () => Promise<unknown>,
  now: () => number = Date.now,
): Promise<boolean> {
  const cached = switchScope.__curviOutputOptionsSwitch;
  if (cached && now() - cached.at < OUTPUT_OPTIONS_SWITCH_CACHE_MS) {
    return cached.on;
  }
  let on = false;
  try {
    on = (await read()) === true;
  } catch (err) {
    console.warn("[features] could not read the output options switch; treating it as off", err);
  }
  switchScope.__curviOutputOptionsSwitch = { on, at: now() };
  return on;
}

/** Forgets the cached kill switch (tests), the ops: one included, so tests
 * written against the old reader keep resetting the one in use. */
export function resetOutputOptionsSwitchForTests(): void {
  delete switchScope.__curviOutputOptionsSwitch;
  opsScope.__curviOpsSwitches?.delete("ops:output_options_enabled");
}

/**
 * Reads one stored platform_settings value: the parsed JSON, or undefined
 * when the row is missing. Throws when the read fails. Server code passes
 * platformSettingReader(db) from lib/platform-settings.ts.
 */
export type OpsSettingRead = (key: OpsSwitchKey) => Promise<unknown>;

/** How long a server process reuses an operator switch it read (principle 2). */
export const OPS_SWITCH_CACHE_MS = OUTPUT_OPTIONS_SWITCH_CACHE_MS;

const opsScope = globalThis as typeof globalThis & {
  __curviOpsSwitches?: Map<OpsSwitchKey, { value: unknown; at: number }>;
};

function opsCache(): Map<OpsSwitchKey, { value: unknown; at: number }> {
  opsScope.__curviOpsSwitches ??= new Map();
  return opsScope.__curviOpsSwitches;
}

const FLAG_TEXT_FIELDS = ["message", "setBy", "setAt", "expiresAt"] as const;

/** The stored value as the switch's kind, or undefined for a wrong shape. */
function parseOpsValue(kind: OpsSwitchDefault["kind"], stored: unknown): unknown {
  switch (kind) {
    case "boolean":
      return typeof stored === "boolean" ? stored : undefined;
    case "usd":
      return typeof stored === "number" && Number.isFinite(stored) && stored >= 0 ? stored : undefined;
    case "flag": {
      if (typeof stored !== "object" || stored === null || Array.isArray(stored)) {
        return undefined;
      }
      const record = stored as Record<string, unknown>;
      if (typeof record.on !== "boolean") {
        return undefined;
      }
      const flag: OpsFlag = { on: record.on };
      for (const field of FLAG_TEXT_FIELDS) {
        const text = record[field];
        if (text === undefined || text === null) continue;
        if (typeof text !== "string") return undefined;
        flag[field] = text;
      }
      return flag;
    }
  }
}

/** A flag past its expiresAt reads as off (ops:deploy_pending, P20-19). */
function applyExpiry(value: unknown, nowMs: number): unknown {
  const flag = value as OpsFlag | null;
  if (flag && typeof flag === "object" && flag.on && flag.expiresAt) {
    const expires = Date.parse(flag.expiresAt);
    if (Number.isFinite(expires) && expires <= nowMs) {
      return { ...flag, on: false };
    }
  }
  return value;
}

/**
 * An operator switch (docs/phases/PHASE_20.md P20-20, principle 2): the
 * value stored in platform_settings under its `ops:` key, or the seed's
 * opsSwitchDefaults entry. A missing row (or a stored JSON null) gives
 * `default`; a failed read or a value of the wrong shape gives
 * `onReadError` (kill switches fail closed, pauses fail open). A flag whose
 * expiresAt has passed reads as off. Cached per key and process for
 * OPS_SWITCH_CACHE_MS, failures included, like outputOptionsSwitchOn. The
 * reader is injected so this module stays client safe.
 */
export async function opsSwitch<K extends OpsSwitchKey>(
  key: K,
  read: OpsSettingRead,
  now: () => number = Date.now,
): Promise<OpsSwitchValue<K>> {
  const spec: OpsSwitchDefault = opsSwitchDefaults[key];
  const cache = opsCache();
  const cached = cache.get(key);
  const at = now();
  if (cached && at - cached.at < OPS_SWITCH_CACHE_MS) {
    return applyExpiry(cached.value, at) as OpsSwitchValue<K>;
  }
  let value: unknown;
  try {
    const stored = await read(key);
    if (stored === undefined || stored === null) {
      value = spec.default;
    } else {
      value = parseOpsValue(spec.kind, stored);
      if (value === undefined) {
        console.warn(`[features] the ${key} switch holds a value of the wrong shape; using its read error value`);
        value = spec.onReadError;
      }
    }
  } catch (err) {
    console.warn(`[features] could not read the ${key} switch; using its read error value`, err);
    value = spec.onReadError;
  }
  cache.set(key, { value, at });
  return applyExpiry(value, at) as OpsSwitchValue<K>;
}

/** Forgets cached operator switches: one key after an operator writes it,
 * or every key (tests). */
export function forgetOpsSwitch(key?: OpsSwitchKey): void {
  if (key) {
    opsScope.__curviOpsSwitches?.delete(key);
  } else {
    delete opsScope.__curviOpsSwitches;
  }
}
