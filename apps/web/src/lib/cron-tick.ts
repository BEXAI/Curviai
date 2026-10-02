import { randomUUID } from "node:crypto";
import { sql, type Db } from "@curvi/db";
import { tick } from "@curvi/pipeline/seed";
import { CRON_JOBS, cronJobProblems, cronSettingKey, readCronSuccesses, withTickManagedSuccess, type CronJobDefinition } from "./cron-health";

export const TICK_LEASE_KEY = "tick:lease";
/** A missing optional integration is visible but is not a successful run. */
export class CronJobSkipped extends Error {}
const rowsOf = <T>(r:unknown):T[] => (Array.isArray(r)?r:(r as {rows?:T[]})?.rows??[]) as T[];

export function cronDue(job:CronJobDefinition,lastSuccess:string|undefined,now:Date):boolean {
  const last=lastSuccess?Date.parse(lastSuccess):NaN;
  if(job.every!==undefined) return !Number.isFinite(last) || now.getTime()-last>=job.every*60_000;
  const time=job.dailyAtUtc??job.weeklyAt?.atUtc;
  if(!time) return false;
  const [hours,minutes]=time.split(":").map(Number);
  const anchor=new Date(now);anchor.setUTCHours(hours,minutes,0,0);
  if(job.weeklyAt) anchor.setUTCDate(anchor.getUTCDate()-((anchor.getUTCDay()-job.weeklyAt.weekday+7)%7));
  if(anchor>now) anchor.setUTCDate(anchor.getUTCDate()-(job.weeklyAt?7:1));
  return !Number.isFinite(last) || last<anchor.getTime();
}

export type LeaseClaim = {status:"claimed";holder:string}|{status:"held"|"stuck"};
export async function claimTickLease(db:Db,now:Date,holder:string=randomUUID()):Promise<LeaseClaim> {
  const expiresAt=new Date(now.getTime()+(tick.budgetSeconds+tick.leaseMarginSeconds)*1000);
  const value=JSON.stringify({holder,acquiredAt:now.toISOString(),expiresAt:expiresAt.toISOString()});
  const claimed=rowsOf(await db.execute(sql`insert into platform_settings(key,value,updated_at)
    values(${TICK_LEASE_KEY},${value}::jsonb,${now.toISOString()}::timestamptz)
    on conflict(key) do update set value=excluded.value,updated_at=excluded.updated_at
    where (platform_settings.value->>'expiresAt')::timestamptz <= ${now.toISOString()}::timestamptz
    returning key`));
  if(claimed.length) return {status:"claimed",holder};
  const [held]=rowsOf<{value:{acquiredAt?:string}}>(await db.execute(sql`select value from platform_settings where key=${TICK_LEASE_KEY}`));
  const acquired=Date.parse(held?.value?.acquiredAt??"");
  return {status:!Number.isFinite(acquired)||now.getTime()-acquired>tick.leaseStuckMinutes*60_000?"stuck":"held"};
}
export async function releaseTickLease(db:Db,holder:string):Promise<void> {
  await db.execute(sql`delete from platform_settings where key=${TICK_LEASE_KEY} and value->>'holder'=${holder}`);
}
async function renewTickLease(db:Db,holder:string,now:Date):Promise<boolean> {
  const expiresAt=new Date(now.getTime()+(tick.budgetSeconds+tick.leaseMarginSeconds)*1000).toISOString();
  const rows=rowsOf(await db.execute(sql`update platform_settings
    set value=jsonb_set(value,'{expiresAt}',to_jsonb(${expiresAt}::text)),updated_at=${now.toISOString()}::timestamptz
    where key=${TICK_LEASE_KEY} and value->>'holder'=${holder}
      and (value->>'expiresAt')::timestamptz > ${now.toISOString()}::timestamptz returning key`));
  return rows.length===1;
}

export interface TickReport {
  status:"ran"|"held"|"stuck";
  succeeded:string[]; failed:string[]; skipped:string[]; deferred:string[]; budgetExhausted:boolean;
}
export async function runTick(options:{db:Db;now?:Date;jobs?:readonly CronJobDefinition[];clock?:()=>number}):Promise<TickReport> {
  const {db,clock=Date.now}=options;
  const jobs:readonly CronJobDefinition[]=options.jobs??CRON_JOBS;
  const now=options.now??new Date();
  const report:TickReport={status:"ran",succeeded:[],failed:[],skipped:[],deferred:[],budgetExhausted:false};
  for(const job of jobs) if(cronJobProblems(job).length) throw new Error(`Invalid cron definition: ${job.name}`);
  const lease=await claimTickLease(db,now);
  if(lease.status!=="claimed") return {...report,status:lease.status};
  const started=clock();
  const deadline=new Date(started+tick.budgetSeconds*1000);
  let leaseLost=false;
  const state: { reconciledJobs?: number } = {};
  // Renew while a bounded job finishes. A dead process stops renewing; a
  // hung live process is reported as stuck by the next tick after 30 min.
  const heartbeat=setInterval(()=>{void renewTickLease(db,lease.holder,new Date()).then(ok=>{if(!ok)leaseLost=true;}).catch(()=>{leaseLost=true;});},tick.leaseMarginSeconds*1000);
  try {
    const successes=await readCronSuccesses(db);
    for(const job of jobs) {
      if(!job.run || !cronDue(job,successes[job.name],now)) continue;
      if(clock()>=deadline.getTime() || leaseLost) {report.deferred.push(job.name);report.budgetExhausted=true;continue;}
      try {
        await withTickManagedSuccess(()=>job.run!({db,now,deadline,state}));
        // A failed success write is a failed run so it is retried. Old
        // standalone wrappers keep their best-effort record helper.
        const at=new Date(Math.max(now.getTime(),now.getTime()+clock()-started)).toISOString();
        if(leaseLost)throw new Error("The tick lease was lost before completion.");
        await db.transaction(async tx=>{
          const owned=rowsOf(await tx.execute(sql`select key from platform_settings
            where key=${TICK_LEASE_KEY} and value->>'holder'=${lease.holder}
              and (value->>'expiresAt')::timestamptz > ${at}::timestamptz for update`));
          if(!owned.length){leaseLost=true;throw new Error("The tick lease was lost before completion.");}
          await tx.execute(sql`insert into platform_settings(key,value,updated_at)
            values(${cronSettingKey(job.name)},${JSON.stringify({at})}::jsonb,${at}::timestamptz)
            on conflict(key) do update set value=excluded.value,updated_at=excluded.updated_at`);
        });
        report.succeeded.push(job.name);
      } catch (error) {
        if(error instanceof CronJobSkipped)report.skipped.push(job.name);
        else report.failed.push(job.name);
      }
    }
    if(clock()>=deadline.getTime() || leaseLost)report.budgetExhausted=true;
    return report;
  } finally {
    clearInterval(heartbeat);
    await releaseTickLease(db,lease.holder);
  }
}
