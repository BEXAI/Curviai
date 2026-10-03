/** Real owner-only weekly metrics, appended to the existing once-per-week funnel email. */
import { ListObjectsV2Command } from "@aws-sdk/client-s3";
import { sql, type Db } from "@curvi/db";
import { grossMargin, priceFloor } from "@curvi/pipeline/economics";
import { costCaps, funnelDigest, orphan, serviceListLimits, tiers, weeklyReport } from "@curvi/pipeline/seed";
import { customerWorkspace, operatorWorkspaceIds } from "@/lib/customer-metrics";
import { readDatabaseSize } from "@/lib/config-health";
import { isR2Configured } from "@/lib/env";
import { privateBucket, r2Client } from "@/lib/r2";

const DAY=86_400_000;
const rowsOf=<T>(result:unknown):T[]=>(Array.isArray(result)?result:(result as {rows?:T[]})?.rows??[]) as T[];
const number=(value:unknown):number=>Number(value??0);

/** Never report a partial listing as the bucket total. */
export async function readR2TotalBytes():Promise<number|null> {
  if(!isR2Configured())return null;
  const client=r2Client(),Bucket=privateBucket(),deadline=Date.now()+weeklyReport.storageBudgetSeconds*1000;
  let token:string|undefined,total=0;
  do {
    if(Date.now()>=deadline)return null;
    const page=await client.send(new ListObjectsV2Command({Bucket,ContinuationToken:token,MaxKeys:1000}),{abortSignal:AbortSignal.timeout(Math.max(1,deadline-Date.now()))});
    for(const item of page.Contents??[])total+=item.Size??0;
    token=page.IsTruncated?page.NextContinuationToken:undefined;
  }while(token);
  return total;
}

export interface WeeklyMetrics {
  excludedWorkspaces:number;allPackCogsUsd:number;mrrUsd:number;unknownPriceSubscriptions:number;churnRate:number|null;topUpsUsd:number;cogsUsd:number;grossMargin:number|null;
  packs:{started:number;done:number;failed:number;needsReview:number;shots:number;medianSeconds:number|null;longestQueueSeconds:number|null};
  alertsOpened:number;dailySpendUsd:number;dailyCapUsd:number;llmSpendUsd:number;
  databaseBytes:number|null;r2Bytes:number|null;paidPacksMonth:number;activeRunners:number;nearListLimitWorkspaces:number;payingCustomers:number;uncategorizedSupportRequests:number;
}

export class DbMetricsReader {
  constructor(private readonly db:Db,private readonly options:{now?:Date;databaseBytes?:()=>Promise<number|null>;storageBytes?:()=>Promise<number|null>}={}){}
  async read():Promise<WeeklyMetrics> {
    const db=this.db,now=this.options.now??new Date(),since=new Date(now.getTime()-funnelDigest.windowDays*DAY);
    const excluded=await operatorWorkspaceIds(db);
    const customer=(column:ReturnType<typeof sql>)=>customerWorkspace(excluded,column);
    const monthStart=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),1));
    const [subscriptions,jobs,shots,payments,other,counters,databaseBytes,r2Bytes]=await Promise.all([
      db.execute(sql`select tier,cadence,status,created_at,period_end from subscriptions
        where ${customer(sql`workspace_id`)} and (status='active' or (status='canceled' and period_end>=${since.toISOString()}::timestamptz and period_end<${now.toISOString()}::timestamptz))`),
      db.execute(sql`select count(*)::int as started,count(*) filter(where status='done')::int as done,
        count(*) filter(where status='failed')::int as failed,coalesce(sum(cogs_micros),0) as cogs,
        coalesce(sum(credits_charged),0) as credits,
        percentile_cont(0.5) within group(order by extract(epoch from(finished_at-started_at))) filter(where finished_at>=started_at) as median,
        max(extract(epoch from(coalesce(started_at,${now.toISOString()}::timestamptz)-created_at))) filter(where status='queued' or started_at is not null) as queue
        from generation_jobs where ${customer(sql`workspace_id`)} and created_at>=${since.toISOString()}::timestamptz and created_at<${now.toISOString()}::timestamptz`),
      db.execute(sql`select count(*)::int as total,count(*) filter(where not approved)::int as review from assets a
        join generation_jobs j on j.id=a.job_id where ${customer(sql`j.workspace_id`)} and j.created_at>=${since.toISOString()}::timestamptz and j.created_at<${now.toISOString()}::timestamptz and j.status in('done','failed','canceled')`),
      db.execute(sql`select coalesce(sum((props->>'amount_usd')::numeric),0) as topups from events
        where ${customer(sql`workspace_id`)} and name='funnel.payment' and props->>'kind'='topup' and (props->>'amount_usd') ~ '^[0-9]+(\\.[0-9]+)?$'
        and at>=${since.toISOString()}::timestamptz and at<${now.toISOString()}::timestamptz`),
      db.execute(sql`select
        (select count(*) from ops_alerts where opened_at>=${since.toISOString()}::timestamptz) as alerts,
        (select count(*) from generation_jobs where ${customer(sql`workspace_id`)} and credits_charged>0 and created_at>=${monthStart.toISOString()}::timestamptz and created_at<${now.toISOString()}::timestamptz) as paid_packs,
        (select count(distinct runner_id) from generation_jobs where status not in('done','failed','canceled') and heartbeat_at>=${new Date(now.getTime()-orphan.staleHeartbeatMinutes*60_000).toISOString()}::timestamptz) as runners,
        (select count(*) from (select workspace_id from products where ${customer(sql`workspace_id`)} group by workspace_id having count(*)>=${Math.ceil(serviceListLimits.products*serviceListLimits.nearRatio)}
          union select workspace_id from assets where ${customer(sql`workspace_id`)} group by workspace_id having count(*)>=${Math.ceil(serviceListLimits.assetScan*serviceListLimits.nearRatio)}) near_limits) as near_limits,
        (select count(distinct workspace_id) from events where ${customer(sql`workspace_id`)} and name='funnel.first_payment') as paying,
        (select count(*) from events where ${customer(sql`workspace_id`)} and name='support_request' and at>=${since.toISOString()}::timestamptz) as support,
        (select coalesce(sum(cogs_micros),0) from generation_jobs where created_at>=${since.toISOString()}::timestamptz and created_at<${now.toISOString()}::timestamptz) as all_pack_cogs`),
      db.execute(sql`select key,total_micros from spend_cap_counters where key=${`caps:global:${now.toISOString().slice(0,10)}`}
        or (key like 'llm|day|%' and split_part(key,'|',3)>=${since.toISOString().slice(0,10)} and split_part(key,'|',3)<=${now.toISOString().slice(0,10)} and split_part(key,'|',6)='cost_micros')`),
      (this.options.databaseBytes??(()=>readDatabaseSize(db)))().catch(()=>null),
      (this.options.storageBytes??readR2TotalBytes)().catch(()=>null),
    ]);
    let mrrUsd=0,unknownPriceSubscriptions=0,churned=0,cohort=0;
    for(const sub of rowsOf<{tier:string;cadence:string;status:string;created_at:string|Date}>(subscriptions)){
      const tier=tiers.find(t=>t.key===sub.tier);
      if(sub.status==='active'){
        if(!tier || !['monthly','annual'].includes(sub.cadence))unknownPriceSubscriptions++;
        else mrrUsd+=sub.cadence==='annual'?tier.annualUsdPerMonth:tier.monthlyUsd;
      }
      if(new Date(sub.created_at)<since){cohort++;if(sub.status==='canceled')churned++;}
    }
    const j=rowsOf<Record<string,unknown>>(jobs)[0]??{},s=rowsOf<Record<string,unknown>>(shots)[0]??{},o=rowsOf<Record<string,unknown>>(other)[0]??{};
    let dailySpendUsd=0,llmSpendUsd=0;
    for(const row of rowsOf<{key:string;total_micros:number|string}>(counters)){
      if(row.key.startsWith('caps:global:'))dailySpendUsd+=number(row.total_micros)/1e6;
      else llmSpendUsd+=number(row.total_micros)/1e6;
    }
    const cogsUsd=number(j.cogs)/1e6;
    return {excludedWorkspaces:excluded.length,allPackCogsUsd:number(o.all_pack_cogs)/1e6,mrrUsd,unknownPriceSubscriptions,churnRate:cohort?churned/cohort:null,topUpsUsd:number(rowsOf<{topups:unknown}>(payments)[0]?.topups),cogsUsd,
      grossMargin:grossMargin(number(j.credits)*priceFloor().net.netRevenuePerCredit,cogsUsd),
      packs:{started:number(j.started),done:number(j.done),failed:number(j.failed),needsReview:number(s.review),shots:number(s.total),medianSeconds:j.median==null?null:number(j.median),longestQueueSeconds:j.queue==null?null:Math.max(0,number(j.queue))},
      alertsOpened:number(o.alerts),dailySpendUsd,dailyCapUsd:costCaps.globalDailyHardStopMicros/1e6,llmSpendUsd,
      databaseBytes,r2Bytes,paidPacksMonth:number(o.paid_packs),activeRunners:number(o.runners),nearListLimitWorkspaces:number(o.near_limits),payingCustomers:number(o.paying),uncategorizedSupportRequests:number(o.support)};
  }
}

export function weeklyMetricLines(m:WeeklyMetrics):string[] {
  const money=(n:number)=>`$${n.toFixed(2)}`,percent=(n:number|null)=>n===null?'not available':`${(n*100).toFixed(1)}%`;
  const size=(n:number|null)=>n===null?'not available':`${(n/1024/1024).toFixed(1)} MB`;
  const fired=(condition:boolean)=>condition?'REVIEW':'not reached';
  return ['','Money',`Customer metrics exclude ${m.excludedWorkspaces} operator-owned workspaces.`,`MRR at seed prices: ${money(m.mrrUsd)}${m.unknownPriceSubscriptions?` (${m.unknownPriceSubscriptions} subscriptions lack a known price)`:''}`,
    `Weekly churn among subscriptions present at the start: ${percent(m.churnRate)}`,`Top ups received: ${money(m.topUpsUsd)}`,`Customer pack COGS this week: ${money(m.cogsUsd)}`,`All pack COGS including operator/synthetic work: ${money(m.allPackCogsUsd)}`,
    `Pack gross margin at the lowest net revenue per credit: ${percent(m.grossMargin)}`,'','Operations',
    `Packs started: ${m.packs.started}; done: ${m.packs.done}; failed: ${m.packs.failed}; failure rate: ${percent(m.packs.started?m.packs.failed/m.packs.started:null)}`,
    `Shots needing review: ${m.packs.needsReview} of ${m.packs.shots} (${percent(m.packs.shots?m.packs.needsReview/m.packs.shots:null)})`,
    `Median duration: ${m.packs.medianSeconds===null?'not available':`${Math.round(m.packs.medianSeconds)} seconds`}; longest queue wait: ${m.packs.longestQueueSeconds===null?'not available':`${Math.round(m.packs.longestQueueSeconds)} seconds`}`,
    `Alerts opened: ${m.alertsOpened}`,
    `Today's provider spend: ${money(m.dailySpendUsd)}; seed daily hard stop: ${money(m.dailyCapUsd)}`,
    `LLM spend in UTC day counters: ${money(m.llmSpendUsd)}; database: ${size(m.databaseBytes)}; total R2 objects: ${size(m.r2Bytes)}`,'','Triggers',
    `Second active runner: ${fired(m.activeRunners>1)} (${m.activeRunners} observed)`,
    `Queue wait over ${weeklyReport.queueDecisionMinutes} minutes: ${fired((m.packs.longestQueueSeconds??0)>weeklyReport.queueDecisionMinutes*60)}`,
    `Team request: review ${m.uncategorizedSupportRequests} support requests; team requests are not separately categorized.`,
    `Workspace near a list limit: ${fired(m.nearListLimitWorkspaces>0)} (${m.nearListLimitWorkspaces} workspaces)`,
    `${weeklyReport.paidPackThreshold} paid packs this month: ${fired(m.paidPacksMonth>=weeklyReport.paidPackThreshold)} (${m.paidPacksMonth})`,
    `First paying customer: ${fired(m.payingCustomers>0)} (${m.payingCustomers})`,
    `Database past ${weeklyReport.databaseDecisionBytes/1024/1024} MB: ${m.databaseBytes===null?'not available':fired(m.databaseBytes>weeklyReport.databaseDecisionBytes)}`];
}
