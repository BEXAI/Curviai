import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { actAsAuthenticated, actAsJwt, actAsSuperuser, createTestDb, readJournalEntries, SUPABASE_AUTH_SHIM_SQL } from "./test-helpers";

let client: PGlite;
const tables = ["pack_cases", "pack_case_events", "pack_case_notes", "workspace_credit_budgets", "workspace_credit_budget_audit", "webhook_endpoints", "pack_completion_events", "webhook_deliveries"];
beforeAll(async () => { ({ client } = await createTestDb()); });
beforeEach(async () => { await actAsSuperuser(client); });
afterAll(async () => { await client.close(); });

async function fixture() {
  const ws = randomUUID(), product = randomUUID(), job = randomUUID(), owner = randomUUID(), editor = randomUUID(), admin = randomUUID(), viewer = randomUUID();
  await client.query("insert into workspaces(id,name) values($1,'Phase21 test')", [ws]);
  await client.query("insert into members(workspace_id,user_id,role) values($1,$2,'owner'),($1,$3,'editor'),($1,$4,'admin'),($1,$5,'client')", [ws,owner,editor,admin,viewer]);
  await client.query("insert into products(id,workspace_id,title,mode) values($1,$2,'Fixture','listing')", [product,ws]);
  await client.query("insert into generation_jobs(id,workspace_id,product_id) values($1,$2,$3)", [job,ws,product]);
  await client.query("insert into credit_ledger(workspace_id,delta,reason) values($1,1000,'grant')",[ws]);
  return { ws,product,job,owner,editor,admin,viewer };
}
async function caseFor(f: Awaited<ReturnType<typeof fixture>>, reporter = f.editor) {
  const id=randomUUID();
  await client.query("insert into pack_cases(id,workspace_id,job_id,reporter_user_id,category,description,request_id) values($1,$2,$3,$4,'fidelity','The label is hard to read',$5)",[id,f.ws,f.job,reporter,randomUUID()]);
  return id;
}
async function endpointFor(f: Awaited<ReturnType<typeof fixture>>) {
  const id=randomUUID();
  await client.query("insert into webhook_endpoints(id,workspace_id,created_by,name,url,key_id,encrypted_secret,enabled,verified_at) values($1,$2,$3,'Fixture','https://receiver.example/hooks','fixture-key','fixture-ciphertext',true,now())",[id,f.ws,f.owner]);
  return id;
}
async function snapshot(ws:string) {
  const {rows} = await client.query<{consumed:string;held:string;remaining:string|null;monthly_limit:string|null;period_start:Date;period_end:Date}>("select * from workspace_credit_budget_snapshot($1)",[ws]);
  return rows[0];
}

describe("Phase21 case tenant and history contract",()=>{
  it("restricts cases and public events to reporter or managers; private notes never read",async()=>{
    const f=await fixture(), foreign=await fixture(), id=await caseFor(f);
    await client.query("insert into pack_case_events(workspace_id,case_id,actor_kind,message,request_id) values($1,$2,'system','Received',$3)",[f.ws,id,randomUUID()]);
    await client.query("insert into pack_case_notes(workspace_id,case_id,actor_user_id,message) values($1,$2,$3,'Private investigation')",[f.ws,id,f.owner]);
    for(const user of [f.owner,f.admin,f.editor]) {
      await actAsAuthenticated(client,user);
      expect((await client.query("select id from pack_cases")).rows).toHaveLength(1);
      expect((await client.query("select id from pack_case_events")).rows).toHaveLength(1);
      expect((await client.query("select id from pack_case_notes")).rows).toHaveLength(0);
    }
    for(const user of [f.viewer,foreign.owner]) {
      await actAsAuthenticated(client,user);
      expect((await client.query("select id from pack_cases")).rows).toHaveLength(0);
      expect((await client.query("select id from pack_case_events")).rows).toHaveLength(0);
    }
    await actAsJwt(client,{sub:f.owner,client_id:"external-app"});
    expect((await client.query("select id from pack_cases")).rows).toHaveLength(0);
    expect((await client.query("select id from pack_case_events")).rows).toHaveLength(0);
  });
  it("enforces request/open-case uniqueness and permits a new case after resolution",async()=>{
    const f=await fixture(), id=await caseFor(f);
    await expect(caseFor(f)).rejects.toThrow("pack_cases_open_category_uq");
    await client.query("update pack_cases set status='resolved',resolved_at=now() where id=$1",[id]);
    expect(await caseFor(f)).toBeTruthy();
    await expect(client.query("update pack_cases set status='reviewing',resolved_at=null where id=$1",[id])).rejects.toThrow("pack_cases_open_category_uq");
  });
  it("rejects cross-tenant jobs, histories and mutated references",async()=>{
    const f=await fixture(), other=await fixture(), id=await caseFor(f);
    await expect(client.query("insert into pack_cases(workspace_id,job_id,reporter_user_id,category,description,request_id) values($1,$2,$3,'other','A valid case description',$4)",[f.ws,other.job,f.owner,randomUUID()])).rejects.toThrow("job must belong");
    await expect(client.query("insert into pack_case_events(workspace_id,case_id,actor_kind,message,request_id) values($1,$2,'system','Received',$3)",[other.ws,id,randomUUID()])).rejects.toThrow("history must belong");
    await expect(client.query("insert into pack_case_notes(workspace_id,case_id,actor_user_id,message) values($1,$2,$3,'Private')",[other.ws,id,other.owner])).rejects.toThrow("history must belong");
    await expect(client.query("update pack_cases set reporter_user_id=$1 where id=$2",[f.owner,id])).rejects.toThrow("references are immutable");
    await actAsAuthenticated(client,f.owner);
    await expect(client.query("insert into pack_cases(workspace_id,job_id,reporter_user_id,category,description,request_id) values($1,$2,$3,'other','A valid case description',$4)",[f.ws,f.job,f.owner,randomUUID()])).rejects.toThrow("row-level security");
  });
  it("validates shot/output ancestry and clears a deleted output without retaining it",async()=>{
    const f=await fixture(), asset=randomUUID(), variant=randomUUID();
    await client.query("insert into channel_specs(id,version,spec) values('p21-fixture',1,'{}') on conflict do nothing");
    await client.query("insert into assets(id,workspace_id,job_id,shot_type,qc) values($1,$2,$3,'main','{\"shotId\":\"shot-1\"}')",[asset,f.ws,f.job]);
    await client.query("insert into asset_variants(id,workspace_id,asset_id,channel_spec_id,r2_key,filename) values($1,$2,$3,'p21-fixture',$4,'fixture.png')",[variant,f.ws,asset,`ws/${f.ws}/jobs/${f.job}/fixture.png`]);
    await client.query("insert into pack_cases(workspace_id,job_id,reporter_user_id,category,description,request_id,shot_id,version_id) values($1,$2,$3,'other','A valid case description',$4,'shot-1',$5)",[f.ws,f.job,f.owner,randomUUID(),variant]);
    await expect(client.query("insert into pack_cases(workspace_id,job_id,reporter_user_id,category,description,request_id,shot_id,version_id) values($1,$2,$3,'credits','A valid case description',$4,'wrong-shot',$5)",[f.ws,f.job,f.owner,randomUUID(),variant])).rejects.toThrow("shot must belong");
    await client.query("delete from asset_variants where id=$1",[variant]);
    expect((await client.query<{version_id:string|null}>("select version_id from pack_cases where workspace_id=$1",[f.ws])).rows[0].version_id).toBeNull();
  });
});

describe("Phase21 credit budget authoritative accounting",()=>{
  it("defaults disabled and keeps holds and charges counted exactly once",async()=>{
    const f=await fixture();
    expect((await snapshot(f.ws)).monthly_limit).toBeNull();
    await client.query("select set_workspace_credit_budget($1,$2,10.5)",[f.ws,f.owner]);
    await client.query("select reserve_credits($1,10.5,$2)",[f.ws,f.job]);
    await client.query("select charge_credits($1,2.5,$2,'shot-1')",[f.ws,f.job]);
    expect(await snapshot(f.ws)).toMatchObject({consumed:"2.5",held:"8.0",remaining:"0"});
    await expect(client.query("select reserve_credits($1,0.1,$2)",[f.ws,f.job])).rejects.toMatchObject({code:"CU429"});
    await client.query("select release_credits($1,$2)",[f.ws,f.job]);
    await client.query("select release_credits($1,$2)",[f.ws,f.job]);
    expect(await snapshot(f.ws)).toMatchObject({consumed:"2.5",held:"0",remaining:"8.0"});
    await client.query("select charge_credits($1,2.5,$2,'shot-1')",[f.ws,f.job]);
    expect((await snapshot(f.ws)).consumed).toBe("2.5");
  });
  it("carries prior-period holds but excludes old charges and grants from consumption",async()=>{
    const f=await fixture();
    await client.query("insert into credit_ledger(workspace_id,job_id,delta,reason,created_at) values($1,$2,-20,'reserve',date_trunc('month',now())-interval '2 days'),($1,$2,5,'release',date_trunc('month',now())-interval '1 day'),($1,$2,-5,'charge',date_trunc('month',now())-interval '1 day'),($1,null,20,'refund',now())",[f.ws,f.job]);
    await client.query("select set_workspace_credit_budget($1,$2,16)",[f.ws,f.owner]);
    expect(await snapshot(f.ws)).toMatchObject({consumed:"0",held:"15.0",remaining:"1.0"});
    await expect(client.query("select reserve_credits($1,1.1,$2)",[f.ws,f.job])).rejects.toMatchObject({code:"CU429"});
    await client.query("select reserve_credits($1,1,$2)",[f.ws,f.job]);
  });
  it("lowering a ceiling never strands settled work and audit records actual changes only",async()=>{
    const f=await fixture();
    await client.query("select set_workspace_credit_budget($1,$2,10)",[f.ws,f.owner]);
    await client.query("select reserve_credits($1,10,$2)",[f.ws,f.job]);
    await client.query("select set_workspace_credit_budget($1,$2,1)",[f.ws,f.owner]);
    await client.query("select set_workspace_credit_budget($1,$2,1)",[f.ws,f.owner]);
    await client.query("select charge_credits($1,7,$2,'delivered')",[f.ws,f.job]);
    await client.query("select release_credits($1,$2)",[f.ws,f.job]);
    await expect(client.query("select reserve_credits($1,0.1,$2)",[f.ws,f.job])).rejects.toMatchObject({code:"CU429"});
    expect((await client.query("select id from workspace_credit_budget_audit where workspace_id=$1",[f.ws])).rows).toHaveLength(2);
    await client.query("select set_workspace_credit_budget($1,$2,null)",[f.ws,f.owner]);
    await client.query("select reserve_credits($1,10,$2)",[f.ws,f.job]);
  });
  it("denies nonowners, all client functions and raw client budget writes",async()=>{
    const f=await fixture(), other=await fixture();
    for(const user of [f.admin,f.editor,f.viewer,other.owner]) await expect(client.query("select set_workspace_credit_budget($1,$2,10)",[f.ws,user])).rejects.toMatchObject({code:"42501"});
    await client.query("select set_workspace_credit_budget($1,$2,10)",[f.ws,f.owner]);
    for(const user of [f.owner,f.admin,f.editor,f.viewer]) {
      await actAsAuthenticated(client,user);
      await expect(client.query("select set_workspace_credit_budget($1,$2,null)",[f.ws,user])).rejects.toThrow("permission denied");
      expect((await client.query("update workspace_credit_budgets set monthly_limit=null returning workspace_id")).rows).toHaveLength(0);
      const rows=(await client.query("select workspace_id from workspace_credit_budgets")).rows;
      expect(rows.length).toBe([f.owner,f.admin].includes(user)?1:0);
    }
    await actAsJwt(client,{sub:f.owner,client_id:"external-app"});
    expect((await client.query("select * from workspace_credit_budgets")).rows).toHaveLength(0);
  });
  it("rejects NaN, infinity, negative, excessive and fractional precision before mutation",async()=>{
    const f=await fixture();
    for(const amount of ["NaN","Infinity","-Infinity","-1","1000000000.1","1.01"])
      await expect(client.query("select set_workspace_credit_budget($1,$2,$3::numeric)",[f.ws,f.owner,amount])).rejects.toThrow();
    for(const amount of ["NaN","Infinity","-Infinity","0","0.01"])
      await expect(client.query("select reserve_credits($1,$2::numeric,$3)",[f.ws,amount,f.job])).rejects.toThrow();
    const other=await fixture();
    await expect(client.query("select reserve_credits($1,1,$2)",[f.ws,other.job])).rejects.toThrow("job must belong");
  });
  it("keeps UTC month boundaries in sessions using a DST timezone",async()=>{
    const f=await fixture();
    const before=await snapshot(f.ws);
    await client.exec("set time zone 'America/New_York'");
    const after=await snapshot(f.ws);
    expect(after.period_start).toEqual(before.period_start);
    expect(after.period_end).toEqual(before.period_end);
    expect(new Date(after.period_end).getUTCDate()).toBe(1);
    expect(new Date(after.period_end).getUTCHours()).toBe(0);
    await client.exec("set time zone 'UTC'");
  });
});

describe("Phase21 atomic terminal outbox",()=>{
  it("commits one stable event per logical run, preserves recovery and rotates a followup",async()=>{
    const f=await fixture(), endpoint=await endpointFor(f);
    const first=(await client.query<{logical_run_id:string}>("select logical_run_id from generation_jobs where id=$1",[f.job])).rows[0].logical_run_id;
    await client.query("update generation_jobs set status='generating',run_key=$1 where id=$2",[randomUUID(),f.job]);
    await client.query("update generation_jobs set status='queued',run_key=$1 where id=$2",[randomUUID(),f.job]);
    expect((await client.query<{logical_run_id:string}>("select logical_run_id from generation_jobs where id=$1",[f.job])).rows[0].logical_run_id).toBe(first);
    await client.query("update generation_jobs set status='done',run_key=$1 where id=$2",[randomUUID(),f.job]);
    await client.query("update generation_jobs set status='done',run_key=$1 where id=$2",[randomUUID(),f.job]);
    expect((await client.query("select id from pack_completion_events where job_id=$1",[f.job])).rows).toHaveLength(1);
    expect((await client.query("select id from webhook_deliveries where endpoint_id=$1",[endpoint])).rows).toHaveLength(1);
    await client.query("update generation_jobs set status='generating',run_key=$1 where id=$2",[randomUUID(),f.job]);
    const next=(await client.query<{logical_run_id:string}>("select logical_run_id from generation_jobs where id=$1",[f.job])).rows[0].logical_run_id;
    expect(next).not.toBe(first);
    await client.query("update generation_jobs set status='done',logical_run_outcome='canceled' where id=$1",[f.job]);
    expect((await client.query("select outcome,pack_status from pack_completion_events where job_id=$1 and logical_run_id=$2",[f.job,next])).rows).toEqual([{outcome:"canceled",pack_status:"done"}]);
  });
  it("rolls back job and outbox together on transaction failure",async()=>{
    const f=await fixture(); await endpointFor(f);
    await client.exec("begin");
    await client.query("update generation_jobs set status='failed' where id=$1",[f.job]);
    await client.exec("rollback");
    expect((await client.query("select status from generation_jobs where id=$1",[f.job])).rows).toEqual([{status:"queued"}]);
    expect((await client.query("select id from pack_completion_events where job_id=$1",[f.job])).rows).toHaveLength(0);
    expect((await client.query("select id from webhook_deliveries where workspace_id=$1",[f.ws])).rows).toHaveLength(0);
  });
  it("blocks raw client status/outcome/identity forgery and hides signing/outbox data",async()=>{
    const f=await fixture(); await endpointFor(f);
    for(const user of [f.owner,f.admin,f.editor]) {
      await actAsAuthenticated(client,user);
      await expect(client.query("update generation_jobs set status='done' where id=$1",[f.job])).rejects.toThrow("only be changed by the server");
      await expect(client.query("update generation_jobs set logical_run_outcome='done' where id=$1",[f.job])).rejects.toThrow("only be changed by the server");
      await expect(client.query("update generation_jobs set logical_run_id=$1 where id=$2",[randomUUID(),f.job])).rejects.toThrow("only be changed by the server");
      for(const table of ["webhook_endpoints","pack_completion_events","webhook_deliveries"]) expect((await client.query(`select id from ${table}`)).rows).toHaveLength(0);
      await expect(client.query("insert into generation_jobs(workspace_id,product_id,status) values($1,$2,'done')",[f.ws,f.product])).rejects.toThrow("only be changed by the server");
    }
  });
  it("cancels queued deliveries on disable and enforces delivery/event tenant ancestry",async()=>{
    const f=await fixture(), other=await fixture(), endpoint=await endpointFor(f), otherEndpoint=await endpointFor(other);
    await client.query("update generation_jobs set status='canceled' where id=$1",[f.job]);
    const event=(await client.query<{id:string}>("select id from pack_completion_events where job_id=$1",[f.job])).rows[0].id;
    await expect(client.query("insert into webhook_deliveries(workspace_id,endpoint_id,event_id,endpoint_revision) values($1,$2,$3,1)",[f.ws,otherEndpoint,event])).rejects.toThrow("parents must belong");
    await client.query("update webhook_endpoints set enabled=false where id=$1",[endpoint]);
    expect((await client.query("select status,last_error from webhook_deliveries where endpoint_id=$1",[endpoint])).rows).toEqual([{status:"canceled",last_error:"disabled"}]);
    await expect(client.query("update pack_completion_events set outcome='done' where id=$1",[event])).rejects.toThrow("event is immutable");
    await client.query("delete from credit_ledger where workspace_id=$1",[f.ws]);
    await client.query("delete from workspaces where id=$1",[f.ws]);
    expect((await client.query("select id from webhook_deliveries where workspace_id=$1",[f.ws])).rows).toHaveLength(0);
  });
});

it("migrations explicitly revoke clients and install restrictive OAuth denial on every new table",async()=>{
  const raw=new PGlite();
  try {
    await raw.exec(`${SUPABASE_AUTH_SHIM_SQL} create role anon; create role authenticated; create role service_role bypassrls; create role supabase_auth_admin;`);
    for(const entry of readJournalEntries()) await raw.exec(readFileSync(new URL(`../migrations/${entry.tag}.sql`,import.meta.url),"utf8"));
    for(const table of tables) {
      const result=await raw.query<{relrowsecurity:boolean;qual:string;permissive:string}>("select c.relrowsecurity,p.qual,p.permissive from pg_class c join pg_policies p on p.tablename=c.relname where c.relname=$1 and p.policyname='no_oauth_clients'",[table]);
      expect(result.rows[0]).toMatchObject({relrowsecurity:true,permissive:"RESTRICTIVE"});
      expect(result.rows[0].qual).toContain("client_id");
      for(const role of ["anon","authenticated"]) {
        for(const privilege of ["INSERT","UPDATE","DELETE","TRUNCATE"]) expect((await raw.query<{allowed:boolean}>("select has_table_privilege($1,$2,$3) as allowed",[role,table,privilege])).rows[0].allowed).toBe(false);
        if(role==="anon" || ["pack_case_notes","webhook_endpoints","pack_completion_events","webhook_deliveries"].includes(table)) expect((await raw.query<{allowed:boolean}>("select has_table_privilege($1,$2,'SELECT') as allowed",[role,table])).rows[0].allowed).toBe(false);
      }
    }
  } finally { await raw.close(); }
});
