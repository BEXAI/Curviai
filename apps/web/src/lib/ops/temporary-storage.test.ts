import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Db } from "@curvi/db";
import { createTestDb } from "@curvi/db/testing";
import { dataRetention, freePreview, tmpObjectDays } from "@curvi/pipeline/seed";
import { isLegacyTemporaryKey, LEGACY_TMP_CURSOR, sweepLegacyTemporaryObjects } from "./temporary-storage";
const NOW=new Date("2026-10-02T12:00:00Z"),old=new Date(NOW.getTime()-(tmpObjectDays+1)*86_400_000);
let test:Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async()=>{test=await createTestDb();});
afterAll(async()=>{await test.client.close();});

describe("temporary storage migration",()=>{
 it("whitelists only legacy temporary objects, never sources, outputs or traversal",()=>{
  for(const path of ["cache/cutout/a.png","cache/preview/a.png","cache/carousel/j/a.png","preflight/a.jpg","jobs/j/handoff/run/a"])expect(isLegacyTemporaryKey(`ws/w/${path}`),path).toBe(true);
  for(const key of ["ws/w/src/a","ws/w/jobs/j/files/a","ws/w/out/a","tmp/ws/w/cache/cutout/a","ws/w/../cache/preview/a","anon/a"])expect(isLegacyTemporaryKey(key),key).toBe(false);
 });
 it("persists pagination across bounded runs, preserves failed pages, and leaves dry run unchanged",async()=>{
  const db=test.db as unknown as Db;
  const eligible={key:"ws/w/cache/cutout/a",bytes:3,lastModified:old};
  const objects=[eligible,...Array.from({length:dataRetention.batchSize-1},(_,i)=>({key:`ws/w/src/${i}`,bytes:3,lastModified:old}))];
  const listPage=vi.fn(async(cursor:string|null)=>cursor===null?{objects,nextCursor:"page2"}:{objects:[{...eligible,key:"ws/w/cache/preview/b"}],nextCursor:null});
  const deleteMany=vi.fn(async(_keys:string[])=>[] as string[]);
  const dry=await sweepLegacyTemporaryObjects({db,storage:{listPage,deleteMany},now:NOW,dryRun:true});
  expect(dry).toMatchObject({matched:1,deleted:0,cursor:"page2",complete:false});
  expect(deleteMany).not.toHaveBeenCalled();
  expect((await test.client.query("select * from platform_settings where key=$1",[LEGACY_TMP_CURSOR])).rows).toHaveLength(0);
  deleteMany.mockResolvedValueOnce([eligible.key]);
  const failed=await sweepLegacyTemporaryObjects({db,storage:{listPage,deleteMany},now:NOW});
  expect(failed).toMatchObject({failed:1,cursor:null});
  const first=await sweepLegacyTemporaryObjects({db,storage:{listPage,deleteMany},now:NOW});
  expect(first).toMatchObject({deleted:1,cursor:"page2",complete:false});
  const second=await sweepLegacyTemporaryObjects({db,storage:{listPage,deleteMany},now:NOW});
  expect(second).toMatchObject({deleted:1,cursor:null,complete:true});
  expect(listPage).toHaveBeenLastCalledWith("page2");
 });
 it("includes both seeded prefixes in the single bucket lifecycle file",()=>{
  const file=JSON.parse(readFileSync(resolve(process.cwd(),"../../ops/r2/lifecycle.json"),"utf8")) as {Rules:Array<{Status:string;Filter:{Prefix:string};Expiration:{Days:number}}>};
  expect(file.Rules.map(r=>[r.Filter.Prefix,r.Expiration.Days,r.Status])).toEqual([["anon/",freePreview.retentionDays,"Enabled"],["tmp/",tmpObjectDays,"Enabled"]]);
 });
});
