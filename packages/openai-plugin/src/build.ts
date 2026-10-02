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
 */

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ARCHIVE_LIMITS } from "./limits";
import { checkPlugin, type CheckOptions } from "./manifest";
import { readZipListing, writeZip, type ZipEntry } from "./zip";

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));

export interface BuildOptions extends CheckOptions {
  /** Output folder (dist/ by default). */
  out?: string;
}

export type BuildResult =
  | { ok: true; zipPath: string; folder: string; entries: string[]; zipBytes: number; warnings: string[] }
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
  return { ok: true, zipPath, folder, entries: listing.names, zipBytes, warnings: checked.warnings };
}

function argValue(args: readonly string[], flag: string): string | undefined {
  const inline = args.find((arg) => arg.startsWith(`${flag}=`));
  if (inline) {
    return inline.slice(flag.length + 1);
  }
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const developerName = argValue(args, "--developer-name");
  const out = argValue(args, "--out");
  const result = await buildPlugin({
    ...(developerName !== undefined ? { developerName } : {}),
    ...(out !== undefined ? { out } : {}),
  });
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
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main();
}
