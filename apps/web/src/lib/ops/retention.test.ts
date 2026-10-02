import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@curvi/db";
import { createTestDb } from "@curvi/db/testing";
import { dataRetention } from "@curvi/pipeline/seed";
import { counterRetentionDays, runRetention } from "./retention";

const NOW = new Date("2026-10-02T12:00:00Z");
const ago = (days: number) => new Date(NOW.getTime() - days * 86_400_000).toISOString();
let test: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => { test = await createTestDb(); });
afterAll(async () => { await test.client.close(); });

describe("operational retention", () => {
  it("keeps funnel claims, billing evidence, recent rows and unfinished job steps; dry run changes nothing", async () => {
    const c = test.client;
    const ws = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const product = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const done = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    const active = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    await c.query("insert into workspaces(id,name) values($1,'Retention')", [ws]);
    await c.query("insert into products(id,workspace_id,title,mode) values($1,$2,'Mug','listing')", [product,ws]);
    await c.query("insert into generation_jobs(id,workspace_id,product_id,status) values($1,$3,$4,'done'),($2,$3,$4,'generating')", [done,active,ws,product]);
    for (const [name, age] of [["old",181],["recent",179],["funnel.first_pack",1500],["billing:paid",399],["billing:old",401],["billing:email:recent",1000],["billing:email:old",1200]] as const) {
      await c.query("insert into events(name,at) values($1,$2)", [name,ago(age)]);
    }
    for (const age of [179,181]) {
      await c.query("insert into job_steps(workspace_id,job_id,created_at) values($1,$2,$4),($1,$3,$4)", [ws,done,active,ago(age)]);
    }
    for (const age of [399,401]) {
      await c.query("insert into ops_audit(operator_email,action,target_kind,at) values('ops@example.test','test','workspace',$1)", [ago(age)]);
      await c.query("insert into site_visits(day,visitor_hash,path,device) values($1,$2,'/','desktop')", [ago(age).slice(0,10),"a".repeat(32)]);
    }
    for (const age of [29,31]) {
      await c.query("insert into upload_preflights(workspace_id,r2_key,note_key,status,result,updated_at) values($1,$2,'note','ready','{}',$3)", [ws,`ws/${ws}/src/${age}`,ago(age)]);
    }
    for (const [status,age] of [["resolved",179],["resolved",181],["open",181]] as const) {
      await c.query("insert into ops_alerts(rule,subject,status,resolved_at) values('test',$1,$2,$3)", [`${status}${age}`,status,ago(age)]);
    }
    for (const [template,age] of [["billing_notice",1000],["billing_notice",1200],["welcome",1200]] as const) {
      await c.query("insert into email_sends(recipient_key,template,dedupe_key,kind,updated_at) values($1,$2,$3,'transactional',$4)", ["b".repeat(64),template,`${template}:${age}`,ago(age)]);
    }
    for (const [prefix,days] of Object.entries(dataRetention.counterDays)) {
      for (const offset of [-1,1]) await c.query("insert into spend_cap_counters(key,updated_at) values($1,$2)", [`${prefix}${offset}`,ago(days+offset)]);
    }
    for (const offset of [-1,1]) await c.query("insert into spend_cap_counters(key,updated_at) values($1,$2)", [`unknown:${offset}`,ago(dataRetention.otherCounterDays+offset)]);

    const dry = await runRetention({ db:test.db as unknown as Db, now:NOW, dryRun:true });
    expect(dry.tables.events).toMatchObject({matched:3,deleted:0,complete:true});
    expect((await c.query("select * from events")).rows).toHaveLength(7);
    const real = await runRetention({ db:test.db as unknown as Db, now:NOW });
    expect(real.budgetExhausted).toBe(false);
    expect(real.tables.job_steps.deleted).toBe(1);
    for (const name of ["ops_audit","site_visits","upload_preflights","ops_alerts","billing_email_sends"]) expect(real.tables[name].deleted,name).toBe(1);
    expect(real.tables.spend_cap_counters.deleted).toBe(Object.keys(dataRetention.counterDays).length+1);
    expect((await c.query<{name:string}>("select name from events order by name")).rows.map(r=>r.name)).toEqual(["billing:email:recent","billing:paid","funnel.first_pack","recent"]);
    expect(Object.keys(real.tables)).not.toContain("billing_consents");
    expect((await runRetention({db:test.db as unknown as Db,now:NOW})).tables.events.deleted).toBe(0);
  });

  it("does no work when the caller deadline has passed", async () => {
    const report=await runRetention({db:test.db as unknown as Db,now:NOW,deadline:NOW,clock:()=>NOW.getTime()+1});
    expect(report.budgetExhausted).toBe(true);
    expect(report.tables.events.deleted).toBe(0);
  });

  it("gives every known counter prefix its seeded window and unknown families a bounded fallback", () => {
    for(const [prefix,days] of Object.entries(dataRetention.counterDays)) expect(counterRetentionDays(`${prefix}id`)).toBe(days);
    expect(counterRetentionDays("future-family:id")).toBe(dataRetention.otherCounterDays);
  });
});
