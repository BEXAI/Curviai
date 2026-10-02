import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "@curvi/db/testing";
import { type Db } from "@curvi/db";
import { normalizedEmailKey } from "@curvi/email";
const stripe = vi.hoisted(() => ({ retrieve: vi.fn(), update: vi.fn() }));
vi.mock("@/lib/billing/stripe", () => ({ getStripe: () => ({ customers: stripe }) }));
vi.mock("@/lib/env", () => ({ hasStripeApiKey: () => true }));
import { carryEmailSuppression, finishEmailChange, rememberEmailChange } from "./email-change";
let test: Awaited<ReturnType<typeof createTestDb>>;
let db: Db;
const userId = "10000000-0000-4000-8000-000000000077";
const old = normalizedEmailKey("old@example.com")!;
const next = normalizedEmailKey("new@example.com")!;
beforeAll(async () => { test = await createTestDb(); db = test.db as unknown as Db; });
afterAll(async () => test.client.close());
beforeEach(async () => { vi.clearAllMocks(); await test.client.exec("delete from email_suppressions; delete from platform_settings where key like 'auth:email-change:%';"); });
describe("confirmed email change", () => {
  it("carries suppression without weakening all-mail blocks or freeing the old identity", async () => {
    await test.client.query("insert into email_suppressions(recipient_key,scope,reason) values ($1,'all','bounced'),($2,'marketing','unsubscribed')", [old, next]);
    await carryEmailSuppression(db, old, next);
    expect((await test.client.query("select scope from email_suppressions order by recipient_key")).rows).toEqual([{ scope: "all" }, { scope: "all" }]);
  });
  it("only syncs the confirmed address and the customer's old email", async () => {
    await test.client.query("insert into workspaces(id,name,stripe_customer_id) values ('20000000-0000-4000-8000-000000000077','Email test','cus_match'),('20000000-0000-4000-8000-000000000078','Team','cus_other')");
    await test.client.query("insert into members(workspace_id,user_id,role) values ('20000000-0000-4000-8000-000000000077',$1,'owner'),('20000000-0000-4000-8000-000000000078',$1,'admin')", [userId]);
    await rememberEmailChange(db, userId, "old@example.com", "new@example.com");
    await finishEmailChange(db, { id: userId, email: "not-the-pending@example.com", email_confirmed_at: "now" });
    expect(stripe.retrieve).not.toHaveBeenCalled();
    stripe.retrieve.mockImplementation(async (id: string) => ({ id, email: id === "cus_match" ? "old@example.com" : "billing@example.com" }));
    await finishEmailChange(db, { id: userId, email: "new@example.com", email_confirmed_at: "now" });
    expect(stripe.update).toHaveBeenCalledExactlyOnceWith("cus_match", { email: "new@example.com" });
    expect((await test.client.query("select key from platform_settings where key like 'auth:email-change:%'")).rows).toEqual([]);
  });
});
