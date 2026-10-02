import type { Db } from "@curvi/db";
import { createTestDb, type TestDb } from "@curvi/db/testing";
import { emailLimits } from "@curvi/pipeline/seed";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { emailConfigFromEnv } from "./config";
import { normalizedEmailKey } from "./keys";
import { runLifecycle, type RunLifecycleDeps } from "./run";
import { addSuppression } from "./store";

// The lifecycle cron over the real migrations (docs/phases/PHASE_18.md
// P18-07): a confirmed user with no pack gets welcome, nudge 1 and nudge 2
// and nothing more; over a simulated 30 days every person gets each
// template at most once (packs back once per pause), nothing after a
// suppression, and every send writes funnel.email_sent.

const H = 60 * 60 * 1000;
const T0 = new Date("2026-10-05T12:00:00.000Z");
const at = (hours: number) => new Date(T0.getTime() + hours * H);

const ENV: Record<string, string> = {
  RESEND_API_KEY: "re_test",
  LIFECYCLE_EMAIL_FROM: "Curvi <hello@updates.curvi.ai>",
  LIFECYCLE_REPLY_TO: "founder@curvi.ai",
  CURVI_LINK_SECRET: "lifecycle-run-secret",
  CURVI_POSTAL_ADDRESS: "PO Box 100, Springfield, IL 62701",
  NEXT_PUBLIC_SITE_URL: "https://curvi.ai",
};

let client: Awaited<ReturnType<typeof createTestDb>>["client"];
let db: TestDb;
let outbox: { to: string; subject: string; text: string; headers?: Record<string, string> }[];

beforeAll(async () => {
  const created = await createTestDb();
  client = created.client;
  db = created.db;
  await client.exec("create table auth.users (id uuid primary key, email text)");
});

afterAll(async () => {
  await client.close();
});

beforeEach(async () => {
  await client.exec(`
    delete from email_sends; delete from email_suppressions; delete from events; delete from leads; delete from referrals;
    delete from signup_grants; delete from credit_ledger; delete from generation_jobs; delete from products; delete from members;
    delete from workspaces; delete from auth.users;
  `);
  outbox = [];
});

let users = 0;

async function signup(email: string, confirmedAt: Date, plan = "free"): Promise<string> {
  users += 1;
  const userId = `00000000-0000-4000-8000-${String(users).padStart(12, "0")}`;
  const ws = await client.query<{ id: string }>("insert into workspaces (name, plan) values ('Shop', $1) returning id", [plan]);
  const workspaceId = ws.rows[0].id;
  await client.query("insert into auth.users (id, email) values ($1, $2)", [userId, email]);
  await client.query("insert into members (workspace_id, user_id, role) values ($1, $2, 'owner')", [workspaceId, userId]);
  await client.query("insert into events (workspace_id, name, props, at) values ($1, 'funnel.signup_confirmed', '{}'::jsonb, $2)", [
    workspaceId,
    confirmedAt.toISOString(),
  ]);
  await client.query("insert into signup_grants (user_id, workspace_id, credits) values ($1, $2, 15)", [userId, workspaceId]);
  await client.query("insert into credit_ledger (workspace_id, delta, reason, source) values ($1, 15, 'grant', 'signup')", [workspaceId]);
  return workspaceId;
}

async function finishPack(workspaceId: string, startedAt: Date, doneAt: Date, charge: number, first: boolean): Promise<string> {
  const product = await client.query<{ id: string }>(
    "insert into products (workspace_id, title, mode) values ($1, 'Amber Candle', 'listing') returning id",
    [workspaceId],
  );
  const job = await client.query<{ id: string }>(
    "insert into generation_jobs (workspace_id, product_id, status, created_at) values ($1, $2, 'done', $3) returning id",
    [workspaceId, product.rows[0].id, startedAt.toISOString()],
  );
  const jobId = job.rows[0].id;
  const props = JSON.stringify({ job_id: jobId, passed: 6, needs_review: 0, credits: charge });
  await client.query("insert into events (workspace_id, name, props, at) values ($1, 'funnel.pack_done', $2::jsonb, $3)", [
    workspaceId,
    props,
    doneAt.toISOString(),
  ]);
  if (first) {
    await client.query("insert into events (workspace_id, name, props, at) values ($1, 'funnel.first_pack_done', $2::jsonb, $3)", [
      workspaceId,
      props,
      doneAt.toISOString(),
    ]);
  }
  await client.query("insert into credit_ledger (workspace_id, delta, reason, job_id) values ($1, $2, 'charge', $3)", [
    workspaceId,
    -charge,
    jobId,
  ]);
  return jobId;
}

async function lead(email: string, source: string, createdAt: Date, consent: boolean): Promise<void> {
  await client.query(
    `insert into leads (email, source, created_at, last_seen_at, marketing_consent_at, consent_source)
     values ($1, $2, $3, $3, $4, $5)`,
    [email, source, createdAt.toISOString(), consent ? createdAt.toISOString() : null, consent ? source : null],
  );
}

async function gateEvent(name: "acquisition_paused" | "acquisition_resumed", when: Date): Promise<void> {
  await client.query("insert into events (workspace_id, name, props, at) values (null, $1, '{}'::jsonb, $2)", [
    `funnel.${name}`,
    when.toISOString(),
  ]);
}

function deps(now: Date, overrides: Partial<RunLifecycleDeps> = {}): RunLifecycleDeps {
  return {
    db: db as unknown as Db,
    config: emailConfigFromEnv((name) => ENV[name]),
    enabled: async () => true,
    acquisitionOpen: true,
    typicalPackCredits: 8,
    creditTerms: "Credits you do not use stay in your balance from one month to the next, for as long as your account is open.",
    now: () => now,
    sleep: async () => {},
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { to: string[]; subject: string; text: string; headers?: Record<string, string> };
      outbox.push({ to: body.to[0], subject: body.subject, text: body.text, headers: body.headers });
      return new Response(JSON.stringify({ id: `email-${outbox.length}` }), { status: 200 });
    },
    log: { warn: () => {} },
    ...overrides,
  };
}

/** Runs the cron every `stepHours` from `from` to `to` hours after T0. */
async function simulate(from: number, to: number, stepHours: number, open: (hours: number) => boolean = () => true) {
  for (let h = from; h <= to; h += stepHours) {
    await runLifecycle(deps(at(h), { acquisitionOpen: open(h) }));
  }
}

async function sendsByTemplate(): Promise<{ template: string; recipient_key: string; status: string }[]> {
  return (await client.query<{ template: string; recipient_key: string; status: string }>(
    "select template, recipient_key, status from email_sends order by created_at, template",
  )).rows;
}

describe("runLifecycle", () => {
  it("uses the pack owner's id to build a signed feedback path and sends it once", async () => {
    const ws = await signup("feedback@example.com", at(-100));
    const jobId = await finishPack(ws, at(-1), T0, 1, true);
    const owners = await client.query<{ user_id: string }>("select user_id from members where workspace_id = $1 and role = 'owner'", [ws]);
    const signer = (input: { jobId: string; userId: string; now: Date }) => {
      expect(input).toEqual({ jobId, userId: owners.rows[0].user_id, now: at(49) });
      return "/feedback/signed-for-this-owner";
    };
    await runLifecycle(deps(at(49), { feedbackLink: signer }));
    await runLifecycle(deps(at(49), { feedbackLink: signer }));
    expect(outbox).toHaveLength(1);
    expect(outbox[0].text).toContain("https://curvi.ai/feedback/signed-for-this-owner?");
    expect(outbox[0].text).not.toContain("/app/jobs/");
  });

  it("receipts only unreversed ledger rewards to the referrer, without requiring a funnel event", async () => {
    const referrer = await signup("referrer@example.com", at(-1000));
    const referred = await signup("other@example.com", at(-1000));
    const row = await client.query<{ id: string }>(
      "insert into referrals (referrer_workspace_id, referred_workspace_id, status, rewarded_at) values ($1,$2,'rewarded',$3) returning id",
      [referrer, referred, T0.toISOString()],
    );
    const id = row.rows[0].id;
    await client.query("insert into credit_ledger (workspace_id, delta, reason, source, step_key) values ($1,37,'referral','system',$2)", [referrer, `referral:${id}:referrer`]);
    // Reversed rewards are not announced, even if their positive ledger row remains.
    await client.query("update referrals set status = 'reversed', reject_reason = 'refund' where id = $1", [id]);
    await runLifecycle(deps(at(1)));
    expect(outbox).toHaveLength(0);
    await client.query("update referrals set status = 'rewarded', reject_reason = null where id = $1", [id]);
    await runLifecycle(deps(at(1)));
    await runLifecycle(deps(at(2)));
    expect(outbox).toHaveLength(1);
    expect(outbox[0].to).toBe("referrer@example.com");
    expect(outbox[0].text).toContain("37 credits");
    expect(outbox[0].text).not.toContain("other@example.com");
  });
  it("sends a confirmed user with no pack welcome, nudge 1 and nudge 2, and nothing more", async () => {
    await signup("new@example.com", T0);
    await simulate(0.1, 30 * 24, 6);
    expect(outbox.map((e) => e.subject)).toEqual([
      "Your Curvi account is ready",
      "Your free pack is waiting",
      "Want me to make your first pack?",
    ]);
    expect(outbox.every((e) => e.to === "new@example.com")).toBe(true);
    const events = await client.query<{ template: string; n: number }>(
      "select props ->> 'template' as template, count(*)::int as n from events where name = 'funnel.email_sent' group by 1 order by 1",
    );
    expect(events.rows).toEqual([
      { template: "first_pack_nudge_1", n: 1 },
      { template: "first_pack_nudge_2", n: 1 },
      { template: "welcome", n: 1 },
    ]);
  });

  it("over 30 days sends each template at most once per person, nothing after a suppression, packs back once per pause", async () => {
    // A: signs up, makes a pack on day 2 that leaves 7 credits, then goes quiet.
    const a = await signup("maker@example.com", T0);
    // B: unsubscribes from marketing right after the welcome.
    await signup("quiet@example.com", T0);
    // C: a paid user with no pack: welcome only, no nudges.
    await signup("paid@example.com", T0, "starter");
    // Leads: one consented, one not.
    await lead("consented@example.com", "main-image-checker", at(1), true);
    await lead("plain@example.com", "white-background-fixer", at(1), false);

    await simulate(0.1, 2, 0.5);
    await addSuppression(db, normalizedEmailKey("quiet@example.com") as string, "marketing", "unsubscribed");
    await simulate(2.5, 46, 2);
    const jobId = await finishPack(a, at(47), at(48), 8, true);
    await simulate(48, 118, 2);
    // Packs pause from day 5 to day 6, and a visitor joins the waitlist meanwhile.
    await gateEvent("acquisition_paused", at(120));
    await simulate(120, 121, 1, () => false);
    await lead("waiting@example.com", "packs-paused", at(122), false);
    await simulate(122, 142, 2, () => false);
    await gateEvent("acquisition_resumed", at(144));
    await simulate(144, 30 * 24, 2);

    const rows = await sendsByTemplate();
    const sent = rows.filter((r) => r.status === "sent");
    const byPerson = (email: string) =>
      sent.filter((r) => r.recipient_key === normalizedEmailKey(email)).map((r) => r.template);
    expect(byPerson("maker@example.com")).toEqual(["welcome", "first_pack_nudge_1", "pack_ready", "out_of_credits", "win_back"]);
    expect(byPerson("quiet@example.com")).toEqual(["welcome"]);
    expect(byPerson("paid@example.com")).toEqual(["welcome"]);
    expect(byPerson("consented@example.com")).toEqual(["lead_results", "lead_tip", "lead_offer"]);
    // No consent: lead_results is marketing, so nothing.
    expect(byPerson("plain@example.com")).toEqual([]);
    expect(byPerson("waiting@example.com")).toEqual(["packs_back"]);
    // No key twice, nothing suppressed sent.
    expect(new Set(rows.map((r) => `${r.recipient_key}:${r.template}`)).size).toBe(rows.length);
    expect(outbox).toHaveLength(sent.length);
    // The pack ready email names the product and links to the pack.
    const ready = outbox.find((e) => e.subject === "Your Amber Candle pack is ready");
    expect(ready?.text).toContain(`/app/jobs/${jobId}?utm_source=curvi_email&utm_medium=email&utm_campaign=pack_ready`);
    // Every marketing email went with both unsubscribe headers.
    for (const email of outbox.filter((e) => e.text.includes("This is a marketing email from Curvi."))) {
      expect(email.headers?.["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    }
  });

  it("leaves operator workspaces out and stops lead offers once the same inbox has an account", async () => {
    await signup("Founder@Curvi.ai", T0);
    await signup("first.last@gmail.com", at(-500));
    await lead("FirstLast+tools@gmail.com", "main-image-checker", at(-80), true);
    await runLifecycle(deps(at(0.1), { excludeOwnerEmails: ["founder@curvi.ai"] }));
    // No welcome for the operator; the lead tip is due (3 days after consent) but the inbox already has an account.
    expect(outbox).toEqual([]);
    const report = await runLifecycle(deps(at(0.2), { dryRun: true, excludeOwnerEmails: [] }));
    expect(report.byTemplate).toEqual({ welcome: { due: 1 } });
  });

  it("sends nothing and writes nothing while switched off or without a sender", async () => {
    await signup("off@example.com", T0);
    expect((await runLifecycle(deps(at(0.1), { enabled: async () => false }))).status).toBe("switched_off");
    const unconfigured = await runLifecycle(deps(at(0.1), { config: emailConfigFromEnv((name) => (name === "LIFECYCLE_EMAIL_FROM" ? undefined : ENV[name])) }));
    expect(unconfigured).toMatchObject({ status: "not_configured", missing: ["LIFECYCLE_EMAIL_FROM"] });
    expect(outbox).toEqual([]);
    expect(await sendsByTemplate()).toEqual([]);
  });

  it("holds marketing without the postal address and writes no row for it", async () => {
    await signup("held@example.com", at(-50));
    const noAddress = emailConfigFromEnv((name) => (name === "CURVI_POSTAL_ADDRESS" ? undefined : ENV[name]));
    const report = await runLifecycle(deps(at(0), { config: noAddress, now: () => at(0) }));
    // Welcome is past its window here; nudge 1 is due and waits for the address.
    expect(report.byTemplate.first_pack_nudge_1).toEqual({ due: 1, waiting: 1 });
    expect(report.missing).toEqual(["CURVI_POSTAL_ADDRESS"]);
    expect(await sendsByTemplate()).toEqual([]);
  });

  it("keeps to the per run and per day caps", async () => {
    for (let i = 0; i < 5; i += 1) {
      await lead(`cap${i}@example.com`, "main-image-checker", at(0), true);
    }
    const limits = { ...emailLimits, perRun: 2, perUtcDay: 3 };
    const first = await runLifecycle(deps(at(0.1), { limits }));
    expect(first).toMatchObject({ sent: 2, stoppedBy: "run_cap" });
    const second = await runLifecycle(deps(at(0.2), { limits }));
    expect(second).toMatchObject({ sent: 1, stoppedBy: "day_cap" });
    const third = await runLifecycle(deps(at(0.3), { limits }));
    expect(third.sent).toBe(0);
    expect(outbox).toHaveLength(3);
  });

  it("stops the run on a Resend rate limit and tries the key again later", async () => {
    await lead("one@example.com", "main-image-checker", at(0), true);
    await lead("two@example.com", "main-image-checker", at(0), true);
    let calls = 0;
    const limited = await runLifecycle(
      deps(at(0.1), {
        fetchImpl: async () => {
          calls += 1;
          return new Response("slow down", { status: 429 });
        },
      }),
    );
    expect(limited).toMatchObject({ stoppedBy: "rate_limited", sent: 0 });
    expect(calls).toBe(1);
    const retry = await runLifecycle(deps(at(0.3)));
    expect(retry.sent).toBe(2);
  });

  it("retries only the failed recipient after a partially delivered run", async () => {
    await lead("partial-one@example.com", "main-image-checker", at(0), true);
    await lead("partial-two@example.com", "main-image-checker", at(0), true);
    const firstDeps = deps(at(0.1));
    let calls = 0;
    const partial = await runLifecycle({ ...firstDeps, fetchImpl: async (url, init) => {
      calls += 1;
      return calls === 2 ? new Response("temporarily unavailable", { status: 503 }) : firstDeps.fetchImpl!(url, init);
    } });
    expect(partial).toMatchObject({ sent: 1, attempted: 2 });
    expect(partial.byTemplate.lead_results).toMatchObject({ sent: 1, failed: 1 });
    expect(outbox).toHaveLength(1);
    const retry = await runLifecycle(deps(at(0.3)));
    expect(retry.sent).toBe(1);
    expect(outbox).toHaveLength(2);
    expect(new Set(outbox.map((email) => email.to)).size).toBe(2);
    const rows = await client.query<{ status: string; attempts: number }>("select status, attempts from email_sends order by attempts");
    expect(rows.rows).toEqual([{ status: "sent", attempts: 1 }, { status: "sent", attempts: 2 }]);
  });

  it("previews the due emails on a dry run without sending or writing", async () => {
    await signup("dry@example.com", T0);
    const report = await runLifecycle(deps(at(0.1), { dryRun: true, enabled: async () => false }));
    expect(report).toMatchObject({ status: "dry_run", due: 1, byTemplate: { welcome: { due: 1 } } });
    expect(outbox).toEqual([]);
    expect(await sendsByTemplate()).toEqual([]);
  });
});
