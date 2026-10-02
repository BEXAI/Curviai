/**
 * pnpm ops:grant-credits --workspace <id> --credits <n> --note "<text>" [--key <uuid>]
 * (docs/phases/PHASE_20.md P20-66): an audited operator credit grant, run
 * by the founder with DATABASE_URL and OPS_OPERATOR_EMAIL set (that email
 * listed in OPS_EMAILS). The work is in grant-credits-command.ts.
 */

import { runScript } from "./cli";
import { grantCreditsCommand } from "./grant-credits-command";

void runScript((argv, io) => grantCreditsCommand(argv, io));
