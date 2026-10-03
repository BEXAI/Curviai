import { and, eq, inArray, retiredSourceObjects, sourceMedia, type Db } from "@curvi/db";
import { isWorkspaceObjectKey } from "@/lib/object-keys";

export type SourceTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

export class SourceUnavailableError extends Error {
  constructor() { super("The original photo is no longer available. Upload it again to continue."); }
}

/** Call only while holding this workspace's FOR UPDATE lock. Retirement is
 * committed before storage deletion and never undone, even on a timeout or
 * process crash, so a late R2 delete can never target a newly accepted pack. */
export async function assertSourceKeysAvailable(tx: Pick<SourceTransaction, "select">, workspaceId: string, keys: readonly string[]): Promise<void> {
  const distinct = [...new Set(keys)];
  if (distinct.some((key) => !isWorkspaceObjectKey(workspaceId, key))) throw new SourceUnavailableError();
  if (distinct.length && (await tx.select({ key: retiredSourceObjects.r2Key }).from(retiredSourceObjects)
    .where(and(eq(retiredSourceObjects.workspaceId, workspaceId), inArray(retiredSourceObjects.r2Key, distinct))).limit(1)).length) {
    throw new SourceUnavailableError();
  }
}

/** Revalidate a pre-lock source snapshot against the product it belongs to.
 * A row missing after purge won the lock must not be replaced from memory. */
export async function assertRegisteredSources(tx: Pick<SourceTransaction, "select">, workspaceId: string, productId: string, keys: readonly string[]): Promise<void> {
  const distinct = [...new Set(keys)];
  await assertSourceKeysAvailable(tx, workspaceId, distinct);
  if (distinct.length === 0) return;
  const found = await tx.select({ key: sourceMedia.r2Key }).from(sourceMedia)
    .where(and(eq(sourceMedia.workspaceId, workspaceId), eq(sourceMedia.productId, productId), inArray(sourceMedia.r2Key, distinct)));
  if (found.length !== distinct.length) throw new SourceUnavailableError();
}

/** The caller selected and rechecked every key while holding the workspace
 * lock. Keep these intentions forever (except the workspace's own cascade),
 * regardless of whether storage deletion succeeds or its response is lost. */
export async function retireSourceKeys(tx: Pick<SourceTransaction, "insert">, workspaceId: string, keys: readonly string[]): Promise<void> {
  const distinct = [...new Set(keys)];
  if (distinct.some((key) => !isWorkspaceObjectKey(workspaceId, key))) throw new SourceUnavailableError();
  if (distinct.length) await tx.insert(retiredSourceObjects).values(distinct.map((r2Key) => ({ workspaceId, r2Key }))).onConflictDoNothing();
}
