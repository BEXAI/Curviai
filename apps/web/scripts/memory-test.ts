/** Offline stress measurement: real planner, runner, encoders, QC and packager;
 * fixtures replace provider responses and no credentials or network are used. */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { InMemoryBreakerStore, InMemoryCostMeter, ProviderRegistry, InMemoryCapStore, SpendCaps } from "@curvi/ai";
import { DemoLlmProvider, DemoShotGenerator, demoRoutingTable } from "@curvi/trigger/runtime";
import { InMemoryJobStore, runGeneratePack, systemClock, type GeneratePackInput } from "@curvi/trigger/runner";
import { normalizeOutputOptions, resolveOutputOptions } from "@curvi/pipeline/output-options";
import { limitImageMemory } from "@curvi/pipeline";
import { spendCapPolicy } from "@curvi/pipeline/seed";
import { InlinePackRunner } from "../src/lib/jobs/inline-runner";

function option(name: string, fallback: number): number {
  const index = process.argv.indexOf(name);
  const number = index < 0 ? fallback : Number(process.argv[index + 1]);
  if (!Number.isInteger(number) || number <= 0) throw Error(`${name} needs a positive integer.`);
  return number;
}
async function main(): Promise<void> {
  limitImageMemory();
  const concurrency = option("--concurrency", 2);
  const budgetMb = option("--budget-mb", 512);
  if (concurrency > 8) throw Error("Use at most 8 concurrent packs for this local test.");
  const directory = await mkdtemp(path.join(tmpdir(), "curvi-memory-"));
  const peak = { rss: 0, heapUsed: 0, external: 0, samples: 0 };
  const sample = () => { const memory = process.memoryUsage(); peak.samples++; for (const key of ["rss", "heapUsed", "external"] as const) peak[key] = Math.max(peak[key], memory[key]); };
  sample(); const timer = setInterval(sample, 200);
  let finished = 0;
  const failures: string[] = [];
  const started = Date.now();
  const runner = new InlinePackRunner<GeneratePackInput>(
    { concurrency, shutdownGraceMs: 0, heartbeatMs: 60_000 },
    { runPack: async (input) => {
      const registry = new ProviderRegistry(); registry.register(new DemoLlmProvider());
      const result = await runGeneratePack(input, {
        ai: { registry, routing: demoRoutingTable(), meter: new InMemoryCostMeter(), breakerStore: new InMemoryBreakerStore(), caps: new SpendCaps(new InMemoryCapStore(), () => new Date(), spendCapPolicy) },
        store: new InMemoryJobStore(), clock: systemClock,
        // Each fake response owns its full spec-sized buffers, as real
        // provider responses do. No demo memoization across shots.
        generator: { generate: (args) => new DemoShotGenerator().generate(args) },
        packOutDir: path.join(directory, input.jobId), shotConcurrency: 2,
      });
      if (result.state !== "done") failures.push(`${input.jobId}: ${result.state}`);
      finished++;
    }, settle: async (input, reason) => { failures.push(`${input.jobId}: ${reason}`); } },
  );
  try {
    const outputOptions = resolveOutputOptions(normalizeOutputOptions({ bundle: "everything", variations: 4, extras: { ads: true } }), { colorHex: "#FFFFFF", brandSweepHex: "#FFFFFF", keepMediaIds: [] });
    await Promise.all(Array.from({ length: concurrency }, (_, index) => runner.submit({ jobId: `memory-${index}`, workspaceId: `offline-${index}`, tier: "pro", channels: ["amazon", "shopify", "social", "ads"], images: [{ mediaId: "source" }], creditBudget: 200, output: outputOptions })));
  } finally { clearInterval(timer); sample(); await rm(directory, { recursive: true, force: true }); }
  const mb = (bytes: number) => Math.round(bytes / 1024 / 1024 * 100) / 100;
  const budgetExceeded = peak.rss > budgetMb * 1024 * 1024;
  console.info(JSON.stringify({ concurrency, finished, budgetMb, budgetExceeded, durationSeconds: Math.round((Date.now() - started) / 1000), peakMb: { rss: mb(peak.rss), heap: mb(peak.heapUsed), external: mb(peak.external) }, samples: peak.samples, failures }, null, 2));
  if (budgetExceeded || failures.length > 0 || finished !== concurrency) process.exitCode = 1;
}
main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
