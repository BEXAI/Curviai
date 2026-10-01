/**
 * Command line for the live LLM eval (docs/phases/PHASE_17.md workstream 4).
 *
 *   pnpm eval --live --provider openai|anthropic [options]
 *
 * Off by default: plain pnpm eval never reaches this file. A live run calls
 * real models and spends real money, so it refuses to start in CI, inside a
 * test runner, or without the provider's key in the environment. It reads
 * only process.env, never an .env file.
 *
 * Options:
 *   --recipe key[@version]  Only this recipe (repeat or comma separate).
 *   --model id              Run every selected recipe on this model.
 *   --injection-only        Only the prompt injection fixtures.
 *   --no-injection          Leave the injection fixtures out.
 *   --baseline path         The stored Claude baseline (default below).
 *   --record-baseline       Save this run as the Claude baseline (anthropic).
 *   --record path           Save every answer, to score again with --replay.
 *   --replay path           Score a saved run; calls nothing, needs no key.
 *   --out dir               Where the report goes (default eval/output).
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { recipeSeedRows } from "../../src/seed/recipes";
import type { LlmProviderFamily } from "../../src/seed/models";
import {
  keyEnvFor,
  liveLlmProvider,
  recordingCaller,
  replayCaller,
  routedCaller,
  type LlmCaller,
  type Recording,
} from "./callers";
import { baselineFromReport, formatReport, runLiveEval, type Baseline, type LiveReport } from "./harness";
import { goldenCases } from "./cases";
import { injectionFixtures } from "./injection";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../../../..");
const OUTPUT_DIR = path.join(REPO_ROOT, "eval", "output");
export const DEFAULT_BASELINE_PATH = path.join(HERE, "baselines", "claude.json");

export interface LiveArgs {
  provider: LlmProviderFamily | null;
  only: string[];
  model: string | null;
  baselinePath: string;
  recordBaseline: boolean;
  recordPath: string | null;
  replayPath: string | null;
  injection: "with" | "without" | "only";
  outDir: string;
}

function isFamily(value: string): value is LlmProviderFamily {
  return value === "openai" || value === "anthropic";
}

/** The live mode's options. Throws with a plain message on a bad one. */
export function parseLiveArgs(argv: readonly string[]): LiveArgs {
  const args: LiveArgs = {
    provider: null,
    only: [],
    model: null,
    baselinePath: DEFAULT_BASELINE_PATH,
    recordBaseline: false,
    recordPath: null,
    replayPath: null,
    injection: "with",
    outDir: OUTPUT_DIR,
  };
  const valueOf = (i: number, flag: string): string => {
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${flag} needs a value.`);
    }
    return value;
  };
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].startsWith("--") && argv[i].includes("=") ? argv[i].split(/=(.*)/s, 2) : [argv[i], undefined];
    const take = (): string => {
      if (inline !== undefined) return inline;
      const value = valueOf(i, flag);
      i += 1;
      return value;
    };
    switch (flag) {
      case "--":
      case "--live":
        break;
      case "--provider": {
        const value = take();
        if (!isFamily(value)) throw new Error(`Unknown provider "${value}". Use openai or anthropic.`);
        args.provider = value;
        break;
      }
      case "--recipe":
        args.only.push(...take().split(",").filter((s) => s.length > 0));
        break;
      case "--model":
        args.model = take();
        break;
      case "--baseline":
        args.baselinePath = path.resolve(take());
        break;
      case "--record-baseline":
        args.recordBaseline = true;
        break;
      case "--record":
        args.recordPath = path.resolve(take());
        break;
      case "--replay":
        args.replayPath = path.resolve(take());
        break;
      case "--out":
        args.outDir = path.resolve(take());
        break;
      case "--injection-only":
        args.injection = "only";
        break;
      case "--no-injection":
        args.injection = "without";
        break;
      default:
        throw new Error(`Unknown option "${flag}" for the live eval.`);
    }
  }
  if (args.injection === "only" && args.recordBaseline) {
    throw new Error("--record-baseline needs the golden set; leave out --injection-only.");
  }
  if (!args.provider && !args.replayPath) {
    throw new Error("Choose a provider: --provider openai or --provider anthropic.");
  }
  if (args.replayPath && args.recordPath) {
    throw new Error("--replay and --record cannot be used together.");
  }
  return args;
}

/**
 * Why a live run must not start, or null when it may. A replay calls
 * nothing, so it needs no key and may run anywhere.
 */
export function liveRefusal(args: LiveArgs, env: Readonly<Record<string, string | undefined>>): string | null {
  if (args.recordBaseline && args.provider !== "anthropic") {
    return "The baseline holds Claude's answers: record it with --provider anthropic.";
  }
  if (args.replayPath) {
    return null;
  }
  if (env.VITEST || env.NODE_ENV === "test") {
    return "The live eval never runs inside tests.";
  }
  if (env.CI && env.CI !== "false" && env.CI !== "0") {
    return "The live eval is off in CI. Run it locally with real keys.";
  }
  const keyEnv = keyEnvFor(args.provider as LlmProviderFamily);
  if (!env[keyEnv]) {
    return `${keyEnv} is not set, so the live eval cannot call ${args.provider ?? "the provider"}.`;
  }
  return null;
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

/** A new baseline over the stored one: recipes and fixtures this run did
 * not cover keep their stored answers. */
export function mergeBaseline(stored: Baseline | null, fresh: Baseline): Baseline {
  if (!stored) return fresh;
  return {
    ...fresh,
    recipes: { ...stored.recipes, ...fresh.recipes },
    injection: { ...stored.injection, ...fresh.injection },
  };
}

/** Runs the live eval; returns the process exit code. */
export async function liveMain(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>> = process.env,
  log: (line: string) => void = console.log,
): Promise<number> {
  let args: LiveArgs;
  try {
    args = parseLiveArgs(argv);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 2;
  }
  const refusal = liveRefusal(args, env);
  if (refusal) {
    console.error(refusal);
    return 2;
  }

  let caller: LlmCaller;
  let recorder: ReturnType<typeof recordingCaller> | null = null;
  if (args.replayPath) {
    const recording = await readJson<Recording>(args.replayPath);
    if (!recording) {
      console.error(`No recording at ${args.replayPath}.`);
      return 2;
    }
    if (args.provider && args.provider !== recording.provider) {
      console.error(`The recording is a ${recording.provider} run, not ${args.provider}.`);
      return 2;
    }
    caller = replayCaller(recording);
  } else {
    const family = args.provider as LlmProviderFamily;
    const tasks = [...new Set(recipeSeedRows.map((row) => row.key))];
    caller = routedCaller(family, (model) => liveLlmProvider(family, model, { tasks }));
    if (args.recordPath) {
      recorder = recordingCaller(caller);
      caller = recorder.caller;
    }
  }

  const baseline = await readJson<Baseline>(args.baselinePath);
  log(`Curvi live LLM eval, provider ${caller.provider}${args.replayPath ? " (replay)" : ""}`);
  log(baseline ? `Claude baseline: ${args.baselinePath} (${baseline.recordedAt})` : "Claude baseline: none stored");
  const report: LiveReport = await runLiveEval({
    caller,
    rows: recipeSeedRows,
    cases: args.injection === "only" ? [] : await goldenCases(),
    injection: args.injection === "without" ? [] : await injectionFixtures(),
    baseline,
    ...(args.only.length > 0 ? { only: args.only } : {}),
    ...(args.model ? { model: args.model } : {}),
    log: (line) => log(`  ${line}`),
  });
  log("");
  for (const line of formatReport(report)) log(line);

  const reportPath = path.join(args.outDir, `live-${report.provider}-report.json`);
  await writeJson(reportPath, report);
  log(`Report: ${reportPath}`);
  if (recorder) {
    await writeJson(args.recordPath as string, recorder.recording());
    log(`Recording: ${args.recordPath as string}`);
  }
  if (args.recordBaseline) {
    await writeJson(args.baselinePath, mergeBaseline(baseline, baselineFromReport(report)));
    log(`Claude baseline saved: ${args.baselinePath}`);
    return 0;
  }
  return report.pass ? 0 : 1;
}
