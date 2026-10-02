import { createDb } from "@curvi/db";
import { optionalEnv } from "@/lib/env";
import { isBillingCadence, isPaidTierKey } from "@/lib/billing/plans";
import { getStripe } from "@/lib/billing/stripe";
import { runRenewalNotices, validatePriceNotice } from "@/lib/billing/renewal-notices";
import { ScriptRefusal, parseScriptArgs, runScript } from "./cli";

void runScript(async (argv, io) => {
  const args = parseScriptArgs(argv, { tier: { type: "string" }, cadence: { type: "string" }, "new-usd": { type: "string" }, effective: { type: "string" }, "dry-run": { type: "boolean" } });
  if (!isPaidTierKey(args.tier) || !isBillingCadence(args.cadence) || !args.effective || !/^\d{4}-\d{2}-\d{2}$/.test(args.effective)) {
    throw new ScriptRefusal("Usage: pnpm billing:price-notice --tier <tier> --cadence <monthly|annual> --new-usd <period price> --effective <YYYY-MM-DD> [--dry-run]");
  }
  const effective = new Date(`${args.effective}T00:00:00.000Z`);
  if (!Number.isFinite(effective.getTime()) || effective.toISOString().slice(0, 10) !== args.effective) throw new ScriptRefusal("Use a real calendar date.");
  const priceChange = { tier: args.tier, cadence: args.cadence, newUsd: Number(args["new-usd"]), effective };
  validatePriceNotice(priceChange, new Date());
  const url = optionalEnv("DATABASE_URL");
  if (!url) throw new ScriptRefusal("Set DATABASE_URL in the shell first. Env files are not read.");
  const db = createDb(url, { max: 1, prepare: false });
  try {
    const report = await runRenewalNotices({ db, stripe: getStripe(), priceChange, dryRun: args["dry-run"] === true });
    io.out(JSON.stringify(report));
    return report.failed ? 1 : 0;
  } finally { await db.$client.end(); }
});
