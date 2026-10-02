/**
 * pnpm report:unit-economics --days 30 (docs/phases/PHASE_20.md P20-04): a
 * read only report of cost per delivered shot by method, cost per pack,
 * retry overhead, revenue per credit for every offer and the price rule for
 * a generative still. Run by the founder with DATABASE_URL set in the shell
 * (production is fine: every read runs in a READ ONLY transaction). It
 * never changes a price; a reprice is a seed change (decision 2).
 */

import { createDb } from "@curvi/db";
import { optionalEnv } from "@/lib/env";
import { formatUnitEconomicsReport, unitEconomicsReport } from "@/lib/ops/economics";
import { ScriptRefusal, parseScriptArgs, runScript } from "./cli";

void runScript(async (argv, io) => {
  const args = parseScriptArgs(argv, { days: { type: "string", default: "30" } });
  const days = Number(args.days);
  if (!Number.isInteger(days) || days < 1) {
    throw new ScriptRefusal("Usage: pnpm report:unit-economics --days <whole number of days, 1 or more>");
  }
  const url = optionalEnv("DATABASE_URL");
  if (!url) {
    throw new ScriptRefusal("Set DATABASE_URL in the shell first. Nothing is read from env files.");
  }
  const db = createDb(url, { max: 1, prepare: false });
  try {
    for (const line of formatUnitEconomicsReport(await unitEconomicsReport(db, days))) io.out(line);
  } finally {
    await db.$client.end();
  }
});
