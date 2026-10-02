import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRaceDatabase, type RaceDatabase } from "./race-db";

const url = process.env.TEST_DATABASE_URL;
const parallel = 20;
describe.skipIf(!url)("Phase21 concurrency on real Postgres (TEST_DATABASE_URL)", () => {
  let race: RaceDatabase;
  let sql: postgres.Sql;
  beforeAll(async () => { race = await createRaceDatabase(url!, parallel + 5); sql = race.sql; }, 120_000);
  afterAll(async () => { await race?.drop(); });
  async function fixture() {
    const ws = randomUUID(), owner = randomUUID(), product = randomUUID(), job = randomUUID();
    await sql`insert into workspaces(id,name) values(${ws},'Phase21 race')`;
    await sql`insert into members(workspace_id,user_id,role) values(${ws},${owner},'owner')`;
    await sql`insert into products(id,workspace_id,title,mode) values(${product},${ws},'Race fixture','listing')`;
    await sql`insert into generation_jobs(id,workspace_id,product_id) values(${job},${ws},${product})`;
    await sql`insert into credit_ledger(workspace_id,delta,reason) values(${ws},1000,'grant')`;
    return { ws, owner, product, job };
  }
  it("admits only the holds covered by a ceiling across pooled reservations", async () => {
    const f=await fixture();
    await sql`select set_workspace_credit_budget(${f.ws}::uuid,${f.owner}::uuid,10)`;
    const results=await Promise.allSettled(Array.from({length:parallel},()=>sql`select reserve_credits(${f.ws}::uuid,1,${f.job}::uuid)`));
    expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(10);
    const rejected=results.filter(r=>r.status==='rejected') as PromiseRejectedResult[];
    expect(rejected).toHaveLength(10);
    for(const r of rejected) expect((r.reason as {code:string}).code).toBe('CU429');
    const [snapshot]=await sql`select * from workspace_credit_budget_snapshot(${f.ws}::uuid)`;
    expect(Number(snapshot.held)).toBe(10);
    expect(Number(snapshot.consumed)).toBe(0);
  });
  it("serializes a lower limit against already reserved work without denying settlement", async () => {
    const f=await fixture();
    await sql`select set_workspace_credit_budget(${f.ws}::uuid,${f.owner}::uuid,10)`;
    await sql`select reserve_credits(${f.ws}::uuid,10,${f.job}::uuid)`;
    await Promise.all([
      sql`select set_workspace_credit_budget(${f.ws}::uuid,${f.owner}::uuid,1)`,
      sql`select charge_credits(${f.ws}::uuid,5,${f.job}::uuid,'delivered')`,
    ]);
    await Promise.all(Array.from({length:parallel},()=>sql`select release_credits(${f.ws}::uuid,${f.job}::uuid)`));
    const [snapshot]=await sql`select * from workspace_credit_budget_snapshot(${f.ws}::uuid)`;
    expect(Number(snapshot.held)).toBe(0);
    expect(Number(snapshot.consumed)).toBe(5);
    await expect(sql`select reserve_credits(${f.ws}::uuid,0.1,${f.job}::uuid)`).rejects.toMatchObject({code:'CU429'});
    const [returned]=await sql`select sum(delta) as credits from credit_ledger where workspace_id=${f.ws} and reason='release'`;
    expect(Number(returned.credits)).toBe(10);
  });
  it("keeps one open case when many submissions race and another when closed", async () => {
    const f=await fixture();
    const results=await Promise.allSettled(Array.from({length:parallel},()=>sql`insert into pack_cases(workspace_id,job_id,reporter_user_id,category,description,request_id) values(${f.ws},${f.job},${f.owner},'fidelity','The label is hard to read',${randomUUID()})`));
    expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
    for(const r of results) if(r.status==='rejected') expect((r.reason as {code:string}).code).toBe('23505');
    await sql`update pack_cases set status='resolved',resolved_at=now() where workspace_id=${f.ws}`;
    await sql`insert into pack_cases(workspace_id,job_id,reporter_user_id,category,description,request_id) values(${f.ws},${f.job},${f.owner},'fidelity','The label is still hard to read',${randomUUID()})`;
    await expect(sql`update pack_cases set status='received',resolved_at=null where workspace_id=${f.ws} and status='resolved'`).rejects.toMatchObject({code:'23505'});
  });
  it("concurrent terminal transitions commit exactly one event and delivery", async () => {
    const f=await fixture(), endpoint=randomUUID();
    await sql`insert into webhook_endpoints(id,workspace_id,created_by,name,url,key_id,encrypted_secret,enabled,verified_at) values(${endpoint},${f.ws},${f.owner},'Race fixture','https://receiver.example/hook','fixture-key','fixture-encrypted-secret',true,now())`;
    await Promise.all(Array.from({length:parallel},()=>sql`update generation_jobs set status='done',run_key=${randomUUID()} where id=${f.job}`));
    expect(await sql`select id from pack_completion_events where job_id=${f.job}`).toHaveLength(1);
    expect(await sql`select id from webhook_deliveries where endpoint_id=${endpoint}`).toHaveLength(1);
    const claims=await Promise.all(Array.from({length:parallel},()=>sql.begin(async tx=>tx`
      with candidate as (
        select id from webhook_deliveries where endpoint_id=${endpoint} and status='pending'
        for update skip locked limit 1
      ) update webhook_deliveries d set status='leased',lease_token=${randomUUID()},lease_expires_at=now()+interval '1 minute',attempts=attempts+1
      from candidate c where d.id=c.id returning d.id
    `)));
    expect(claims.flat()).toHaveLength(1);
  });
  async function endpointFor(f: Awaited<ReturnType<typeof fixture>>) {
    const id=randomUUID();
    await sql`insert into webhook_endpoints(id,workspace_id,created_by,name,url,key_id,encrypted_secret,enabled,verified_at) values(${id},${f.ws},${f.owner},'Race fixture','https://receiver.example/hook','fixture-key','fixture-encrypted-secret',true,now())`;
    return id;
  }
  it("terminal commit proceeds while the sender holds an endpoint no-key-update lock", async () => {
    const f=await fixture(), endpoint=await endpointFor(f);
    let locked!:()=>void, release!:()=>void;
    const ready=new Promise<void>(r=>{locked=r;});
    const hold=new Promise<void>(r=>{release=r;});
    const sender=sql.begin(async tx=>{await tx`select id from webhook_endpoints where id=${endpoint} for no key update`;locked();await hold;});
    await ready;
    try {
      await sql.begin(async tx=>{
        await tx`set local lock_timeout='500ms'`;
        await tx`update generation_jobs set status='done' where id=${f.job}`;
      });
      expect(await sql`select id from webhook_deliveries where endpoint_id=${endpoint}`).toHaveLength(1);
    } finally { release(); await sender; }
  });
  it("endpoint deletion racing a terminal transaction cannot abort generation", async () => {
    const f=await fixture(), endpoint=await endpointFor(f);
    let locked!:()=>void, release!:()=>void;
    const ready=new Promise<void>(r=>{locked=r;});
    const hold=new Promise<void>(r=>{release=r;});
    const deletion=sql.begin(async tx=>{await tx`select id from webhook_endpoints where id=${endpoint} for update`;locked();await hold;await tx`delete from webhook_endpoints where id=${endpoint}`;});
    await ready;
    const terminal=sql`update generation_jobs set status='done' where id=${f.job}`.execute();
    await sql`select pg_sleep(0.05)`;
    release();
    await Promise.all([deletion,terminal]);
    expect(await sql`select id from pack_completion_events where job_id=${f.job}`).toHaveLength(1);
    expect(await sql`select id from webhook_deliveries where endpoint_id=${endpoint}`).toHaveLength(0);
  });
  it("disable and reenable cannot revive a delivery inserted with the old revision", async () => {
    const f=await fixture(), endpoint=await endpointFor(f);
    let locked!:()=>void, release!:()=>void;
    const ready=new Promise<void>(r=>{locked=r;});
    const hold=new Promise<void>(r=>{release=r;});
    const management=sql.begin(async tx=>{
      await tx`select id from webhook_endpoints where id=${endpoint} for no key update`;
      await tx`update webhook_endpoints set enabled=false where id=${endpoint}`;
      locked();await hold;
    });
    await ready;
    try { await sql`update generation_jobs set status='done' where id=${f.job}`; }
    finally { release();await management; }
    await sql`update webhook_endpoints set enabled=true where id=${endpoint}`;
    const eligible=await sql`select d.id from webhook_deliveries d join webhook_endpoints e on e.id=d.endpoint_id where d.endpoint_id=${endpoint} and d.status='pending' and e.enabled and e.revision=d.endpoint_revision`;
    expect(eligible).toHaveLength(0);
    const [endpointRow]=await sql`select revision from webhook_endpoints where id=${endpoint}`;
    expect(endpointRow.revision).toBe(3);
  });

});
