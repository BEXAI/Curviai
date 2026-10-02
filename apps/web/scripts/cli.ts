/**
 * The shared runner for the founder's command line scripts in this folder
 * (docs/phases/PHASE_20.md, "Starting point", Scripts). Each script is an
 * `@curvi/web` package script run with tsx, which resolves the `@/` alias
 * from apps/web/tsconfig.json, and has a root alias:
 *
 *   pnpm billing:verify --workspace <id>
 *   = pnpm --filter @curvi/web billing:verify --workspace <id>
 *   = tsx scripts/billing-verify.ts --workspace <id>   (in apps/web)
 *
 * One off scripts run the same way: pnpm web:script scripts/<file>.ts.
 * Variables come from the shell (DATABASE_URL, OPS_OPERATOR_EMAIL and so
 * on); scripts never read env files. Imports under @/lib/ops/ are allowed
 * here (the lib/ops boundary test).
 *
 * A script exports nothing and ends with:
 *
 *   void runScript(async (argv) => { ... });
 */

import { parseArgs, type ParseArgsConfig } from "node:util";

/** A refusal the script explains to the operator: printed without a stack
 * trace, exit code 1. */
export class ScriptRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScriptRefusal";
  }
}

export interface ScriptIo {
  out(line: string): void;
  err(line: string): void;
}

const consoleIo: ScriptIo = {
  out: (line) => console.log(line),
  err: (line) => console.error(line),
};

export interface RunScriptOptions {
  /** The arguments after the script name; process.argv.slice(2) by default. */
  argv?: string[];
  io?: ScriptIo;
  /** Sets the exit code; process.exitCode by default, so output flushes. */
  setExitCode?: (code: number) => void;
}

/**
 * Runs `main` with the arguments and turns the outcome into an exit code:
 * the number it returns (0 when it returns nothing), 1 with the message for
 * a ScriptRefusal, 1 with the error for anything else. Resolves to the code.
 */
export async function runScript(
  main: (argv: string[], io: ScriptIo) => Promise<number | void>,
  options: RunScriptOptions = {},
): Promise<number> {
  const io = options.io ?? consoleIo;
  const setExitCode =
    options.setExitCode ??
    ((code: number) => {
      process.exitCode = code;
    });
  let code: number;
  try {
    code = (await main(options.argv ?? process.argv.slice(2), io)) ?? 0;
  } catch (err) {
    code = 1;
    if (err instanceof ScriptRefusal) {
      io.err(err.message);
    } else {
      io.err(`Failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    }
  }
  setExitCode(code);
  return code;
}

/**
 * Parses `--name value` flags strictly: an unknown flag or a stray
 * positional argument is a ScriptRefusal that names it.
 */
export function parseScriptArgs<T extends NonNullable<ParseArgsConfig["options"]>>(argv: string[], options: T) {
  try {
    return parseArgs({ args: argv, options, strict: true, allowPositionals: false }).values;
  } catch (err) {
    throw new ScriptRefusal(err instanceof Error ? err.message : String(err));
  }
}
