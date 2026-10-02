import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { ScriptRefusal } from "./cli";

const exec = promisify(execFile);
export function repositoryRoot(): string {
  let path = resolve(process.cwd());
  while (!existsSync(join(path, "pnpm-workspace.yaml"))) {
    const parent = dirname(path);
    if (path === parent) throw new ScriptRefusal("Run inside the Curvi checkout.");
    path = parent;
  }
  return path;
}
export function targetEnvironment(value: unknown): "prod" | "staging" {
  if (value !== "prod" && value !== "staging") throw new ScriptRefusal("Pass --env prod or --env staging explicitly.");
  return value;
}
export function targetValue(target: "prod" | "staging", key: string, required = true): string {
  const name = target === "staging" ? `STAGING_${key}` : key;
  const value = process.env[name]?.trim();
  if (!value && required) throw new ScriptRefusal(`Set ${name} in the shell. No env files are loaded.`);
  return value ?? "";
}
export function siteOrigin(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new ScriptRefusal("OPS_SITE_URL must be an HTTPS origin."); }
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new ScriptRefusal("OPS_SITE_URL must be an HTTPS origin without credentials, path or query.");
  return url.origin;
}
export async function command(program: string, args: string[], cwd: string, env = process.env): Promise<string> {
  try {
    return (await exec(program, args, { cwd, env, maxBuffer: 8 * 1024 * 1024, timeout: 30 * 60_000 })).stdout.trim();
  } catch {
    // Child output can contain connection strings. Never echo it or arguments.
    throw new ScriptRefusal(`${program} failed. Review that command locally with credentials kept private.`);
  }
}
export function latestMigration(root: string): { tag: string; when: number } {
  const journal = JSON.parse(readFileSync(join(root, "packages/db/migrations/meta/_journal.json"), "utf8")) as { entries: { tag: string; when: number }[] };
  const latest = journal.entries.at(-1);
  if (!latest || !/^\d{4}_/.test(latest.tag) || !Number.isSafeInteger(latest.when)) throw new ScriptRefusal("Migration journal is invalid.");
  return latest;
}
export async function jsonRequest<T>(url: string, token: string, method = "GET", body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, { method, redirect: "error", cache: "no-store", signal: AbortSignal.timeout(30_000), headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  } catch { throw new ScriptRefusal("An operator API request failed or timed out."); }
  if (!response.ok) throw new ScriptRefusal(`An operator API request returned HTTP ${response.status}.`);
  return response.json() as Promise<T>;
}
/** Public pages only. Redirects to another origin never receive credentials. */
export async function lightSmoke(origin: string): Promise<void> {
  for (const path of ["/", "/pricing", "/help", "/api/health"]) {
    let response: Response;
    try { response = await fetch(`${origin}${path}`, { redirect: "error", signal: AbortSignal.timeout(30_000), cache: "no-store" }); }
    catch { throw new ScriptRefusal(`Public smoke could not read ${path}.`); }
    if (!response.ok) throw new ScriptRefusal(`Public smoke failed for ${path} (HTTP ${response.status}).`);
    if (path === "/api/health") {
      const body = await response.json() as { status?: string; mode?: string };
      if (!["ok", "degraded"].includes(body.status ?? "") || body.mode !== "db") throw new ScriptRefusal("Public health is not ready.");
    } else if (!(response.headers.get("content-type") ?? "").includes("text/html") || (await response.text()).length < 100) throw new ScriptRefusal(`Public smoke found no page at ${path}.`);
  }
}
