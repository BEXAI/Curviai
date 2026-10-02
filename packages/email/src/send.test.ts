import type { PGlite } from "@electric-sql/pglite";
import type { Db } from "@curvi/db";
import { createTestDb, type TestDb } from "@curvi/db/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { emailConfigFromEnv, type EmailConfig } from "./config";
import { normalizedEmailKey } from "./keys";
import { verifyUnsubscribeToken } from "./links";
import type { EmailTemplate } from "./render";
import { sendEmail, type SendEmailDeps } from "./send";
import { addSuppression, lifecycleEmailEnabled, liftMarketingSuppression, sentToday, suppressionOf } from "./store";

// sendEmail over a real schema (PGlite): one email per dedupe key, the
// switch, suppression, the sender and marketing requirements, retries, and
// no address in any row (docs/phases/PHASE_18.md P18-06).

const tx: EmailTemplate<{ n: number }> = {
  key: "test_tx",
  kind: "transactional",
  audience: "account",
  render: (data, ctx) => ({ subject: `Pack ${data.n} is ready`, paragraphs: [`Open it: ${ctx.link("/app")}`] }),
};
const promo: EmailTemplate<Record<string, never>> = {
  key: "test_promo",
  kind: "marketing",
  audience: "lead",
  render: (_data, ctx) => ({ subject: "A tip", paragraphs: [`Check: ${ctx.link("/tools/main-image-checker")}`] }),
};

const FULL_ENV: Record<string, string> = {
  RESEND_API_KEY: "re_test",
  LIFECYCLE_EMAIL_FROM: "Curvi <hello@updates.curvi.ai>",
  LIFECYCLE_REPLY_TO: "founder@curvi.ai",
  CURVI_LINK_SECRET: "link-secret-for-tests",
  CURVI_POSTAL_ADDRESS: "PO Box 100, Springfield, IL 62701",
  NEXT_PUBLIC_SITE_URL: "https://curvi.ai",
};

const config = (overrides: Record<string, string | undefined> = {}): EmailConfig =>
  emailConfigFromEnv((name) => (name in overrides ? overrides[name] : FULL_ENV[name]));

let client: PGlite;
let db: TestDb;
let calls: { url: string; body: Record<string, unknown>; headers: Record<string, string> }[];
let answer: () => Response;

beforeAll(async () => {
  const created = await createTestDb();
  client = created.client;
  db = created.db;
});

afterAll(async () => {
  await client.close();
});

beforeEach(async () => {
  await client.exec("delete from email_sends; delete from email_suppressions; delete from events;");
  calls = [];
  answer = () => new Response(JSON.stringify({ id: `email-${calls.length}` }), { status: 200 });
});

function deps(overrides: Partial<SendEmailDeps> = {}): SendEmailDeps {
  return {
    db: db as unknown as Db,
    config: config(),
    enabled: async () => true,
    fetchImpl: async (url, init) => {
      calls.push({
        url,
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        headers: init?.headers as Record<string, string>,
      });
      return answer();
    },
    log: { warn: () => {} },
    ...overrides,
  };
}

async function rows() {
  return (await client.query<Record<string, unknown>>("select * from email_sends order by created_at")).rows;
}

describe("sendEmail", () => {
  it("sends once per dedupe key, logs the key never the address, and records email_sent", async () => {
    const first = await sendEmail(deps(), { to: "Seller@Example.com", template: tx, data: { n: 1 }, dedupeKey: "pack_ready:job-1", workspaceId: null });
    expect(first).toMatchObject({ status: "sent", providerId: "email-1" });
    const again = await sendEmail(deps(), { to: "seller@example.com", template: tx, data: { n: 1 }, dedupeKey: "pack_ready:job-1", workspaceId: null });
    expect(again.status).toBe("duplicate");
    expect(calls).toHaveLength(1);
    expect(calls[0].headers["Idempotency-Key"]).toBe("pack_ready:job-1");
    const logged = await rows();
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({
      status: "sent",
      template: "test_tx",
      kind: "transactional",
      recipient_key: normalizedEmailKey("seller@example.com"),
      provider_id: "email-1",
    });
    expect(JSON.stringify(logged)).not.toContain("example.com");
    const events = await client.query<{ name: string; props: unknown }>("select name, props from events");
    expect(events.rows).toEqual([{ name: "funnel.email_sent", props: { template: "test_tx", kind: "transactional" } }]);
  });

  it("sends one email when two runs race for the same key", async () => {
    const input = { to: "race@example.com", template: tx, data: { n: 2 }, dedupeKey: "race:1", workspaceId: null };
    const results = await Promise.all([sendEmail(deps(), input), sendEmail(deps(), input), sendEmail(deps(), input)]);
    expect(results.filter((r) => r.status === "sent")).toHaveLength(1);
    expect(results.filter((r) => r.status === "duplicate")).toHaveLength(2);
    expect(calls).toHaveLength(1);
  });

  it("sends nothing while the switch is off, and sends the same key once it is on", async () => {
    const input = { to: "wait@example.com", template: tx, data: { n: 3 }, dedupeKey: "switch:1", workspaceId: null };
    expect((await sendEmail(deps({ enabled: async () => false }), input)).status).toBe("disabled");
    expect(calls).toHaveLength(0);
    expect((await rows())[0]).toMatchObject({ status: "disabled", error: "lifecycle email is switched off" });
    expect((await sendEmail(deps(), input)).status).toBe("sent");
    expect(calls).toHaveLength(1);
  });

  it("reads the switch from platform_settings when no reader is given, failing closed", async () => {
    expect(await lifecycleEmailEnabled(db)).toBe(false);
    const input = { to: "flag@example.com", template: tx, data: { n: 4 }, dedupeKey: "flag:1", workspaceId: null };
    expect((await sendEmail(deps({ enabled: undefined }), input)).status).toBe("disabled");
    // P20-20: the switch is the operator row ops:lifecycle_email_enabled.
    await client.query("insert into platform_settings (key, value) values ('ops:lifecycle_email_enabled', 'true'::jsonb)");
    expect(await lifecycleEmailEnabled(db)).toBe(true);
    expect((await sendEmail(deps({ enabled: undefined }), input)).status).toBe("sent");
    await client.query("delete from platform_settings where key = 'ops:lifecycle_email_enabled'");
  });

  it("keeps marketing from a marketing unsubscribe, and all mail from a bounce", async () => {
    const key = normalizedEmailKey("quiet@example.com") as string;
    await addSuppression(db, key, "marketing", "unsubscribed");
    expect((await sendEmail(deps(), { to: "quiet+x@example.com", template: promo, data: {}, dedupeKey: "promo:q", workspaceId: null })).status).toBe(
      "suppressed",
    );
    expect((await sendEmail(deps(), { to: "quiet@example.com", template: tx, data: { n: 5 }, dedupeKey: "tx:q", workspaceId: null })).status).toBe("sent");
    await addSuppression(db, key, "all", "bounced");
    expect((await sendEmail(deps(), { to: "quiet@example.com", template: tx, data: { n: 6 }, dedupeKey: "tx:q2", workspaceId: null })).status).toBe(
      "suppressed",
    );
    // A suppressed key is final, even after the suppression goes.
    await client.query("delete from email_suppressions");
    expect((await sendEmail(deps(), { to: "quiet@example.com", template: promo, data: {}, dedupeKey: "promo:q", workspaceId: null })).status).toBe(
      "duplicate",
    );
    expect(calls).toHaveLength(1);
  });

  it("holds marketing mail without the postal address or the link secret, and sends transactional mail", async () => {
    const noAddress = deps({ config: config({ CURVI_POSTAL_ADDRESS: "[postal address]" }) });
    const held = await sendEmail(noAddress, { to: "lead@example.com", template: promo, data: {}, dedupeKey: "promo:held", workspaceId: null });
    expect(held).toMatchObject({ status: "disabled", reason: "not configured: CURVI_POSTAL_ADDRESS" });
    const noSecret = deps({ config: config({ CURVI_LINK_SECRET: undefined }) });
    expect((await sendEmail(noSecret, { to: "lead@example.com", template: promo, data: {}, dedupeKey: "promo:held", workspaceId: null })).status).toBe(
      "disabled",
    );
    expect((await sendEmail(noAddress, { to: "lead@example.com", template: tx, data: { n: 7 }, dedupeKey: "tx:held", workspaceId: null })).status).toBe(
      "sent",
    );
    const noSender = deps({ config: config({ LIFECYCLE_EMAIL_FROM: undefined }) });
    expect((await sendEmail(noSender, { to: "lead@example.com", template: tx, data: { n: 8 }, dedupeKey: "tx:nosender", workspaceId: null })).status).toBe(
      "disabled",
    );
    // Once configured, the held marketing email goes with both unsubscribe headers.
    expect((await sendEmail(deps(), { to: "lead@example.com", template: promo, data: {}, dedupeKey: "promo:held", workspaceId: null })).status).toBe(
      "sent",
    );
    const sent = calls[calls.length - 1];
    const headers = sent.body.headers as Record<string, string>;
    expect(headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    const token = decodeURIComponent(/t=([^>&]+)>/.exec(headers["List-Unsubscribe"])![1]);
    expect(verifyUnsubscribeToken("link-secret-for-tests", token)).toBe(normalizedEmailKey("lead@example.com"));
    expect(String(sent.body.text)).toContain("Curvi, PO Box 100, Springfield, IL 62701");
  });

  it("retries a failed send up to the attempt cap, then stops", async () => {
    answer = () => new Response("busy", { status: 503 });
    const input = { to: "retry@example.com", template: tx, data: { n: 9 }, dedupeKey: "retry:1", workspaceId: null };
    const limits = { maxAttempts: 2, staleClaimMinutes: 15, timeoutMs: 1000 };
    expect(await sendEmail(deps({ limits }), input)).toMatchObject({ status: "failed", retryable: true });
    expect((await sendEmail(deps({ limits }), input)).status).toBe("failed");
    expect((await sendEmail(deps({ limits }), input)).status).toBe("duplicate");
    expect(calls).toHaveLength(2);
    expect((await rows())[0]).toMatchObject({ status: "failed", attempts: 2 });
  });

  it("refuses something that is not an address without logging it", async () => {
    expect((await sendEmail(deps(), { to: "nobody", template: tx, data: { n: 1 }, dedupeKey: "bad:1", workspaceId: null })).status).toBe("invalid");
    expect(await rows()).toEqual([]);
  });

  it("counts today's sent emails for the daily cap", async () => {
    await sendEmail(deps(), { to: "count@example.com", template: tx, data: { n: 1 }, dedupeKey: "count:1", workspaceId: null });
    await sendEmail(deps({ enabled: async () => false }), { to: "count@example.com", template: tx, data: { n: 1 }, dedupeKey: "count:2", workspaceId: null });
    expect(await sentToday(db, new Date())).toBe(1);
  });
});

describe("suppressions", () => {
  it("widens to all mail but never narrows, and the settings toggle lifts only a marketing unsubscribe", async () => {
    const key = normalizedEmailKey("toggle@example.com") as string;
    await addSuppression(db, key, "marketing", "unsubscribed");
    expect(await liftMarketingSuppression(db, key)).toBe("lifted");
    expect(await liftMarketingSuppression(db, key)).toBe("none");
    await addSuppression(db, key, "all", "complained");
    await addSuppression(db, key, "marketing", "unsubscribed");
    expect(await suppressionOf(db, key)).toBe("all");
    expect(await liftMarketingSuppression(db, key)).toBe("blocked");
    expect(await suppressionOf(db, key)).toBe("all");
  });
});
