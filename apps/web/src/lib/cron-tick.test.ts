import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@curvi/db";
import { createTestDb } from "@curvi/db/testing";
import { readCronSuccesses, recordCronSuccess, type CronJobDefinition } from "./cron-health";
import { claimTickLease, cronDue, releaseTickLease, runTick, TICK_LEASE_KEY } from "./cron-tick";

const NOW=new Date("2026-10-05T13:00:00Z");
let test:Awaited<ReturnType<typeof createTestDb>>;
let db:Db;
beforeAll(async()=>{test=await createTestDb();db=test.db as unknown as Db;});
beforeEach(async()=>{await test.client.query("delete from platform_settings where key like 'cron:%' or key=$1",[TICK_LEASE_KEY]);});
afterAll(async()=>{await test.client.close();});
const job=(name:string,run=vi.fn(async()=>undefined)):CronJobDefinition=>({name,every:10,intervalMinutes:10,run});

describe("cron tick",()=>{
 it("fences completion after lease loss and suppresses legacy route success writes",async()=>{
  const later=vi.fn(async()=>undefined);
  const stolen=job("retention",vi.fn(async()=>{
    await recordCronSuccess(db,"retention",NOW);
    await test.client.query("update platform_settings set value=jsonb_set(value,'{holder}','\"new-holder\"') where key=$1",[TICK_LEASE_KEY]);
  }));
  const result=await runTick({db,now:NOW,jobs:[stolen,job("later",later)]});
  expect(result).toMatchObject({succeeded:[],failed:["retention"],deferred:["later"],budgetExhausted:true});
  expect(await readCronSuccesses(db)).not.toHaveProperty("retention");
  expect(later).not.toHaveBeenCalled();
  const held=await test.client.query<{value:{holder:string}}>("select value from platform_settings where key=$1",[TICK_LEASE_KEY]);
  expect(held.rows[0].value.holder).toBe("new-holder");
 });
 it("calculates intervals and UTC daily/weekly catch-up without duplicate runs",()=>{
  expect(cronDue(job("x"),"2026-10-05T12:50:00Z",NOW)).toBe(true);
  expect(cronDue(job("x"),NOW.toISOString(),NOW)).toBe(false);
  const daily={name:"daily",intervalMinutes:1440,dailyAtUtc:"13:00" as const};
  expect(cronDue(daily,"2026-10-04T13:01:00Z",NOW)).toBe(true);
  expect(cronDue(daily,"2026-10-05T13:00:00Z",NOW)).toBe(false);
  const weekly={name:"weekly",intervalMinutes:10080,weeklyAt:{weekday:1 as const,atUtc:"13:00" as const}};
  expect(cronDue(weekly,"2026-09-28T13:01:00Z",NOW)).toBe(true);
  expect(cronDue(weekly,NOW.toISOString(),new Date("2026-10-06T10:00:00Z"))).toBe(false);
 });
 it("atomically admits one overlapping tick, expires leases, and never releases another holder",async()=>{
  const claims=await Promise.all([claimTickLease(db,NOW,"one"),claimTickLease(db,NOW,"two")]);
  expect(claims.map(c=>c.status).sort()).toEqual(["claimed","held"]);
  const holder=claims.find(c=>c.status==="claimed")!;
  await releaseTickLease(db,"unrelated");
  expect((await claimTickLease(db,NOW)).status).toBe("held");
  expect((await claimTickLease(db,new Date(NOW.getTime()+301000),"new")).status).toBe("claimed");
  if(holder.status==="claimed")await releaseTickLease(db,holder.holder);
  expect((await claimTickLease(db,new Date(NOW.getTime()+302000))).status).toBe("held");
 });
 it("flags a live lease acquired more than the stuck threshold ago",async()=>{
  await test.client.query("insert into platform_settings(key,value) values($1,$2)",[TICK_LEASE_KEY,JSON.stringify({holder:"hung",acquiredAt:"2026-10-05T12:00:00Z",expiresAt:"2026-10-05T14:00:00Z"})]);
  expect((await runTick({db,now:NOW,jobs:[]})).status).toBe("stuck");
 });
 it("records only successful jobs, continues after partial failures, and releases the lease",async()=>{
  const good=vi.fn(async()=>undefined),bad=vi.fn(async()=>{throw new Error("failed");});
  const jobs=[job("bad",bad),job("good",good)];
  const result=await runTick({db,now:NOW,jobs});
  expect(result).toMatchObject({succeeded:["good"],failed:["bad"]});
  expect(await readCronSuccesses(db)).toHaveProperty("good");
  expect(await readCronSuccesses(db)).not.toHaveProperty("bad");
  await runTick({db,now:NOW,jobs});
  expect(good).toHaveBeenCalledTimes(1);expect(bad).toHaveBeenCalledTimes(2);
  expect((await claimTickLease(db,NOW)).status).toBe("claimed");
 });
 it("defers new work once the budget is used",async()=>{
  let time=NOW.getTime();const later=vi.fn(async()=>undefined);
  const result=await runTick({db,now:NOW,clock:()=>time,jobs:[job("slow",vi.fn(async()=>{time+=241000;})),job("later",later)]});
  expect(result).toMatchObject({budgetExhausted:true,deferred:["later"]});
  expect(later).not.toHaveBeenCalled();
 });
});
