import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizedEmailKey } from "@curvi/email";
import { EMAIL_SETTINGS_BLOCKED, EMAIL_SETTINGS_NO_ACCOUNT, EMAIL_SETTINGS_SAVED_OFF, EMAIL_SETTINGS_SAVED_ON } from "@/lib/email/copy";
import { MemorySuppressionStore, marketingAllowed, setSuppressionStoreForTests } from "@/lib/email/preferences";

// The settings toggle "Emails from Curvi with listing image tips and offers"
// (P18-06): off writes a marketing suppression for the signed in address, on
// lifts it, and a bounce or complaint stop is never lifted here.

const session = vi.hoisted(() => ({ user: null as { id: string; email: string } | null }));

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/navigation", () => ({ redirect: () => {} }));
vi.mock("@/lib/services", () => ({ isDbMode: () => true, getServices: () => ({}) }));
vi.mock("@/lib/services/db", () => ({ getDb: () => null }));
vi.mock("@/lib/supabase/server", () => ({
  getSessionUser: async () => session.user,
  createSupabaseServerClient: async () => null,
}));

const { setMarketingEmailAction } = await import("./actions");

let store: MemorySuppressionStore;

beforeEach(() => {
  store = new MemorySuppressionStore();
  setSuppressionStoreForTests(store);
  session.user = { id: "user-1", email: "Seller+shop@Gmail.com" };
});

afterEach(() => {
  setSuppressionStoreForTests(null);
});

describe("setMarketingEmailAction", () => {
  it("turns tips and offers off and on for the signed in address", async () => {
    expect(await marketingAllowed(session.user!.email, store)).toBe(true);
    expect(await setMarketingEmailAction(false)).toEqual({ ok: true, notice: EMAIL_SETTINGS_SAVED_OFF });
    expect(store.rows.get(normalizedEmailKey("seller@gmail.com") as string)).toEqual({ scope: "marketing", reason: "unsubscribed" });
    expect(await marketingAllowed(session.user!.email, store)).toBe(false);
    expect(await setMarketingEmailAction(true)).toEqual({ ok: true, notice: EMAIL_SETTINGS_SAVED_ON });
    expect(store.rows.size).toBe(0);
  });

  it("never lifts a stop on all mail after a bounce or a complaint", async () => {
    await store.add(normalizedEmailKey(session.user!.email) as string, "all", "complained");
    expect(await setMarketingEmailAction(true)).toEqual({ ok: false, notice: EMAIL_SETTINGS_BLOCKED });
    expect(await marketingAllowed(session.user!.email, store)).toBe(false);
  });

  it("does nothing without a signed in user", async () => {
    session.user = null;
    expect(await setMarketingEmailAction(false)).toEqual({ ok: false, notice: EMAIL_SETTINGS_NO_ACCOUNT });
    expect(store.rows.size).toBe(0);
  });
});
