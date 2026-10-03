import { realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { collectInventory, isPublicCandidateUrl } from "./inventory";
import { configuredKey, initializeState, recordIndexing, refreshState, retryEntry, submitChanges, summarize } from "./core";
import { withStateDirectory } from "./state";

const HELP = `Curvi IndexNow (manual; no schedule is installed)
  pnpm ops:indexnow initialize --state-dir /absolute/private/directory
  pnpm ops:indexnow plan --state-dir /absolute/private/directory
  pnpm ops:indexnow submit --state-dir /absolute/private/directory --execute [--max-urls 100]
  pnpm ops:indexnow status --state-dir /absolute/private/directory
  pnpm ops:indexnow retry --state-dir /absolute/private/directory --url https://curvi.ai/path [--acknowledge-duplicate-risk]
  pnpm ops:indexnow record-indexing --state-dir /absolute/private/directory --url https://curvi.ai/path --result indexed|not_indexed --observed-at ISO_TIMESTAMP --confirm-bing-observation

Initialize records the current public pages without submitting historical URLs.
Plan performs a read-only scan. Submit scans again and sends only eligible changes.
The approved INDEXNOW_KEY comes from secure environment configuration, never a command argument.
See docs/ops/INDEXNOW.md for ownership setup, recovery and interpreting outcomes.`;

export async function runIndexNow(argv: string[], out: (line: string) => void): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv, strict: true, allowPositionals: true,
    options: {
      "state-dir": { type: "string" }, "max-urls": { type: "string" }, url: { type: "string" },
      execute: { type: "boolean" }, help: { type: "boolean" },
      "acknowledge-duplicate-risk": { type: "boolean" },
      result: { type: "string" }, "observed-at": { type: "string" }, "confirm-bing-observation": { type: "boolean" },
    },
  });
  if (values.help && positionals.length === 0) { out(HELP); return 0; }
  const command = positionals[0];
  if (positionals.length !== 1 || !["initialize", "plan", "submit", "status", "retry", "record-indexing"].some((name) => name === command)) {
    throw new Error("Choose exactly one documented command; use --help for syntax.");
  }
  const allowed = new Set(["state-dir",
    ...(command === "submit" ? ["execute", "max-urls"] : []),
    ...(command === "retry" ? ["url", "acknowledge-duplicate-risk"] : []),
    ...(command === "record-indexing" ? ["url", "result", "observed-at", "confirm-bing-observation"] : []),
  ]);
  if (Object.keys(values).some((key) => !allowed.has(key))) throw new Error("A supplied option does not apply to this command.");
  if (!values["state-dir"] || !isAbsolute(values["state-dir"])) throw new Error("Provide an absolute private --state-dir outside the repository.");
  const directory = resolve(values["state-dir"]);
  let parent: string;
  try { parent = await realpath(dirname(directory)); } catch { throw new Error("The state directory's parent must already exist."); }
  const repository = await realpath(fileURLToPath(new URL("../../../../", import.meta.url)));
  const within = relative(repository, resolve(parent, basename(directory)));
  if (!within || (!(within === ".." || within.startsWith(`..${sep}`)) && !isAbsolute(within))) throw new Error("Keep IndexNow state outside the repository.");
  if (command === "submit" && !values.execute) throw new Error("Submitting requires --execute; use plan to review changes first.");
  const maxUrls = values["max-urls"] === undefined ? undefined : Number(values["max-urls"]);
  if (maxUrls !== undefined && (!Number.isInteger(maxUrls) || maxUrls < 1 || maxUrls > 500)) throw new Error("--max-urls must be between 1 and 500.");
  if ((command === "retry" || command === "record-indexing") && (!values.url || !isPublicCandidateUrl(values.url))) {
    throw new Error("Provide one exact public canonical Curvi URL without credentials, query or fragment.");
  }
  if (command === "record-indexing" && (!values["confirm-bing-observation"] || !["indexed", "not_indexed"].some((result) => result === values.result)
    || !values["observed-at"] || !Number.isFinite(Date.parse(values["observed-at"])))) {
    throw new Error("Recording indexing requires an explicit Bing observation, result and ISO timestamp.");
  }
  // Read only the intended key, never env files or unrelated credentials.
  const key = command === "submit" ? configuredKey() : undefined;
  return withStateDirectory(directory, async (store) => {
    const previous = await store.read();
    if (previous && (previous.entries.some((entry) => !isPublicCandidateUrl(entry.url)) || previous.history.some((event) => event.urls.some((url) => !isPublicCandidateUrl(url))))) {
      throw new Error("State contains an ineligible URL; preserve the file and review it.");
    }
    if (command === "initialize") {
      if (previous) throw new Error("A baseline already exists. Do not reset it to bypass deduplication or quotas.");
      const inventory = await collectInventory({ previousUrls: [] });
      const state = initializeState(inventory, new Date());
      await store.save(state);
      out(JSON.stringify({ ...summarize(state), submitted: 0, action: "baseline_initialized" }, null, 2));
      return 0;
    }
    if (!previous) throw new Error("Initialize a baseline before planning or submitting changes.");
    if (command === "status") {
      out(JSON.stringify({ ...summarize(previous), entries: previous.entries }, null, 2));
      return 0;
    }
    if (command === "retry") {
      const state = retryEntry(previous, values.url!, values["acknowledge-duplicate-risk"] === true);
      await store.save(state);
      out(JSON.stringify({ ...summarize(state), submitted: 0, action: "retry_queued" }, null, 2));
      return 0;
    }
    if (command === "record-indexing") {
      const state = recordIndexing(previous, values.url!, values.result as "indexed" | "not_indexed", new Date(values["observed-at"]!), new Date());
      await store.save(state);
      out(JSON.stringify({ ...summarize(state), submitted: 0, action: "operator_observation_recorded" }, null, 2));
      return 0;
    }
    const inventory = await collectInventory({ previousUrls: previous.entries.map((entry) => entry.url) });
    const state = refreshState(previous, inventory, new Date());
    if (command === "plan") {
      out(JSON.stringify({ ...summarize(state), action: "preview_only", submitted: 0,
        changes: state.entries.filter((entry) => ["queued", "retryable", "failed", "unknown"].some((outcome) => outcome === entry.outcome)),
        excludedCount: inventory.excluded.length,
      }, null, 2));
      return 0;
    }
    await store.save(state);
    const result = await submitChanges({ state, key: key!, save: (next) => store.save(next), ...(maxUrls === undefined ? {} : { maxUrls }) });
    out(JSON.stringify({ ...summarize(result), action: "submission_run_complete", recentOutcomes: result.history.slice(-10) }, null, 2));
    // Deferred, refused or ambiguous changes remain visible and produce a
    // nonzero result; a partial run never claims that all changes arrived.
    return result.entries.some((entry) => ["queued", "retryable", "failed", "unknown", "attempting"].some((status) => status === entry.outcome)) ? 2 : 0;
  });
}
