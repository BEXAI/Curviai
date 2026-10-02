/**
 * pnpm billing:verify --workspace <id> (docs/phases/PHASE_20.md P20-03):
 * prints a workspace's plan, subscription, ledger by reason and last billing
 * events, so docs/STRIPE_SETUP.md section 8 is checked by a script. Read
 * only. Needs DATABASE_URL in the shell (the local stack during the test
 * mode run, with the Stripe CLI forwarding webhooks to the laptop).
 */

import { createDb } from "@curvi/db";
import { formatBillingVerification, loadBillingVerification } from "@/lib/billing/verify";
import { optionalEnv } from "@/lib/env";
import { ScriptRefusal, parseScriptArgs, runScript } from "./cli";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

void runScript(async (argv, io) => {
  const args = parseScriptArgs(argv, { workspace: { type: "string" } });
  const workspaceId = args.workspace?.trim();
  if (!workspaceId || !UUID.test(workspaceId)) {
    throw new ScriptRefusal("Usage: pnpm billing:verify --workspace <workspace uuid>");
  }
  const url = optionalEnv("DATABASE_URL");
  if (!url) {
    throw new ScriptRefusal("Set DATABASE_URL in the shell first. Nothing is read from env files.");
  }
  const db = createDb(url, { max: 1, prepare: false });
  try {
    const report = await loadBillingVerification(db, workspaceId);
    if (!report) {
      throw new ScriptRefusal(`No workspace ${workspaceId}.`);
    }
    for (const line of formatBillingVerification(report)) io.out(line);
  } finally {
    await db.$client.end();
  }
});
