/**
 * pnpm plugin:zip (docs/phases/PHASE_19.md, P19-25, runbook C3): checks the
 * plugin folder (./manifest), then writes dist/curvi-<version>/ (the folder
 * a local marketplace installs, runbook C3b) and dist/curvi-<version>.zip
 * (the file the founder uploads at platform.openai.com/plugins, runbook E1),
 * and checks the archive it wrote. It uploads nothing.
 *
 * Options:
 *   --developer-name "Name"  fills author.name and interface.developerName
 *                            with the verified developer name, in place of
 *                            the placeholder in package/plugin.json.
 *   --out <dir>              writes somewhere other than dist/.
 *   --submission             enforces local final-package checks, including
 *                            a recording URL and complete descriptor snapshot.
 *   --tools-file <json>       sanitized tools/list JSON outside the package.
 */

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ARCHIVE_LIMITS } from "./limits";
import { checkPlugin, type CheckOptions } from "./manifest";
import { readZipListing, writeZip, type ZipEntry } from "./zip";
import { EXTERNAL_SUBMISSION_CHECKS } from "./submission";

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));

export interface BuildOptions extends CheckOptions {
  /** Output folder (dist/ by default). */
  out?: string;
}

export type BuildResult =
  | { ok: true; zipPath: string; folder: string; entries: string[]; zipBytes: number; warnings: string[]; mode: "draft" | "submission"; externalChecks: readonly string[] }
  | { ok: false; errors: string[]; warnings: string[] };

export async function buildPlugin(options: BuildOptions = {}): Promise<BuildResult> {
  const checked = checkPlugin(options);
  if (checked.errors.length > 0 || !checked.manifest) {
    return { ok: false, errors: checked.errors, warnings: checked.warnings };
  }
  const version = String(checked.manifest.version);
  const name = String(checked.manifest.name);
  const out = resolve(options.out ?? join(PACKAGE_ROOT, "dist"));
  const folder = join(out, `${name}-${version}`);
  const zipPath = join(out, `${name}-${version}.zip`);
  rmSync(folder, { recursive: true, force: true });
  rmSync(zipPath, { force: true });

  // plugin.json as checked (with the developer name filled in); every other
  // file as it is in the folder.
  const entries: ZipEntry[] = checked.files.map((file) => ({
    path: file.path,
    data: file.path === "plugin.json" ? Buffer.from(`${JSON.stringify(checked.manifest, null, 2)}\n`) : readFileSync(file.absolute),
  }));
  for (const entry of entries) {
    const target = join(folder, entry.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, entry.data);
  }
  await writeZip(entries, zipPath);

  // Check the archive that was written.
  const errors: string[] = [];
  const zipBytes = statSync(zipPath).size;
  if (zipBytes > ARCHIVE_LIMITS.maxCompressedBytes) {
    errors.push(`ZIP: is ${zipBytes} bytes, over 100 MB`);
  }
  const listing = readZipListing(readFileSync(zipPath));
  const expected = entries.map((entry) => entry.path).sort();
  if (JSON.stringify([...listing.names].sort()) !== JSON.stringify(expected)) {
    errors.push(`ZIP: holds ${listing.names.join(", ")}, expected ${expected.join(", ")}`);
  }
  for (const entry of entries) {
    if (listing.sizes.get(entry.path) !== entry.data.length) {
      errors.push(`ZIP: ${entry.path} has the wrong size inside the archive`);
    }
  }
  if (!listing.names.includes("plugin.json") || !listing.names.includes("mcp.json")) {
    errors.push("ZIP: plugin.json and mcp.json must sit at the archive root");
  }
  if (listing.names.some((entry) => entry.startsWith("/") || entry.split("/").includes(".."))) {
    errors.push("ZIP: every path must stay inside the archive");
  }
  if (errors.length > 0) {
    return { ok: false, errors, warnings: checked.warnings };
  }
  return { ok: true, zipPath, folder, entries: listing.names, zipBytes, warnings: checked.warnings, mode: options.mode ?? "draft", externalChecks: EXTERNAL_SUBMISSION_CHECKS };
}

/** Reject typos instead of silently building a draft when submission was intended. */
export function parseBuildArgs(args: readonly string[]): { options: BuildOptions; errors: string[] } {
  const options: BuildOptions = {};
  const errors: string[] = [];
  const seen = new Set<string>();
  const fields = { "--developer-name": "developerName", "--out": "out", "--tools-file": "toolsFile" } as const;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    // pnpm may preserve the conventional argument delimiter.
    if (arg === "--" && index === 0) continue;
    if (arg === "--submission") {
      if (seen.has(arg)) errors.push("CLI: --submission was supplied more than once");
      seen.add(arg);
      options.mode = "submission";
      continue;
    }
    const equals = arg.indexOf("=");
    const flag = equals === -1 ? arg : arg.slice(0, equals);
    if (!Object.hasOwn(fields, flag)) {
      errors.push("CLI: unsupported argument; use --submission, --tools-file, --developer-name or --out");
      continue;
    }
    if (seen.has(flag)) errors.push(`CLI: ${flag} was supplied more than once`);
    seen.add(flag);
    const value = equals === -1 ? args[index + 1] : arg.slice(equals + 1);
    if (!value?.trim() || value.startsWith("--")) {
      errors.push(`CLI: ${flag} needs a value`);
      continue;
    }
    if (equals === -1) index += 1;
    options[fields[flag as keyof typeof fields]] = value;
  }
  return { options, errors };
}

async function main(): Promise<void> {
  const parsed = parseBuildArgs(process.argv.slice(2));
  if (parsed.errors.length) {
    for (const error of parsed.errors) console.error(error);
    process.exitCode = 1;
    return;
  }
  const result = await buildPlugin(parsed.options);
  for (const warning of result.warnings) {
    console.warn(`warning  ${warning}`);
  }
  if (!result.ok) {
    for (const error of result.errors) {
      console.error(`error    ${error}`);
    }
    console.error(`The plugin ZIP was not built: ${result.errors.length} problem${result.errors.length === 1 ? "" : "s"}.`);
    process.exitCode = 1;
    return;
  }
  console.log(`Built ${result.zipPath} (${result.zipBytes} bytes, ${result.entries.length} files: ${result.entries.join(", ")}).`);
  console.log(`The plugin folder for a local marketplace install is ${result.folder}.`);
  console.log(`Local ${result.mode} package checks passed. This does not verify identity, live behavior, submission, approval or publication.`);
  for (const check of result.externalChecks) console.log(`External check: ${check}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main();
}
