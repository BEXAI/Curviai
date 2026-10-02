/**
 * Reads one platform_settings row over the owner connection, for the
 * operator switch reader opsSwitch (lib/features.ts) and anything else that
 * needs a single stored value. Server only: it imports the database client,
 * which features.ts must not.
 */

import { eq, platformSettings, type Db } from "@curvi/db";

/** The stored JSON value of `key`, or undefined when the row is missing.
 * Throws when the read fails, so the caller picks its fallback. */
export async function readPlatformSetting(db: Pick<Db, "select">, key: string): Promise<unknown> {
  const [row] = await db
    .select({ value: platformSettings.value })
    .from(platformSettings)
    .where(eq(platformSettings.key, key))
    .limit(1);
  return row?.value;
}

/** A reader bound to `db`, the shape opsSwitch takes:
 * `opsSwitch("ops:packs_paused", platformSettingReader(getDb()))`. */
export function platformSettingReader(db: Pick<Db, "select">): (key: string) => Promise<unknown> {
  return (key) => readPlatformSetting(db, key);
}
