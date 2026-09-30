/**
 * The curvi command (PHASE_16 workstream 5):
 *
 *   curvi auth login | status | logout
 *   curvi pack create <photos> --channels <ids> [--bundle] [--look] [--wait]
 *   curvi pack get <id> [--wait] [--out <dir>]
 *   curvi check <photo>
 *   curvi channels
 *
 * run() takes every side effect as a dependency, so the tests drive it with
 * a mocked fetch, a temporary config folder and captured output. Bundle,
 * look and channel values go to the API as typed; the server checks them
 * against the seed and the spec registry (CLAUDE.md rule 2).
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { boolFlag, listFlag, parseArgs, stringFlag, UsageError, type FlagSpec, type ParsedArgs } from "./args.ts";
import {
  CurviApiError,
  CurviClient,
  CurviNetworkError,
  DEFAULT_BASE_URL,
  MAX_PACK_PHOTOS,
  type FetchLike,
  type PhotoSource,
} from "./client.ts";
import {
  assertKeyTarget,
  checkApiUrl,
  deleteConfig,
  maskKey,
  readConfig,
  resolveAuth,
  writeConfig,
  type ConfigEnv,
} from "./config.ts";
import {
  isTerminalStatus,
  type ChannelsResponse,
  type CreatePackRequest,
  type MainImageCheck,
  type Pack,
  type PackFiles,
} from "./types.ts";

export const CLI_VERSION = "0.1.0";

export const EXIT = {
  ok: 0,
  /** The API refused, the pack failed or the network was down. */
  error: 1,
  /** The command line was wrong. */
  usage: 2,
  /** curvi check ran and the image does not pass. */
  checkFailed: 3,
} as const;

/** How often --wait asks for the pack, in ms. */
export const POLL_INTERVAL_MS = 3000;
/** How long --wait waits by default, in seconds. */
export const DEFAULT_WAIT_SECONDS = 900;

const API_KEYS_PAGE = "/app/settings/api";

export interface CliDeps extends ConfigEnv {
  fetch: FetchLike;
  cwd: string;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /** Reads the API key typed or piped in for curvi auth login. */
  readSecret: (prompt: string) => Promise<string>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

export const HELP = `curvi ${CLI_VERSION}: channel ready product image packs from one photo.

Usage:
  curvi auth login [--key <key>] [--api-url <url>]
  curvi auth status
  curvi auth logout
  curvi pack create <photos or URLs> --channels <ids> [--bundle <key>] [--look <key>]
                    [--title <text>] [--note <text>] [--product <id>]
                    [--options <json>] [--idempotency-key <key>]
                    [--wait] [--timeout <seconds>] [--out <folder>] [--json]
  curvi pack get <pack id> [--wait] [--timeout <seconds>] [--out <folder>] [--json]
  curvi check <photo or URL> [--json]
  curvi channels [--json]

A pack takes up to ${MAX_PACK_PHOTOS} photos of one product; the first is the front.
Channels are spec ids separated by commas, for example amazon.main,shopify.product.
A channel name such as amazon picks every live spec of that channel; curvi channels lists them.
The bundle picks how much the pack makes, for example listing; the default is everything.
The look picks a starting style, for example marketplace.

Make an API key at https://curvi.ai${API_KEYS_PAGE} (Growth plan and up).
CURVI_API_KEY and CURVI_API_URL override the saved settings.
`;

const COMMON: Record<string, FlagSpec> = {
  json: { boolean: true },
  "api-url": {},
  help: { boolean: true },
};

const LOGIN_FLAGS: Record<string, FlagSpec> = { ...COMMON, key: {} };
const CREATE_FLAGS: Record<string, FlagSpec> = {
  ...COMMON,
  channels: { multiple: true },
  bundle: {},
  look: {},
  title: {},
  product: {},
  note: {},
  options: {},
  "idempotency-key": {},
  wait: { boolean: true },
  timeout: {},
  out: {},
};
const GET_FLAGS: Record<string, FlagSpec> = { ...COMMON, wait: { boolean: true }, timeout: {}, out: {} };

function isWebUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

/** A photo path or link. A file is read here and sent base64 encoded; the
 * server checks its type and size, as it does a browser upload. */
async function photoSource(deps: CliDeps, input: string | undefined): Promise<PhotoSource> {
  if (!input) {
    throw new UsageError("Give the path or URL of a product photo.");
  }
  if (isWebUrl(input)) {
    return { url: input };
  }
  const path = resolve(deps.cwd, input);
  let bytes: Uint8Array;
  try {
    bytes = await readFile(path);
  } catch {
    throw new UsageError(`Could not read the photo at ${input}.`);
  }
  return { file: { name: basename(path), bytes } };
}

async function clientFor(deps: CliDeps, args: ParsedArgs): Promise<CurviClient> {
  const stored = await readConfig(deps);
  const auth = resolveAuth(deps.env, stored, stringFlag(args, "api-url"));
  if (!auth.apiKey) {
    throw new UsageError("Not signed in. Run curvi auth login, or set CURVI_API_KEY.");
  }
  assertKeyTarget(auth, stored);
  return new CurviClient({
    apiKey: auth.apiKey,
    baseUrl: auth.apiUrl,
    fetch: deps.fetch,
    userAgent: `curvi-cli/${CLI_VERSION}`,
    sleep: deps.sleep,
  });
}

function printJson(deps: CliDeps, value: unknown): void {
  deps.stdout(`${JSON.stringify(value, null, 2)}\n`);
}

function countBy<T>(items: readonly T[], key: (item: T) => string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(key(item), (counts.get(key(item)) ?? 0) + 1);
  return counts;
}

export function formatPack(pack: Pack): string {
  const lines = [`Pack ${pack.id} is ${pack.status.replace(/_/g, " ")}.`];
  if (pack.productTitle) lines.push(`Product: ${pack.productTitle}`);
  if (pack.channels.length > 0) lines.push(`Channels: ${pack.channels.join(", ")}`);
  lines.push(`Credits: ${pack.creditsCharged} charged, ${pack.creditsReserved} held`);
  const shots = pack.shots;
  if (shots.length > 0) {
    const counts = [...countBy(shots, (shot) => String(shot.status))]
      .map(([status, count]) => `${count} ${status.replace(/_/g, " ")}`)
      .join(", ");
    lines.push(`Shots: ${counts}`);
    for (const shot of shots) {
      if (shot.note && (shot.status === "needs_review" || shot.status === "skipped")) {
        lines.push(`  ${shot.type}: ${shot.note}`);
      }
    }
  }
  if (pack.error) lines.push(pack.error);
  return `${lines.join("\n")}\n`;
}

export function formatFiles(files: PackFiles): string {
  const lines: string[] = [];
  const withUrls = files.files.filter((file) => file.url);
  if (withUrls.length > 0) {
    lines.push("Files (the links expire, so download them soon):");
    for (const file of withUrls) {
      const where = file.specId ?? file.channel ?? "pack";
      lines.push(`  ${where} ${file.name}`, `    ${file.url}`);
    }
  } else {
    lines.push("No file links yet.");
  }
  if (files.notice) lines.push(files.notice);
  return `${lines.join("\n")}\n`;
}

export function formatCheck(check: MainImageCheck): string {
  const lines = [check.summary, `Size: ${check.width} x ${check.height}`];
  for (const row of check.checks) {
    lines.push(`  ${row.pass ? "Pass" : "Fail"}  ${row.label}: ${row.measured}`);
  }
  return `${lines.join("\n")}\n`;
}

export function formatChannels(result: ChannelsResponse): string {
  const lines = ["Channels (spec id, size, availability on your plan):"];
  for (const channel of result.channels) {
    const size = channel.width && channel.height ? `${channel.width} x ${channel.height}` : "any size";
    const availability =
      channel.availability === "upgrade_required"
        ? `needs the ${channel.upgradeTo ?? "next"} plan`
        : channel.availability.replace(/_/g, " ");
    lines.push(`  ${channel.id}  ${channel.name}, ${size}, ${availability}`);
  }
  lines.push("Bundles:");
  for (const bundle of result.bundles) lines.push(`  ${bundle.key}  ${bundle.label}`);
  return `${lines.join("\n")}\n`;
}

/**
 * The folder path for one delivered file under --out. The name comes from
 * the server; every segment is cleaned and "." or ".." dropped, so a file can
 * never be written outside the folder.
 */
export function safeRelativePath(channel: string | null, name: string): string {
  const clean = (segment: string) => segment.replace(/[^A-Za-z0-9._-]/g, "_");
  const segments = [...(channel ? [channel] : []), ...name.split(/[\\/]+/)]
    .map(clean)
    .filter((segment) => segment.length > 0 && segment !== "." && segment !== "..");
  return segments.length > 0 ? join(...segments) : "file";
}

async function downloadFiles(deps: CliDeps, files: PackFiles, outDir: string): Promise<string[]> {
  const root = resolve(deps.cwd, outDir);
  const written: string[] = [];
  const used = new Set<string>();
  for (const file of files.files) {
    if (!file.url || !isWebUrl(file.url)) continue;
    let relative = safeRelativePath(file.channel, file.name);
    // Two files with one name keep both: the second gets a number.
    for (let n = 2; used.has(relative); n += 1) {
      const ext = extname(relative);
      relative = `${relative.slice(0, relative.length - ext.length)}_${n}${ext}`;
    }
    used.add(relative);
    // Signed URLs carry their own authority; the API key is never sent to them.
    const response = await deps.fetch(file.url, { method: "GET" });
    if (!response.ok) {
      throw new CurviApiError(response.status, `Could not download ${file.name}; its link may have expired.`);
    }
    const target = join(root, relative);
    await mkdir(resolve(target, ".."), { recursive: true });
    await writeFile(target, new Uint8Array(await response.arrayBuffer()));
    written.push(target);
  }
  return written;
}

function waitSeconds(args: ParsedArgs): number {
  const raw = stringFlag(args, "timeout");
  if (raw === undefined) return DEFAULT_WAIT_SECONDS;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new UsageError("The option --timeout takes a number of seconds above zero.");
  }
  return seconds;
}

async function waitForPack(deps: CliDeps, client: CurviClient, first: Pack, seconds: number): Promise<Pack> {
  const deadline = deps.now() + seconds * 1000;
  let pack = first;
  while (!pack.finished && !isTerminalStatus(pack.status)) {
    if (deps.now() >= deadline) {
      deps.stderr(`Still ${pack.status} after ${seconds} seconds. Run curvi pack get ${pack.id} --wait to keep waiting.\n`);
      return pack;
    }
    await deps.sleep(POLL_INTERVAL_MS);
    pack = (await client.getPack(pack.id)).pack;
  }
  return pack;
}

/** Prints the pack, and its files once it is done, then downloads them with --out. */
async function finishPack(
  deps: CliDeps,
  client: CurviClient,
  pack: Pack,
  args: ParsedArgs,
  replayed = false,
): Promise<number> {
  const out = stringFlag(args, "out");
  const files = pack.status === "done" ? await client.listPackFiles(pack.id) : null;
  const written = files && out ? await downloadFiles(deps, files, out) : [];

  if (boolFlag(args, "json")) {
    printJson(deps, {
      pack,
      ...(replayed ? { replayed } : {}),
      ...(files ? { files } : {}),
      ...(out ? { downloaded: written } : {}),
    });
  } else {
    if (replayed) deps.stdout("This Idempotency-Key already started a pack, so here it is again.\n");
    deps.stdout(formatPack(pack));
    if (files) deps.stdout(formatFiles(files));
    if (out) deps.stdout(`Saved ${written.length} files to ${resolve(deps.cwd, out)}\n`);
  }
  if (out && !files) {
    deps.stderr("The pack is not done yet, so nothing was downloaded.\n");
  }
  return pack.status === "failed" || pack.status === "canceled" ? EXIT.error : EXIT.ok;
}

function parseOptions(args: ParsedArgs): Record<string, unknown> | undefined {
  const raw = stringFlag(args, "options");
  if (raw === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new UsageError("The option --options takes a JSON object.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new UsageError("The option --options takes a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

async function packCreate(deps: CliDeps, argv: string[]): Promise<number> {
  const args = parseArgs(argv, CREATE_FLAGS);
  if (args.positionals.length > MAX_PACK_PHOTOS) {
    throw new UsageError(`Give at most ${MAX_PACK_PHOTOS} photos of one product.`);
  }
  const channels = listFlag(args, "channels");
  if (channels.length === 0) {
    throw new UsageError("Pick at least one channel with --channels, for example --channels amazon.main.");
  }
  const seconds = waitSeconds(args);
  const request: Omit<CreatePackRequest, "photos"> = { channels };
  const bundle = stringFlag(args, "bundle");
  const look = stringFlag(args, "look");
  const title = stringFlag(args, "title");
  const note = stringFlag(args, "note");
  const productId = stringFlag(args, "product");
  const outputOptions = parseOptions(args);
  if (bundle) request.bundle = bundle;
  if (look) request.look = look;
  if (title) request.title = title;
  if (note) request.note = note;
  if (productId) request.productId = productId;
  if (outputOptions) request.outputOptions = outputOptions;

  if (args.positionals.length === 0 && !productId) {
    throw new UsageError("Give the path or URL of a product photo, or --product with the id of a product that has photos.");
  }
  const photos: PhotoSource[] = [];
  for (const input of args.positionals) photos.push(await photoSource(deps, input));
  const client = await clientFor(deps, args);
  const idempotencyKey = stringFlag(args, "idempotency-key");
  const created = await client.createPack(photos, request, idempotencyKey ? { idempotencyKey } : {});
  let pack = created.pack;
  if (boolFlag(args, "wait") || stringFlag(args, "out")) {
    if (!boolFlag(args, "json")) deps.stderr(`Pack ${pack.id} started. Waiting for it to finish.\n`);
    pack = await waitForPack(deps, client, pack, seconds);
  }
  return finishPack(deps, client, pack, args, created.replayed === true);
}

async function packGet(deps: CliDeps, argv: string[]): Promise<number> {
  const args = parseArgs(argv, GET_FLAGS);
  const id = args.positionals[0];
  if (!id || args.positionals.length > 1) {
    throw new UsageError("Give one pack id, for example curvi pack get 3f2a.");
  }
  const seconds = waitSeconds(args);
  const client = await clientFor(deps, args);
  let pack = (await client.getPack(id)).pack;
  if (boolFlag(args, "wait") || stringFlag(args, "out")) {
    pack = await waitForPack(deps, client, pack, seconds);
  }
  return finishPack(deps, client, pack, args);
}

async function check(deps: CliDeps, argv: string[]): Promise<number> {
  const args = parseArgs(argv, COMMON);
  if (args.positionals.length !== 1) {
    throw new UsageError("Give the path or URL of one main image.");
  }
  const photo = await photoSource(deps, args.positionals[0]);
  const client = await clientFor(deps, args);
  const result = await client.checkMainImage(photo);
  if (boolFlag(args, "json")) {
    printJson(deps, result);
  } else {
    deps.stdout(formatCheck(result));
  }
  return result.pass ? EXIT.ok : EXIT.checkFailed;
}

async function channels(deps: CliDeps, argv: string[]): Promise<number> {
  const args = parseArgs(argv, COMMON);
  if (args.positionals.length > 0) {
    throw new UsageError("curvi channels takes no arguments.");
  }
  const client = await clientFor(deps, args);
  const result = await client.listChannels();
  if (boolFlag(args, "json")) {
    printJson(deps, result);
  } else {
    deps.stdout(formatChannels(result));
  }
  return EXIT.ok;
}

async function authLogin(deps: CliDeps, argv: string[]): Promise<number> {
  const args = parseArgs(argv, LOGIN_FLAGS);
  const urlFlag = stringFlag(args, "api-url");
  // Check the URL before asking for the key, so a refused URL never sees it.
  if (urlFlag) checkApiUrl(urlFlag);
  const given = stringFlag(args, "key") ?? (await deps.readSecret("Paste your Curvi API key: "));
  const apiKey = given.trim();
  if (!apiKey) {
    throw new UsageError(`No key given. Make one at https://curvi.ai${API_KEYS_PAGE}.`);
  }
  if (/\s/.test(apiKey)) {
    throw new UsageError("That does not look like an API key: it has spaces in it.");
  }
  const stored = await readConfig(deps);
  const apiUrl = urlFlag ?? stored.apiUrl;
  const origin = checkApiUrl(apiUrl ?? DEFAULT_BASE_URL).origin;
  const path = await writeConfig(deps, { apiKey, ...(apiUrl ? { apiUrl } : {}) });
  deps.stdout(`Saved key ${maskKey(apiKey)} to ${path}\nThe key is sent only to ${origin}.\n`);
  if (deps.env.CURVI_API_KEY) {
    deps.stderr("CURVI_API_KEY is set, and it wins over the saved key while it stays set.\n");
  }
  return EXIT.ok;
}

async function authStatus(deps: CliDeps, argv: string[]): Promise<number> {
  const args = parseArgs(argv, COMMON);
  const auth = resolveAuth(deps.env, await readConfig(deps), stringFlag(args, "api-url"));
  if (boolFlag(args, "json")) {
    printJson(deps, {
      signedIn: auth.apiKey !== null,
      key: auth.apiKey ? maskKey(auth.apiKey) : null,
      source: auth.keySource,
      apiUrl: auth.apiUrl,
    });
    return auth.apiKey ? EXIT.ok : EXIT.error;
  }
  if (!auth.apiKey) {
    deps.stdout("Not signed in. Run curvi auth login, or set CURVI_API_KEY.\n");
    return EXIT.error;
  }
  const from = auth.keySource === "env" ? "CURVI_API_KEY" : "the saved settings";
  deps.stdout(`Signed in with key ${maskKey(auth.apiKey)} from ${from}.\nAPI: ${auth.apiUrl}\n`);
  return EXIT.ok;
}

async function authLogout(deps: CliDeps): Promise<number> {
  await deleteConfig(deps);
  deps.stdout("Removed the saved key. Revoke it in Curvi too if it may have leaked.\n");
  return EXIT.ok;
}

function describeError(error: unknown): string {
  if (error instanceof CurviApiError) {
    const hint =
      error.status === 401
        ? " Check the key with curvi auth status, or make a new one."
        : error.reason === "upgrade_required" && error.status === 403
          ? " API keys work on the Growth plan and up."
          : error.status === 409 && error.existingPackId
            ? ` The pack it started is ${error.existingPackId}; run curvi pack get ${error.existingPackId}.`
            : error.status === 429 && error.retryAfter !== null
              ? ` Try again in ${error.retryAfter} seconds.`
              : "";
    const issues = error.issues.length > 0 ? `\n${error.issues.map((issue) => `  ${issue}`).join("\n")}` : "";
    return `${error.message}${hint}${issues}`;
  }
  if (error instanceof CurviNetworkError) return error.message;
  return error instanceof Error ? error.message : String(error);
}

export async function run(argv: readonly string[], deps: CliDeps): Promise<number> {
  const [command, sub, ...rest] = argv;
  try {
    if (!command || command === "help" || command === "--help" || command === "-h") {
      deps.stdout(HELP);
      return EXIT.ok;
    }
    if (command === "--version" || command === "-v" || command === "version") {
      deps.stdout(`${CLI_VERSION}\n`);
      return EXIT.ok;
    }
    if (argv.includes("--help")) {
      deps.stdout(HELP);
      return EXIT.ok;
    }
    if (command === "auth") {
      if (sub === "login") return await authLogin(deps, rest);
      if (sub === "status") return await authStatus(deps, rest);
      if (sub === "logout") return await authLogout(deps);
      throw new UsageError("Use curvi auth login, curvi auth status or curvi auth logout.");
    }
    if (command === "pack") {
      if (sub === "create") return await packCreate(deps, rest);
      if (sub === "get") return await packGet(deps, rest);
      throw new UsageError("Use curvi pack create or curvi pack get.");
    }
    if (command === "check") {
      return await check(deps, sub === undefined ? rest : [sub, ...rest]);
    }
    if (command === "channels") {
      return await channels(deps, sub === undefined ? rest : [sub, ...rest]);
    }
    throw new UsageError(`Unknown command ${command}. Run curvi help.`);
  } catch (error) {
    if (error instanceof UsageError) {
      deps.stderr(`${error.message}\n`);
      return EXIT.usage;
    }
    deps.stderr(`${describeError(error)}\n`);
    return EXIT.error;
  }
}
