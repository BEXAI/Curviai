/**
 * The store image audit's runtime switch (P18-18). It ships off: the
 * platform_settings row store_audit_enabled is seeded false (growth.ts,
 * Lane 7) until Release 4 and the reviewer pass on its server side
 * fetches. While it is off the page and the route answer 404.
 *
 * Read the cached reader way of lib/features.ts outputOptionsSwitchOn:
 * once per process every STORE_AUDIT_SWITCH_CACHE_MS, failing closed (a
 * missing row, any value but true, or a failed read keeps it off). The
 * in memory demo has no platform_settings table, so the audit is on there
 * (demo mode never runs in production; see services/demo-mode.ts), which
 * lets the e2e suite and local development use it.
 */

import { eq, platformSettings } from "@curvi/db";
import { STORE_AUDIT_SWITCH_KEY } from "@curvi/pipeline/seed";
import { isDbMode } from "@/lib/services";
import { demoModeAllowed } from "@/lib/services/demo-mode";
import { getDb } from "@/lib/services/db";

export const STORE_AUDIT_SWITCH_CACHE_MS = 30_000;

const switchScope = globalThis as typeof globalThis & {
  __curviStoreAuditSwitch?: { on: boolean; at: number };
};

/**
 * The switch, read through `read` (the stored value, or undefined when the
 * row is missing). The reader is injected so this stays testable.
 */
export async function storeAuditSwitchOn(read: () => Promise<unknown>, now: () => number = Date.now): Promise<boolean> {
  const cached = switchScope.__curviStoreAuditSwitch;
  if (cached && now() - cached.at < STORE_AUDIT_SWITCH_CACHE_MS) {
    return cached.on;
  }
  let on = false;
  try {
    on = (await read()) === true;
  } catch (err) {
    console.warn("[store-audit] could not read the store audit switch; treating it as off", err);
  }
  switchScope.__curviStoreAuditSwitch = { on, at: now() };
  return on;
}

/** Forgets the cached switch (tests). */
export function resetStoreAuditSwitchForTests(): void {
  delete switchScope.__curviStoreAuditSwitch;
}

/**
 * True when the store audit may run: the seeded switch in db mode, and in
 * the in memory demo only where demo mode is allowed (not production
 * without ALLOW_DEMO_MODE=1). A production server that lost its database
 * settings therefore never opens the audit's server side fetches.
 */
export async function storeAuditEnabled(): Promise<boolean> {
  if (!isDbMode()) {
    return demoModeAllowed();
  }
  return storeAuditSwitchOn(async () => {
    const [row] = await getDb()
      .select({ value: platformSettings.value })
      .from(platformSettings)
      .where(eq(platformSettings.key, STORE_AUDIT_SWITCH_KEY))
      .limit(1);
    return row?.value;
  });
}
