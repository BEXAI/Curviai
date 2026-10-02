/** Scheduled adapters live at the cron boundary; owner-only ops helpers must
 * never enter customer app services. Existing HTTP jobs remain callable
 * during the scheduler transition and share exactly the same run path. */
import { NextRequest } from "next/server";
import { tick } from "@curvi/pipeline/seed";
import type { CronJobContext } from "@/lib/cron-health";
import { CronJobSkipped } from "@/lib/cron-tick";
import { optionalEnv, isR2Configured } from "@/lib/env";
import { runRetention } from "@/lib/ops/retention";
import { legacyTmpStorage, sweepLegacyTemporaryObjects } from "@/lib/ops/temporary-storage";
import { recoverOrphanJobs } from "@/lib/jobs/recovery";
import { scheduleRestartPickup } from "@/lib/jobs/enqueue";
import { sweepStaleJobs } from "@/lib/services/reconcile";
import { deleteExpiredVisitSalts } from "@/lib/visits/store";

async function existingRoute(name:string):Promise<void> {
  const request=new NextRequest(`http://localhost/api/cron/${name}`,{method:"POST",headers:{authorization:`Bearer ${optionalEnv("CRON_SECRET") ?? ""}`}});
  let response:Response;
  switch(name) {
    case "purge-source-media": response=await (await import("../purge-source-media/route")).POST(request);break;
    case "funnel-digest": response=await (await import("../funnel-digest/route")).POST(request);break;
    case "provider-balance": response=await (await import("../provider-balance/route")).POST(request);break;
    case "lifecycle": response=await (await import("../lifecycle/route")).POST(request);break;
    case "billing-reconcile": response=await (await import("../billing-reconcile/route")).POST(request);break;
    case "renewal-notices": response=await (await import("../renewal-notices/route")).POST(request);break;
    default:throw new Error(`No registered run for ${name}`);
  }
  const body=await response.json() as {ok?:boolean;failed?:unknown[]|number;skipped?:string;truncated?:boolean;report?:{failed?:number;objectsFailed?:number}};
  if(body.skipped && name!=="billing-reconcile")throw new CronJobSkipped(body.skipped);
  if(!response.ok || body.ok===false || body.truncated===true || (Array.isArray(body.failed)?body.failed.length>0:(body.failed??0)>0) || (body.report?.failed??0)>0 || (body.report?.objectsFailed??0)>0 || (name==="funnel-digest" && body.skipped)) {
    throw new Error(`Scheduled job failed: ${name}`);
  }
}

export async function runScheduledJob(name:string,ctx:CronJobContext):Promise<void> {
  switch(name) {
    case "stale-jobs": {
      const report=await sweepStaleJobs(ctx.db);
      if(ctx.state)ctx.state.reconciledJobs=(ctx.state.reconciledJobs??0)+report.reconciled.length;
      if(report.releaseFailures.length)throw new Error("Stale jobs could not release all holds.");
      scheduleRestartPickup({force:true});
      return;
    }
    case "recovery": {
      const report=await recoverOrphanJobs(ctx.db,{now:ctx.now});
      if(ctx.state)ctx.state.reconciledJobs=(ctx.state.reconciledJobs??0)+report.settled;
      if(report.failures)throw new Error("Some orphan jobs could not be recovered.");
      return;
    }
    case "visit-salts": await deleteExpiredVisitSalts(ctx.db,ctx.now);return;
    case "upstash-keepalive": {
      if(!optionalEnv("UPSTASH_REDIS_REST_URL") || !optionalEnv("UPSTASH_REDIS_REST_TOKEN"))throw new CronJobSkipped("Redis is not configured.");
      const {Redis}=await import("@upstash/redis");
      const redis=Redis.fromEnv({signal:()=>AbortSignal.timeout(Math.min(tick.keepaliveTimeoutMs,Math.max(1,ctx.deadline.getTime()-Date.now())))});
      const result=await redis.ping();
      if(result!=="PONG")throw new Error("Redis did not answer the keepalive.");
      return;
    }
    case "provider-canary": {
      const report=await (await import("@/lib/provider-canary")).runProviderCanaryNow();
      if(report.skipped)throw new CronJobSkipped(`Provider probes are ${report.skipped}.`);
      if(!report.ok)throw new Error("A provider probe failed.");
      return;
    }
    case "ops-alerts": {
      const {evaluateOpsAlerts}=await import("@/lib/ops/alerts");
      const {readOpsAlertSignals}=await import("@/lib/ops/alert-signals");
      const signals=await readOpsAlertSignals(ctx.db,ctx.now,ctx.deadline);
      const health=await (await import("../../health/route")).GET(new Request("http://localhost/api/health"));
      const body=await health.json() as {warnings?:string[]};
      const report=await evaluateOpsAlerts(ctx.db,{...signals,now:ctx.now,healthWarnings:body.warnings,reconciledJobs:ctx.state?.reconciledJobs});
      if(report.failedNotifications)throw new Error("Some operator alerts were not delivered.");
      return;
    }
    case "retention": {
      const report=await runRetention({db:ctx.db,now:ctx.now,deadline:ctx.deadline});
      if(report.budgetExhausted)throw new Error("Retention needs another bounded pass.");
      return;
    }
    case "r2-legacy-sweep": {
      if(!isR2Configured())throw new CronJobSkipped("Storage is not configured.");
      const report=await sweepLegacyTemporaryObjects({db:ctx.db,storage:legacyTmpStorage(),now:ctx.now,deadline:ctx.deadline});
      if(report.failed)throw new Error("Temporary objects could not all be removed.");
      return;
    }
    case "completion-webhooks": {
      const { runWebhookBatch } = await import("@/lib/webhooks/worker");
      const report = await runWebhookBatch(ctx.db, { deadline: ctx.deadline });
      if (!report.configured) throw new CronJobSkipped("Webhook signing is not configured.");
      return;
    }
    default:await existingRoute(name);
  }
}
