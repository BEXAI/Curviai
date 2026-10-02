/** Cursor-based cleanup for only the old temporary namespaces. */
import { ListObjectsV2Command } from "@aws-sdk/client-s3";
import { sql, type Db } from "@curvi/db";
import { dataRetention, tmpObjectDays } from "@curvi/pipeline/seed";
import { privateBucket, r2Client } from "@/lib/r2";
import { r2TrustStorage, type StoredObjectInfo } from "@/lib/trust/storage";

export const LEGACY_TMP_CURSOR = "r2:legacy_tmp:cursor";
const rowsOf = <T>(r: unknown): T[] => (Array.isArray(r) ? r : (r as { rows?: T[] })?.rows ?? []) as T[];

export function isLegacyTemporaryKey(key: string): boolean {
  if (key.includes("..") || key.includes("\\")) return false;
  return /^ws\/[^/]+\/(?:cache\/(?:cutout|preview|carousel)\/|preflight\/|jobs\/[^/]+\/handoff\/).+/.test(key);
}
export interface LegacyTmpStorage {
  listPage(cursor: string | null): Promise<{ objects: StoredObjectInfo[]; nextCursor: string | null }>;
  deleteMany(keys: string[]): Promise<string[]>;
}
export function legacyTmpStorage(): LegacyTmpStorage {
  const client = r2Client();
  const storage = r2TrustStorage();
  return {
    async listPage(cursor) {
      const result = await client.send(new ListObjectsV2Command({ Bucket: privateBucket(), Prefix: "ws/", ContinuationToken: cursor ?? undefined, MaxKeys: 1000 }));
      return {
        objects: (result.Contents ?? []).flatMap(item => item.Key ? [{key:item.Key,bytes:Number(item.Size ?? 0),lastModified:item.LastModified ?? null}] : []),
        nextCursor: result.IsTruncated ? result.NextContinuationToken ?? null : null,
      };
    },
    deleteMany: keys => storage.deleteMany(keys),
  };
}

export async function sweepLegacyTemporaryObjects(options: {
  db: Db; storage: LegacyTmpStorage; now?: Date; dryRun?: boolean; deadline?: Date; clock?: () => number;
}) {
  const {db,storage,dryRun=false,clock=Date.now}=options;
  const now=options.now ?? new Date();
  const cutoff=new Date(now.getTime()-tmpObjectDays*86_400_000);
  const deadline=Math.min(options.deadline?.getTime() ?? Infinity,clock()+dataRetention.budgetSeconds*1000);
  const saved=rowsOf<{value:{cursor?:string}}>(await db.execute(sql`select value from platform_settings where key=${LEGACY_TMP_CURSOR}`))[0];
  let cursor=saved?.value?.cursor ?? null;
  const report={dryRun,scanned:0,matched:0,deleted:0,failed:0,complete:false,cursor};
  do {
    if(clock()>=deadline || report.scanned>=dataRetention.batchSize) break;
    const page=await storage.listPage(cursor);
    report.scanned+=page.objects.length;
    const keys=page.objects.filter(item=>item.lastModified!==null && item.lastModified<cutoff && isLegacyTemporaryKey(item.key)).map(item=>item.key);
    report.matched+=keys.length;
    const failed=dryRun?[]:await storage.deleteMany(keys);
    report.failed+=failed.length;
    if(!dryRun) report.deleted+=keys.length-failed.length;
    // A failed delete holds this page for the next run; never skip data.
    if(failed.length>0) break;
    cursor=page.nextCursor;
    report.complete=cursor===null;
    if(!dryRun) await db.execute(sql`insert into platform_settings(key,value,updated_at)
      values(${LEGACY_TMP_CURSOR},${JSON.stringify({cursor,at:now.toISOString()})}::jsonb,${now.toISOString()}::timestamptz)
      on conflict(key) do update set value=excluded.value,updated_at=excluded.updated_at`);
  } while(cursor!==null);
  report.cursor=cursor;
  return report;
}
