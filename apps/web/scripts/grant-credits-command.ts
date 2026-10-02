/**
 * The body of pnpm ops:grant-credits (docs/phases/PHASE_20.md P20-66),
 * apart from scripts/grant-credits.ts so it can be tested without running.
 *
 *   pnpm ops:grant-credits --workspace <id> --credits <n> --note "<text>" [--key <uuid>]
 *
 * Run by the founder with DATABASE_URL (the database to grant in) and
 * OPS_OPERATOR_EMAIL set in the shell; that email must be listed in
 * OPS_EMAILS, also set in the shell. A negative number takes credits back
 * and is written with an equals sign: --credits=-50. Every run prints its
 * key first, so a run that stops part way can be repeated with --key and
 * grants at most once; then the balance before and after.
 */

import { randomUUID } from "node:crypto";
import { createDb, type Db } from "@curvi/db";
import { optionalEnv } from "@/lib/env";
import { opsEmails } from "@/lib/ops";
import { GrantRefusal, grantCredits, grantOutcomeText } from "@/lib/ops/grants";
import { ScriptRefusal, parseScriptArgs, type ScriptIo } from "./cli";

export const GRANT_USAGE =
  'Usage: pnpm ops:grant-credits --workspace <id> --credits <n> --note "<text>" [--key <uuid>]. Take credits back with a negative number written as --credits=-50.';

export interface GrantCommandDeps {
  /** Opens the database; createDb over postgres.js by default. */
  connect?: (url: string) => { db: Db; close: () => Promise<void> };
  newKey?: () => string;
  now?: () => Date;
}

function connectDefault(url: string): { db: Db; close: () => Promise<void> } {
  // One connection, no prepared statements, so any Supabase pooler works.
  const db = createDb(url, { max: 1, prepare: false });
  return { db, close: () => db.$client.end({ timeout: 5 }) };
}

/** Credits as typed: a whole number or one decimal place, either sign. */
function parseCredits(text: string): number {
  const trimmed = text.trim();
  if (!/^[+-]?\d{1,6}(\.\d)?$/.test(trimmed) || Number(trimmed) === 0) {
    throw new ScriptRefusal(
      `--credits must be a number other than zero, with at most one decimal place, not "${text}". ${GRANT_USAGE}`,
    );
  }
  return Number(trimmed);
}

export async function grantCreditsCommand(argv: string[], io: ScriptIo, deps: GrantCommandDeps = {}): Promise<number> {
  const args = parseScriptArgs(argv, {
    workspace: { type: "string" },
    credits: { type: "string" },
    note: { type: "string" },
    key: { type: "string" },
  });
  if (!args.workspace || args.credits === undefined || args.note === undefined) {
    throw new ScriptRefusal(GRANT_USAGE);
  }
  const credits = parseCredits(args.credits);

  const url = optionalEnv("DATABASE_URL");
  if (!url) {
    throw new ScriptRefusal("Set DATABASE_URL in this shell to the database to grant in.");
  }
  const operator = optionalEnv("OPS_OPERATOR_EMAIL")?.trim().toLowerCase();
  if (!operator) {
    throw new ScriptRefusal("Set OPS_OPERATOR_EMAIL in this shell to your operator email.");
  }
  if (!opsEmails().includes(operator)) {
    throw new ScriptRefusal(
      `OPS_OPERATOR_EMAIL (${operator}) is not listed in OPS_EMAILS. Set OPS_EMAILS in this shell to the same list as on Render.`,
    );
  }

  const key = args.key?.trim() || (deps.newKey ?? randomUUID)();
  io.out(
    `Grant key ${key}. If this command stops before it prints a result, run it again with --key ${key} and the grant is made at most once.`,
  );

  const { db, close } = (deps.connect ?? connectDefault)(url);
  try {
    const outcome = await grantCredits(
      db,
      { workspaceId: args.workspace.trim(), credits, note: args.note, operator, key },
      (deps.now ?? (() => new Date()))(),
    );
    io.out(grantOutcomeText(outcome));
    return 0;
  } catch (err) {
    if (err instanceof GrantRefusal) {
      throw new ScriptRefusal(err.message);
    }
    throw err;
  } finally {
    await close();
  }
}
