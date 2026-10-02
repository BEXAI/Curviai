import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { creditLedger, eq, opsAudit, workspaces, type Db } from "@curvi/db";
import { createTestDb } from "@curvi/db/testing";
import { ScriptRefusal, runScript, type ScriptIo } from "./cli";
import { GRANT_USAGE, grantCreditsCommand, type GrantCommandDeps } from "./grant-credits-command";

// docs/phases/PHASE_20.md P20-66: pnpm ops:grant-credits, run by the founder
// with DATABASE_URL and OPS_OPERATOR_EMAIL (listed in OPS_EMAILS). It prints
// its key first and then the balance before and after.

const KEY = "00000000-0000-4000-8000-0000000066aa";
const NOW = new Date("2026-10-02T09:00:00Z");

let created: Awaited<ReturnType<typeof createTestDb>>;
let workspaceId: string;
const closes = vi.fn(async () => {});

function capture(): ScriptIo & { lines: string[] } {
  const lines: string[] = [];
  return { lines, out: (line) => lines.push(`out: ${line}`), err: (line) => lines.push(`err: ${line}`) };
}

function deps(): GrantCommandDeps {
  return {
    connect: () => ({ db: created.db as unknown as Db, close: closes }),
    newKey: () => KEY,
    now: () => NOW,
  };
}

async function run(argv: string[]) {
  const io = capture();
  const code = await runScript((args, out) => grantCreditsCommand(args, out, deps()), { argv, io, setExitCode: () => {} });
  return { code, lines: io.lines };
}

beforeAll(async () => {
  created = await createTestDb();
  const [row] = await created.db.insert(workspaces).values({ name: "Founder workspace" }).returning({ id: workspaces.id });
  workspaceId = row!.id;
});

afterAll(async () => {
  await created.client.close();
});

beforeEach(() => {
  vi.stubEnv("DATABASE_URL", "postgres://localhost:5432/never-opened");
  vi.stubEnv("OPS_EMAILS", "founder@curvi.ai");
  vi.stubEnv("OPS_OPERATOR_EMAIL", "Founder@Curvi.ai");
  closes.mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("pnpm ops:grant-credits", () => {
  it("grants, printing the key first and then the balance before and after", async () => {
    const { code, lines } = await run(["--workspace", workspaceId, "--credits", "300", "--note", "Concierge packs"]);
    expect(code).toBe(0);
    expect(lines).toEqual([
      `out: Grant key ${KEY}. If this command stops before it prints a result, run it again with --key ${KEY} and the grant is made at most once.`,
      `out: Granted 300 credits to Founder workspace (${workspaceId}). Balance 0 to 300. 1700 credits left this month under the grant cap.`,
    ]);
    expect(closes).toHaveBeenCalledTimes(1);
    const ledger = await created.db.select().from(creditLedger).where(eq(creditLedger.workspaceId, workspaceId));
    expect(ledger.map((row) => Number(row.delta))).toEqual([300]);
    const audit = await created.db.select().from(opsAudit).where(eq(opsAudit.workspaceId, workspaceId));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ operatorEmail: "founder@curvi.ai", action: "credits.grant" });
  });

  it("grants nothing more when run again with the printed key", async () => {
    const { code, lines } = await run(["--workspace", workspaceId, "--credits", "300", "--note", "Concierge packs", "--key", KEY]);
    expect(code).toBe(0);
    expect(lines[1]).toMatch(/^out: Key .* was already used for this grant, so nothing changed\./);
    const ledger = await created.db.select().from(creditLedger).where(eq(creditLedger.workspaceId, workspaceId));
    expect(ledger).toHaveLength(1);
  });

  it("takes credits back with --credits=-n", async () => {
    const { code, lines } = await run([
      "--workspace",
      workspaceId,
      "--credits=-20.5",
      "--note",
      "Correction",
      "--key",
      "00000000-0000-4000-8000-0000000066ab",
    ]);
    expect(code).toBe(0);
    expect(lines[1]).toBe(
      `out: Took back 20.5 credits from Founder workspace (${workspaceId}). Balance 300 to 279.5. 1700 credits left this month under the grant cap.`,
    );
  });

  it("refuses without the arguments, with an unknown flag or with credits it cannot read", async () => {
    for (const argv of [
      [],
      ["--workspace", workspaceId, "--credits", "10"],
      ["--workspace", workspaceId, "--credits", "10", "--note", "x", "--force"],
      ["--workspace", workspaceId, "--credits", "ten", "--note", "x"],
      ["--workspace", workspaceId, "--credits", "0", "--note", "x"],
      ["--workspace", workspaceId, "--credits", "1.25", "--note", "x"],
    ]) {
      const { code, lines } = await run(argv);
      expect(code, argv.join(" ")).toBe(1);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(/^err: /);
    }
    expect((await run([])).lines[0]).toBe(`err: ${GRANT_USAGE}`);
    expect(closes).not.toHaveBeenCalled();
  });

  it("refuses without DATABASE_URL or OPS_OPERATOR_EMAIL, or with an operator not in OPS_EMAILS", async () => {
    const argv = ["--workspace", workspaceId, "--credits", "10", "--note", "x"];
    vi.stubEnv("DATABASE_URL", "");
    expect((await run(argv)).lines).toEqual(["err: Set DATABASE_URL in this shell to the database to grant in."]);
    vi.stubEnv("DATABASE_URL", "postgres://localhost:5432/never-opened");
    vi.stubEnv("OPS_OPERATOR_EMAIL", "");
    expect((await run(argv)).lines).toEqual(["err: Set OPS_OPERATOR_EMAIL in this shell to your operator email."]);
    vi.stubEnv("OPS_OPERATOR_EMAIL", "seller@example.com");
    expect((await run(argv)).lines[0]).toMatch(/^err: OPS_OPERATOR_EMAIL \(seller@example\.com\) is not listed in OPS_EMAILS/);
    expect(closes).not.toHaveBeenCalled();
  });

  it("prints a refusal from the grant and still closes the connection", async () => {
    const { code, lines } = await run([
      "--workspace",
      "00000000-0000-4000-8000-0000000066ff",
      "--credits",
      "10",
      "--note",
      "x",
      "--key",
      "00000000-0000-4000-8000-0000000066ac",
    ]);
    expect(code).toBe(1);
    expect(lines.at(-1)).toBe("err: No workspace has the id 00000000-0000-4000-8000-0000000066ff.");
    expect(closes).toHaveBeenCalledTimes(1);
  });

  it("turns only grant refusals into plain refusals", async () => {
    const failing: GrantCommandDeps = {
      ...deps(),
      connect: () => ({
        db: { transaction: async () => Promise.reject(new Error("connection refused")) } as unknown as Db,
        close: closes,
      }),
    };
    await expect(
      grantCreditsCommand(["--workspace", workspaceId, "--credits", "10", "--note", "x"], capture(), failing),
    ).rejects.not.toBeInstanceOf(ScriptRefusal);
    expect(closes).toHaveBeenCalledTimes(1);
  });
});
