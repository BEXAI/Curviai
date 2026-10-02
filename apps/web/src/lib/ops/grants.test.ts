import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { creditLedger, eq, events, opsAudit, sql, workspaces, type Db } from "@curvi/db";
import { createTestDb } from "@curvi/db/testing";
import { opsGrants } from "@curvi/pipeline/seed";
import {
  CORRECT_ACTION,
  GRANT_ACTION,
  GRANT_NOTE_MAX,
  GrantRefusal,
  grantCredits,
  grantOutcomeText,
  monthStartUtc,
  type GrantOutcome,
  type GrantRefusalCode,
} from "./grants";

// docs/phases/PHASE_20.md P20-66: an operator grant writes one ledger row
// and one ops_audit row, once per key, inside the seed's caps; a negative
// correction never takes the balance below zero; only OPS_EMAILS may grant.

const OPERATOR = "founder@curvi.ai";
const OCTOBER = new Date("2026-10-01T15:00:00Z");
const NOVEMBER = new Date("2026-11-01T00:00:00Z");
const KEY = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

let created: Awaited<ReturnType<typeof createTestDb>>;
let db: Db;
let keyCounter = 100;

function nextKey(): string {
  keyCounter += 1;
  return KEY(keyCounter);
}

async function newWorkspace(name: string, startingCredits = 0): Promise<string> {
  const [row] = await created.db.insert(workspaces).values({ name }).returning({ id: workspaces.id });
  if (startingCredits) {
    await created.db.insert(creditLedger).values({ workspaceId: row!.id, delta: startingCredits, reason: "grant", source: "stripe" });
  }
  return row!.id;
}

async function ledgerOf(workspaceId: string) {
  return created.db.select().from(creditLedger).where(eq(creditLedger.workspaceId, workspaceId));
}

async function auditRows() {
  return created.db.select().from(opsAudit).orderBy(opsAudit.id);
}

async function balance(workspaceId: string): Promise<number> {
  const rows = await ledgerOf(workspaceId);
  return rows.reduce((sum, row) => sum + Number(row.delta), 0);
}

async function refusal(promise: Promise<unknown>): Promise<GrantRefusalCode> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof GrantRefusal) return err.code;
    throw err;
  }
  throw new Error("expected a refusal");
}

beforeAll(async () => {
  created = await createTestDb();
  db = created.db as unknown as Db;
});

afterAll(async () => {
  await created.client.close();
});

beforeEach(() => {
  vi.stubEnv("OPS_EMAILS", `${OPERATOR}, ops@curvi.ai`);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("grantCredits", () => {
  it("grants once with one ledger row, one audit row and a claim that names no operator", async () => {
    const ws = await newWorkspace("Concierge");
    const key = nextKey();
    const outcome = await grantCredits(
      db,
      { workspaceId: ws, credits: 300, note: " Concierge packs (MKT-015) ", operator: " Founder@Curvi.ai ", key },
      OCTOBER,
    );
    expect(outcome).toEqual({
      status: "granted",
      key,
      workspaceId: ws,
      workspaceName: "Concierge",
      credits: 300,
      applied: 300,
      balanceBefore: 0,
      balanceAfter: 300,
      leftThisMonth: opsGrants.maxCreditsPerMonth - 300,
    });

    const ledger = await ledgerOf(ws);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ delta: 300, reason: "grant", source: "system", stepKey: `ops_grant:${key}`, expiresAt: null });

    const audit = (await auditRows()).filter((row) => row.workspaceId === ws);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      operatorEmail: OPERATOR,
      action: GRANT_ACTION,
      targetKind: "workspace",
      targetId: ws,
      forced: false,
      detail: { key, credits: 300, applied: 300, note: "Concierge packs (MKT-015)", balanceBefore: 0, balanceAfter: 300 },
    });
    expect(audit[0]!.at.toISOString()).toBe(OCTOBER.toISOString());
    // No customer content in the trail: the workspace is kept by id only.
    expect(Object.keys(audit[0]!.detail).sort()).toEqual(["applied", "balanceAfter", "balanceBefore", "credits", "key", "note"]);

    const [claim] = await created.db.select().from(events).where(eq(events.name, `billing:system:ops_grant:${key}`));
    // The claim is readable by every member, clients too: no operator note
    // in it, only a neutral label (security review 11).
    expect(claim).toMatchObject({ workspaceId: ws, props: { kind: "ops_grant", credits: 300, applied: 300, label: "Credits added by Curvi" } });
    expect(JSON.stringify(claim?.props)).not.toContain("Concierge");
    expect(JSON.stringify(claim!.props)).not.toContain("curvi.ai");
  });

  it("writes nothing for a repeat with the same key, and refuses the key for another grant", async () => {
    const ws = await newWorkspace("Repeat");
    const key = nextKey();
    const first = await grantCredits(db, { workspaceId: ws, credits: 50, note: "Goodwill", operator: OPERATOR, key }, OCTOBER);
    const auditBefore = (await auditRows()).length;
    const again = await grantCredits(db, { workspaceId: ws, credits: 50, note: "Goodwill", operator: OPERATOR, key }, OCTOBER);
    expect(again).toMatchObject({ status: "duplicate", applied: 50, balanceBefore: 0, balanceAfter: 50, workspaceName: "Repeat" });
    expect(again.leftThisMonth).toBe(first.leftThisMonth);
    expect(await ledgerOf(ws)).toHaveLength(1);
    expect(await auditRows()).toHaveLength(auditBefore);

    expect(await refusal(grantCredits(db, { workspaceId: ws, credits: 60, note: "Goodwill", operator: OPERATOR, key }, OCTOBER))).toBe(
      "key_reused",
    );
    const other = await newWorkspace("Other");
    expect(
      await refusal(grantCredits(db, { workspaceId: other, credits: 50, note: "Goodwill", operator: OPERATOR, key }, OCTOBER)),
    ).toBe("key_reused");
    expect(await ledgerOf(other)).toHaveLength(0);
  });

  it("refuses a key whose claim it did not write", async () => {
    const ws = await newWorkspace("Forged");
    const key = nextKey();
    // events is member insertable: a claim row with no audit row is not ours.
    await created.db.insert(events).values({ workspaceId: ws, name: `billing:system:ops_grant:${key}`, props: { kind: "ops_grant" } });
    expect(await refusal(grantCredits(db, { workspaceId: ws, credits: 10, note: "x", operator: OPERATOR, key }, OCTOBER))).toBe(
      "key_reused",
    );
    expect(await ledgerOf(ws)).toHaveLength(0);
  });

  it("refuses a grant over the per grant cap or the month's cap, naming what is left, and writes nothing", async () => {
    const ws = await newWorkspace("Caps");
    const before = (await auditRows()).length;
    const overOne = grantCredits(
      db,
      { workspaceId: ws, credits: opsGrants.maxCreditsPerGrant + 1, note: "Too much", operator: OPERATOR, key: nextKey() },
      OCTOBER,
    );
    await expect(overOne).rejects.toThrow(/at most 600 credits.*credits are left this month/);
    expect(
      await refusal(
        grantCredits(db, { workspaceId: ws, credits: -(opsGrants.maxCreditsPerGrant + 1), note: "Too much", operator: OPERATOR, key: nextKey() }, OCTOBER),
      ),
    ).toBe("over_grant_cap");

    // Fill October up to the cap with grants of at most one grant's size.
    const used = await created.db.execute(
      sql`select coalesce(sum((detail->>'applied')::numeric), 0) as used from ops_audit where action = ${GRANT_ACTION}`,
    );
    let left = opsGrants.maxCreditsPerMonth - Number((used as unknown as { rows: Array<{ used: string }> }).rows[0]!.used);
    while (left > 0) {
      const amount = Math.min(left, opsGrants.maxCreditsPerGrant);
      const outcome = await grantCredits(db, { workspaceId: ws, credits: amount, note: "Fill", operator: OPERATOR, key: nextKey() }, OCTOBER);
      left -= amount;
      expect(outcome.leftThisMonth).toBe(left);
    }
    const ledgerFull = (await ledgerOf(ws)).length;
    const auditFull = (await auditRows()).length;
    expect(auditFull).toBeGreaterThan(before);
    await expect(
      grantCredits(db, { workspaceId: ws, credits: 1, note: "One more", operator: OPERATOR, key: nextKey() }, OCTOBER),
    ).rejects.toThrow(`Only 0 credits are left this month under the grant cap of ${opsGrants.maxCreditsPerMonth}`);
    expect((await ledgerOf(ws)).length).toBe(ledgerFull);
    expect((await auditRows()).length).toBe(auditFull);

    // A correction is not a grant: it still works with the month used up.
    const corrected = await grantCredits(db, { workspaceId: ws, credits: -5, note: "Typo", operator: OPERATOR, key: nextKey() }, OCTOBER);
    expect(corrected).toMatchObject({ status: "corrected", applied: -5, leftThisMonth: 0 });

    // The cap starts again with the next calendar month (UTC).
    const november = await grantCredits(db, { workspaceId: ws, credits: 25, note: "New month", operator: OPERATOR, key: nextKey() }, NOVEMBER);
    expect(november).toMatchObject({ status: "granted", leftThisMonth: opsGrants.maxCreditsPerMonth - 25 });
  });

  it("never takes the balance below zero with a negative correction", async () => {
    const ws = await newWorkspace("Correct", 40);
    const outcome = await grantCredits(
      db,
      { workspaceId: ws, credits: -100, note: "Granted twice by mistake", operator: OPERATOR, key: nextKey() },
      NOVEMBER,
    );
    expect(outcome).toMatchObject({ status: "corrected", credits: -100, applied: -40, balanceBefore: 40, balanceAfter: 0 });
    expect(await balance(ws)).toBe(0);
    const refund = (await ledgerOf(ws)).find((row) => row.reason === "refund");
    expect(refund).toMatchObject({ delta: -40, source: "system" });
    const audit = (await auditRows()).filter((row) => row.workspaceId === ws);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: CORRECT_ACTION, detail: { credits: -100, applied: -40 } });
    expect(grantOutcomeText(outcome)).toContain("You asked for 100");

    expect(
      await refusal(grantCredits(db, { workspaceId: ws, credits: -1, note: "Again", operator: OPERATOR, key: nextKey() }, NOVEMBER)),
    ).toBe("nothing_to_take");
    expect(await balance(ws)).toBe(0);
  });

  it("takes back half credits exactly", async () => {
    const ws = await newWorkspace("Halves", 2.3);
    const outcome = await grantCredits(db, { workspaceId: ws, credits: -5, note: "Half", operator: OPERATOR, key: nextKey() }, NOVEMBER);
    expect(outcome).toMatchObject({ applied: -2.3, balanceAfter: 0 });
    expect(await balance(ws)).toBeCloseTo(0, 6);
  });

  it("refuses an operator not in OPS_EMAILS, before anything is written", async () => {
    const ws = await newWorkspace("Gate");
    for (const operator of ["seller@example.com", "", "founder@curvi.ai.evil.com"]) {
      expect(await refusal(grantCredits(db, { workspaceId: ws, credits: 10, note: "x", operator, key: nextKey() }, NOVEMBER))).toBe(
        "not_operator",
      );
    }
    vi.stubEnv("OPS_EMAILS", "");
    vi.stubEnv("OPS_EMAIL", "");
    expect(
      await refusal(grantCredits(db, { workspaceId: ws, credits: 10, note: "x", operator: OPERATOR, key: nextKey() }, NOVEMBER)),
    ).toBe("not_operator");
    expect(await ledgerOf(ws)).toHaveLength(0);
  });

  it("refuses input it cannot write", async () => {
    const ws = await newWorkspace("Input");
    const base = { workspaceId: ws, credits: 10, note: "Fine", operator: OPERATOR };
    const cases: Array<[Partial<typeof base> & { key?: string }, GrantRefusalCode]> = [
      [{ workspaceId: "not-a-uuid" }, "invalid_workspace"],
      [{ workspaceId: KEY(999_999) }, "no_workspace"],
      [{ credits: 0 }, "invalid_credits"],
      [{ credits: 1.25 }, "invalid_credits"],
      [{ credits: Number.NaN }, "invalid_credits"],
      [{ credits: Number.POSITIVE_INFINITY }, "invalid_credits"],
      [{ note: "   " }, "invalid_note"],
      [{ note: "n".repeat(GRANT_NOTE_MAX + 1) }, "invalid_note"],
      [{ key: "retry-1" }, "invalid_key"],
    ];
    for (const [change, code] of cases) {
      expect(await refusal(grantCredits(db, { ...base, key: nextKey(), ...change }, NOVEMBER)), JSON.stringify(change)).toBe(code);
    }
    expect(await ledgerOf(ws)).toHaveLength(0);
  });

  it("makes a key when none is given", async () => {
    const ws = await newWorkspace("Keyless");
    const outcome = await grantCredits(db, { workspaceId: ws, credits: 1.5, note: "Small", operator: OPERATOR }, NOVEMBER);
    expect(outcome.key).toMatch(/^[0-9a-f-]{36}$/);
    expect(outcome.applied).toBe(1.5);
  });
});

describe("monthStartUtc", () => {
  it("is the first instant of the UTC calendar month", () => {
    expect(monthStartUtc(new Date("2026-10-31T23:59:59Z")).toISOString()).toBe("2026-10-01T00:00:00.000Z");
    expect(monthStartUtc(new Date("2026-11-01T00:00:00Z")).toISOString()).toBe("2026-11-01T00:00:00.000Z");
  });
});

describe("grantOutcomeText", () => {
  const base: GrantOutcome = {
    status: "granted",
    key: KEY(1),
    workspaceId: KEY(2),
    workspaceName: "Acme",
    credits: 300,
    applied: 300,
    balanceBefore: 12.5,
    balanceAfter: 312.5,
    leftThisMonth: 1700,
  };

  it("says what was granted, the balance before and after and what is left", () => {
    expect(grantOutcomeText(base)).toBe(
      `Granted 300 credits to Acme (${KEY(2)}). Balance 12.5 to 312.5. 1700 credits left this month under the grant cap.`,
    );
    expect(grantOutcomeText({ ...base, status: "corrected", credits: -10, applied: -10, balanceAfter: 2.5 })).toBe(
      `Took back 10 credits from Acme (${KEY(2)}). Balance 12.5 to 2.5. 1700 credits left this month under the grant cap.`,
    );
    expect(grantOutcomeText({ ...base, status: "duplicate" })).toMatch(/^Key .* was already used for this grant, so nothing changed\. It granted 300 credits to Acme/);
  });

  it("follows rule 9 apart from command line flags", () => {
    const forbidden = /[‒-―←-⇿⟵-⟿]|\s-\s|--|\p{Extended_Pictographic}/u;
    const texts = [
      grantOutcomeText(base),
      grantOutcomeText({ ...base, status: "corrected", credits: -100, applied: -40, balanceAfter: 0 }),
      grantOutcomeText({ ...base, status: "duplicate" }),
      grantOutcomeText({ ...base, status: "duplicate", applied: -4 }),
    ];
    for (const text of texts) {
      expect(text.replace(/--[a-z]+/g, "FLAG")).not.toMatch(forbidden);
    }
  });
});
