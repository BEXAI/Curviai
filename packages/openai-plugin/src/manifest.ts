/**
 * The checks the plugin ZIP must pass before the founder uploads it
 * (docs/phases/PHASE_19.md, P19-25; the limits and their sources are in
 * ./limits). `checkPlugin` reads the plugin folder (package/: plugin.json,
 * mcp.json, assets/) and answers every problem found, so the build and
 * manifest.test.ts run the same checks.
 *
 * Errors stop the build. Warnings name what review still needs from the
 * founder (the demo recording, runbook C4) without stopping a local build.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { rule9Problems } from "@curvi/pipeline/copy-lint";
import { mcpCopyProblems } from "@/lib/api-v1/mcp-copy";
import { channelListingLines, liveChannelFamilies, notLiveChannelNames, type ChannelFamilyFact } from "./channels";
import { imageSize } from "./images";
import {
  ARCHIVE_LIMITS,
  ASSET_LIMITS,
  BRAND_CONTRAST,
  CATEGORIES,
  DEVELOPER_NAME_PLACEHOLDER,
  FORBIDDEN_KEYS,
  LIMITS,
  LISTING_PRICE_WORDS,
  MCP_SCHEMA_URL,
  MCP_URL,
  NAME_SUFFIX_WORDS,
  PLUGIN_SCHEMA_URL,
  TEST_CASES,
} from "./limits";

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
const REPO_ROOT = resolve(PACKAGE_ROOT, "..", "..");

/** The plugin folder that is zipped: plugin.json, mcp.json and assets/. */
export const PLUGIN_DIR = join(PACKAGE_ROOT, "package");
/** The web app's public folder, where file_attachment_urls on the site live. */
export const WEB_PUBLIC_DIR = join(REPO_ROOT, "apps", "web", "public");
/** The site's design tokens, where the brand colors come from. */
export const SITE_TOKENS_CSS = join(REPO_ROOT, "apps", "web", "src", "app", "globals.css");
/** The site the listing URLs and attachments point at. */
export const SITE_ORIGIN = "https://curvi.ai";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

export interface PluginFile {
  /** Path inside the ZIP, with forward slashes. */
  path: string;
  /** Path on disk. */
  absolute: string;
  bytes: number;
}

export interface CheckOptions {
  /** The plugin folder (package/ by default). */
  dir?: string;
  /** The channel list (the web app's CHANNEL_FAMILIES by default). */
  families?: readonly ChannelFamilyFact[];
  /** Colors the site defines (read from globals.css by default). */
  siteColors?: readonly string[];
  /** Where attachments on SITE_ORIGIN are served from. */
  publicDir?: string;
  /** Fills author.name and interface.developerName at build time, in place
   * of the placeholder (the verified developer name, decision 8). */
  developerName?: string;
}

export interface CheckResult {
  errors: string[];
  warnings: string[];
  /** plugin.json as it goes into the ZIP (with the developer name filled
   * in), or null when it could not be read. */
  manifest: JsonObject | null;
  /** mcp.json as read, or null. */
  mcp: JsonObject | null;
  /** The files that go into the ZIP. */
  files: PluginFile[];
}

// Small readers

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJson(path: string): { ok: true; value: Json } | { ok: false; problem: string } {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return { ok: false, problem: "is missing or unreadable" };
  }
  try {
    return { ok: true, value: JSON.parse(text) as Json };
  } catch {
    return { ok: false, problem: "is not valid JSON" };
  }
}

/** Colors defined as `--color-*: #rrggbb` in the site's tokens. */
export function readSiteColors(path = SITE_TOKENS_CSS): string[] {
  const css = readFileSync(path, "utf8");
  return [...css.matchAll(/--color-[a-z0-9-]+:\s*(#[0-9a-fA-F]{6})\b/g)].map((match) => match[1]!.toLowerCase());
}

/** WCAG relative luminance of a #rrggbb color. */
export function relativeLuminance(hex: string): number {
  const channels = [1, 3, 5].map((start) => parseInt(hex.slice(start, start + 2), 16) / 255);
  const [r, g, b] = channels.map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two #rrggbb colors. */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** Every file under the folder, skipping Finder's .DS_Store. */
export function pluginFiles(dir: string): PluginFile[] {
  const out: PluginFile[] = [];
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(absolute);
      } else if (entry.isFile() && entry.name !== ".DS_Store") {
        out.push({ path: relative(dir, absolute).split(sep).join("/"), absolute, bytes: statSync(absolute).size });
      }
    }
  };
  walk(dir);
  return out;
}

// Field checks

class Problems {
  readonly errors: string[] = [];
  readonly warnings: string[] = [];
  error(field: string, problem: string): void {
    this.errors.push(`${field}: ${problem}`);
  }
  warn(field: string, problem: string): void {
    this.warnings.push(`${field}: ${problem}`);
  }
}

function text(problems: Problems, field: string, value: unknown, max: number, options: { singleLine?: boolean; required?: boolean } = {}): string | null {
  const { singleLine = true, required = true } = options;
  if (value === undefined) {
    if (required) {
      problems.error(field, "is missing");
    }
    return null;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    problems.error(field, "must be a non empty string");
    return null;
  }
  if ([...value].length > max) {
    problems.error(field, `is ${[...value].length} characters, over the limit of ${max}`);
  }
  if (singleLine && /[\r\n]/.test(value)) {
    problems.error(field, "must be one line");
  }
  return value;
}

/** An HTTPS URL with a host and no embedded credentials (O4). */
function httpsUrl(problems: Problems, field: string, value: unknown, options: { required?: boolean } = {}): URL | null {
  if (value === undefined && options.required === false) {
    return null;
  }
  if (typeof value !== "string") {
    problems.error(field, "must be an HTTPS URL");
    return null;
  }
  if (value.length > LIMITS.url) {
    problems.error(field, `is over ${LIMITS.url} characters`);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    problems.error(field, "is not a URL");
    return null;
  }
  if (url.protocol !== "https:" || url.hostname.length === 0) {
    problems.error(field, "must be an HTTPS URL with a host");
  }
  if (url.username || url.password) {
    problems.error(field, "must not carry credentials");
  }
  return url;
}

/** Listing text: rule 9 (CLAUDE.md), and no price, credit or promotion
 * wording (R16, O6). */
function listingCopy(problems: Problems, field: string, value: string | null): void {
  if (value === null) {
    return;
  }
  for (const problem of rule9Problems(value)) {
    problems.error(field, `rule 9: ${problem}`);
  }
  for (const word of LISTING_PRICE_WORDS) {
    if (new RegExp(`\\b${word}`, "i").test(value)) {
      problems.error(field, `uses "${word}", which listings may not use`);
    }
  }
  for (const problem of mcpCopyProblems(value)) {
    problems.error(field, problem);
  }
}

/** Review text: rule 9 only (it may say credits: it describes behavior). */
function reviewCopy(problems: Problems, field: string, value: string | null): void {
  if (value === null) {
    return;
  }
  for (const problem of rule9Problems(value)) {
    problems.error(field, `rule 9: ${problem}`);
  }
}

function forbiddenKeys(problems: Problems, value: Json, path: string): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => forbiddenKeys(problems, item, `${path}[${index}]`));
    return;
  }
  if (!isObject(value)) {
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if ((FORBIDDEN_KEYS as readonly string[]).includes(key)) {
      problems.error(`${path}.${key}`, "is refused in the ZIP; reviewer access goes in the dashboard");
    }
    forbiddenKeys(problems, child, `${path}.${key}`);
  }
}

function brandColor(problems: Problems, field: string, value: unknown, against: string, siteColors: readonly string[]): void {
  if (typeof value !== "string" || !/^#[0-9A-Fa-f]{6}$/.test(value)) {
    problems.error(field, "must be a six digit hex color such as #EC4899");
    return;
  }
  const ratio = contrastRatio(value.toLowerCase(), against);
  if (ratio < BRAND_CONTRAST.minimum) {
    problems.error(field, `has ${ratio.toFixed(2)}:1 contrast against ${against}, under ${BRAND_CONTRAST.minimum}:1`);
  }
  if (!siteColors.includes(value.toLowerCase())) {
    problems.error(field, "is not one of the site's brand tokens (apps/web/src/app/globals.css)");
  }
}

function asset(problems: Problems, field: string, value: unknown, dir: string, options: { required: boolean }): void {
  if (value === undefined) {
    if (options.required) {
      problems.error(field, "is missing");
    }
    return;
  }
  if (typeof value !== "string" || !value.startsWith("./")) {
    problems.error(field, "must be a path relative to the plugin root starting with ./");
    return;
  }
  const absolute = resolve(dir, value);
  if (!absolute.startsWith(dir + sep)) {
    problems.error(field, "must stay inside the plugin folder");
    return;
  }
  const extension = extname(absolute).toLowerCase();
  if (!(ASSET_LIMITS.extensions as readonly string[]).includes(extension)) {
    problems.error(field, `must be one of ${ASSET_LIMITS.extensions.join(", ")}`);
    return;
  }
  let bytes: Buffer;
  try {
    bytes = readFileSync(absolute);
  } catch {
    problems.error(field, `names ${value}, which is missing`);
    return;
  }
  if (bytes.length > ASSET_LIMITS.maxBytes) {
    problems.error(field, "is over 5 MiB");
  }
  const size = imageSize(bytes);
  if (!size) {
    problems.error(field, "must be a readable PNG or JPEG");
    return;
  }
  if (size.width !== size.height) {
    problems.error(field, `must be square, and is ${size.width} by ${size.height}`);
  }
  if (Math.min(size.width, size.height) < ASSET_LIMITS.minPx || Math.max(size.width, size.height) > ASSET_LIMITS.maxPx) {
    problems.error(field, `must be ${ASSET_LIMITS.minPx} to ${ASSET_LIMITS.maxPx} px, and is ${size.width} by ${size.height}`);
  }
}

/** "a, b , c" as tool names. */
export function toolsTriggered(value: string): string[] {
  return value
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
}

function testCases(problems: Problems, review: JsonObject, publicDir: string): void {
  const cases = review.test_cases;
  if (!isObject(cases)) {
    problems.error("review.test_cases", "is missing");
    return;
  }
  const positive = Array.isArray(cases.positive) ? cases.positive : [];
  const negative = Array.isArray(cases.negative) ? cases.negative : [];
  if (positive.length !== TEST_CASES.positive) {
    problems.error("review.test_cases.positive", `has ${positive.length} cases; review needs exactly ${TEST_CASES.positive}`);
  }
  if (negative.length !== TEST_CASES.negative) {
    problems.error("review.test_cases.negative", `has ${negative.length} cases; review needs exactly ${TEST_CASES.negative}`);
  }
  const allowedPositive = new Set(["description", "prompt", "tools_triggered", "expected_behavior", "file_attachment_urls", "expected_output_url"]);
  positive.forEach((entry, index) => {
    const at = `review.test_cases.positive[${index}]`;
    if (!isObject(entry)) {
      problems.error(at, "must be an object");
      return;
    }
    for (const key of Object.keys(entry)) {
      if (!allowedPositive.has(key)) {
        problems.error(`${at}.${key}`, "is not a test case field");
      }
    }
    for (const key of ["description", "prompt", "expected_behavior"] as const) {
      reviewCopy(problems, `${at}.${key}`, text(problems, `${at}.${key}`, entry[key], 4_000, { singleLine: false }));
    }
    const tools = text(problems, `${at}.tools_triggered`, entry.tools_triggered, 1_000);
    if (tools !== null && !toolsTriggered(tools).every((name) => /^[a-z][a-z0-9_]*$/.test(name))) {
      problems.error(`${at}.tools_triggered`, "must list tool names separated by commas");
    }
    if (entry.file_attachment_urls !== undefined) {
      if (!Array.isArray(entry.file_attachment_urls) || entry.file_attachment_urls.length === 0) {
        problems.error(`${at}.file_attachment_urls`, "must be a non empty list of HTTPS URLs");
      } else {
        entry.file_attachment_urls.forEach((value, n) => {
          const url = httpsUrl(problems, `${at}.file_attachment_urls[${n}]`, value);
          if (url && url.origin === SITE_ORIGIN) {
            // A file the site serves from apps/web/public must be there.
            const file = join(publicDir, decodeURIComponent(url.pathname));
            if (!file.startsWith(publicDir + sep) || !statSafe(file)) {
              problems.error(`${at}.file_attachment_urls[${n}]`, `points at ${url.pathname}, which apps/web/public does not have`);
            }
          }
        });
      }
    }
    httpsUrl(problems, `${at}.expected_output_url`, entry.expected_output_url, { required: false });
  });
  negative.forEach((entry, index) => {
    const at = `review.test_cases.negative[${index}]`;
    if (!isObject(entry)) {
      problems.error(at, "must be an object");
      return;
    }
    for (const key of Object.keys(entry)) {
      if (key !== "description" && key !== "prompt") {
        problems.error(`${at}.${key}`, "a negative case carries only description and prompt");
      }
    }
    for (const key of ["description", "prompt"] as const) {
      reviewCopy(problems, `${at}.${key}`, text(problems, `${at}.${key}`, entry[key], 4_000, { singleLine: false }));
    }
  });
}

function statSafe(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function normalizedPrompt(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
}

function checkInterface(problems: Problems, ui: JsonObject, dir: string, families: readonly ChannelFamilyFact[], siteColors: readonly string[], authorUrl: URL | null): void {
  const displayName = text(problems, "interface.displayName", ui.displayName, LIMITS.displayName);
  listingCopy(problems, "interface.displayName", displayName);
  if (displayName && NAME_SUFFIX_WORDS.some((word) => new RegExp(`\\b${word}\\b`, "i").test(displayName))) {
    problems.error("interface.displayName", "must not add MCP or Plugin to the name");
  }
  listingCopy(problems, "interface.shortDescription", text(problems, "interface.shortDescription", ui.shortDescription, LIMITS.shortDescription));
  const long = text(problems, "interface.longDescription", ui.longDescription, LIMITS.longDescription, { singleLine: false });
  listingCopy(problems, "interface.longDescription", long);

  const developer = text(problems, "interface.developerName", ui.developerName, LIMITS.developerName);
  if (developer === DEVELOPER_NAME_PLACEHOLDER) {
    problems.error("interface.developerName", "still holds the placeholder; set the verified developer name (runbook A4)");
  }

  if (typeof ui.category !== "string" || !(CATEGORIES as readonly string[]).includes(ui.category)) {
    problems.error("interface.category", `must be one of ${CATEGORIES.join(", ")}`);
  }

  const capabilities = Array.isArray(ui.capabilities) ? ui.capabilities : null;
  if (!capabilities || capabilities.length === 0) {
    problems.error("interface.capabilities", "must be a non empty list");
  } else if (capabilities.length > LIMITS.capabilityCount) {
    problems.error("interface.capabilities", `has ${capabilities.length} entries, over ${LIMITS.capabilityCount}`);
  }
  const capabilityLines = (capabilities ?? []).map((value, index) => {
    const line = text(problems, `interface.capabilities[${index}]`, value, LIMITS.capability);
    listingCopy(problems, `interface.capabilities[${index}]`, line);
    return line ?? "";
  });

  // Channel names (decision 17): the lines that list channels are the ones
  // CHANNEL_FAMILIES generates, and no line names a channel that is not live.
  const generated = channelListingLines(families);
  for (const line of generated.capabilities) {
    if (!capabilityLines.includes(line)) {
      problems.error("interface.capabilities", `is missing the channel line generated from the live channels: "${line}"`);
    }
  }
  if (long !== null && !long.includes(generated.longDescription)) {
    problems.error("interface.longDescription", `must carry the channel list generated from the live channels: "${generated.longDescription}"`);
  }
  for (const [field, value] of [["interface.longDescription", long ?? ""], ...capabilityLines.map((line, i) => [`interface.capabilities[${i}]`, line])] as const) {
    for (const name of notLiveChannelNames(value, families)) {
      problems.error(field, `names ${name}, which is not a live channel`);
    }
  }

  const urls = (["websiteURL", "supportURL", "privacyPolicyURL", "termsOfServiceURL"] as const).map((key) => [
    key,
    httpsUrl(problems, `interface.${key}`, ui[key]),
  ] as const);
  for (const [key, url] of urls) {
    // The four listing URLs come from the same publisher (R17, O3).
    if (url && authorUrl && url.hostname !== authorUrl.hostname) {
      problems.error(`interface.${key}`, `must be on ${authorUrl.hostname}, the publisher's site`);
    }
  }

  const prompts = Array.isArray(ui.defaultPrompt) ? ui.defaultPrompt : null;
  if (!prompts || prompts.length === 0) {
    problems.error("interface.defaultPrompt", "must be a non empty list");
  } else if (prompts.length > LIMITS.promptCount) {
    problems.error("interface.defaultPrompt", `has ${prompts.length} prompts, over ${LIMITS.promptCount}`);
  }
  const seen = new Set<string>();
  (prompts ?? []).forEach((value, index) => {
    const field = `interface.defaultPrompt[${index}]`;
    const prompt = text(problems, field, value, LIMITS.prompt);
    listingCopy(problems, field, prompt);
    if (prompt !== null) {
      if (/(^|\s)@\S/.test(prompt)) {
        problems.error(field, "must not @mention an MCP server");
      }
      const key = normalizedPrompt(prompt);
      if (seen.has(key)) {
        problems.error(field, "repeats another prompt");
      }
      seen.add(key);
    }
  });

  brandColor(problems, "interface.brandColor", ui.brandColor, BRAND_CONTRAST.light, siteColors);
  brandColor(problems, "interface.brandColorDark", ui.brandColorDark, BRAND_CONTRAST.dark, siteColors);
  asset(problems, "interface.logo", ui.logo, dir, { required: true });
  asset(problems, "interface.composerIcon", ui.composerIcon, dir, { required: true });
  asset(problems, "interface.logoDark", ui.logoDark, dir, { required: false });
  asset(problems, "interface.composerIconDark", ui.composerIconDark, dir, { required: false });
  if (ui.screenshots !== undefined) {
    // Refused without a UI template in the tool scan (O4) and no longer shown
    // in the directory (O6); the first ZIP carries none (decision 6).
    problems.error("interface.screenshots", "must be left out of this ZIP");
  }
}

function checkMcp(problems: Problems, dir: string): JsonObject | null {
  const read = readJson(join(dir, "mcp.json"));
  if (!read.ok) {
    problems.error("mcp.json", read.problem);
    return null;
  }
  if (!isObject(read.value)) {
    problems.error("mcp.json", "must be a JSON object");
    return null;
  }
  const mcp = read.value;
  if (mcp.$schema !== MCP_SCHEMA_URL) {
    problems.error("mcp.json $schema", `must be ${MCP_SCHEMA_URL}`);
  }
  const servers = isObject(mcp.mcpServers) ? Object.entries(mcp.mcpServers) : null;
  if (!servers) {
    problems.error("mcp.json mcpServers", "is missing");
    return mcp;
  }
  if (servers.length !== 1) {
    problems.error("mcp.json mcpServers", `has ${servers.length} servers; a plugin connects exactly one`);
  }
  for (const [name, server] of servers) {
    const field = `mcp.json mcpServers.${name}`;
    if (!isObject(server)) {
      problems.error(field, "must be an object");
      continue;
    }
    if (server.type !== "streamable-http") {
      problems.error(`${field}.type`, 'must be "streamable-http"');
    }
    httpsUrl(problems, `${field}.url`, server.url);
    if (server.url !== MCP_URL) {
      // The MCP origin can never change, and the plan keeps the whole URL
      // fixed (decision 9).
      problems.error(`${field}.url`, `must be ${MCP_URL}, the permanent MCP URL`);
    }
  }
  return mcp;
}

function checkFiles(problems: Problems, files: readonly PluginFile[]): void {
  if (files.length > ARCHIVE_LIMITS.maxEntries) {
    problems.error("ZIP", `has ${files.length} entries, over ${ARCHIVE_LIMITS.maxEntries}`);
  }
  const total = files.reduce((sum, file) => sum + file.bytes, 0);
  if (total > ARCHIVE_LIMITS.maxUncompressedBytes) {
    problems.error("ZIP", "is over 512 MiB uncompressed");
  }
  for (const file of files) {
    if (file.bytes > ARCHIVE_LIMITS.maxFileBytes) {
      problems.error(file.path, "is over 100 MiB");
    }
    if (file.path.split("/").length > ARCHIVE_LIMITS.maxPathSegments) {
      problems.error(file.path, `has more than ${ARCHIVE_LIMITS.maxPathSegments} path segments`);
    }
    const top = file.path.split("/")[0]!;
    if (top === "hooks" || file.path.endsWith(".app.json")) {
      problems.error(file.path, "hooks and app manifests are not part of this plugin");
    }
    if (top === "skills") {
      // Decision 11: no skills in the first ZIP (the skill asks for an API key).
      problems.error(file.path, "skills are not part of the first ZIP (decision 11)");
    }
  }
}

/** Every check P19-25 names, over the plugin folder. */
export function checkPlugin(options: CheckOptions = {}): CheckResult {
  const dir = resolve(options.dir ?? PLUGIN_DIR);
  const families = options.families ?? liveChannelFamilies();
  const siteColors = options.siteColors ?? readSiteColors();
  const publicDir = resolve(options.publicDir ?? WEB_PUBLIC_DIR);
  const problems = new Problems();
  const files = pluginFiles(dir);
  checkFiles(problems, files);
  const mcp = checkMcp(problems, dir);

  const read = readJson(join(dir, "plugin.json"));
  if (!read.ok || !isObject(read.value)) {
    problems.error("plugin.json", read.ok ? "must be a JSON object" : read.problem);
    return { errors: problems.errors, warnings: problems.warnings, manifest: null, mcp, files };
  }
  const manifest = structuredClone(read.value);
  const openai = isObject(manifest.extensions) && isObject(manifest.extensions["com.openai"]) ? manifest.extensions["com.openai"] : null;
  const ui = openai && isObject(openai.interface) ? openai.interface : null;
  const author = isObject(manifest.author) ? manifest.author : null;
  if (options.developerName !== undefined) {
    if (author) {
      author.name = options.developerName;
    }
    if (ui) {
      ui.developerName = options.developerName;
    }
  }

  forbiddenKeys(problems, manifest, "plugin.json");
  if (manifest.$schema !== PLUGIN_SCHEMA_URL) {
    problems.error("$schema", `must be ${PLUGIN_SCHEMA_URL}`);
  }
  const name = text(problems, "name", manifest.name, LIMITS.name);
  if (name !== null && !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name)) {
    problems.error("name", "must start with a letter or digit and use only letters, digits, _ and -");
  }
  const version = text(problems, "version", manifest.version, LIMITS.version);
  if (version !== null && !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
    problems.error("version", "must be a semantic version such as 1.0.0");
  }
  listingCopy(problems, "description", text(problems, "description", manifest.description, LIMITS.rootDescription, { singleLine: false }));

  let authorUrl: URL | null = null;
  if (!author) {
    problems.error("author", "is missing");
  } else {
    const authorName = text(problems, "author.name", author.name, LIMITS.authorName);
    if (authorName === DEVELOPER_NAME_PLACEHOLDER) {
      problems.error("author.name", "still holds the placeholder; set the verified developer name (runbook A4)");
    }
    if (authorName !== null && ui && typeof ui.developerName === "string" && ui.developerName !== authorName) {
      problems.error("interface.developerName", "must equal author.name (decision 8)");
    }
    const email = text(problems, "author.email", author.email, LIMITS.authorEmail, { required: false });
    if (email !== null && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      problems.error("author.email", "is not an email address");
    }
    authorUrl = httpsUrl(problems, "author.url", author.url);
  }
  httpsUrl(problems, "homepage", manifest.homepage, { required: false });

  if (!openai) {
    problems.error('extensions["com.openai"]', "is missing");
    return { errors: problems.errors, warnings: problems.warnings, manifest, mcp, files };
  }
  for (const key of ["apps", "hooks", "onboardingSkill"] as const) {
    if (openai[key] !== undefined) {
      problems.error(`extensions["com.openai"].${key}`, "is not part of this plugin (hooks, app manifests and skills stay out, decision 11)");
    }
  }
  if (!ui) {
    problems.error("interface", "is missing");
  } else {
    checkInterface(problems, ui, dir, families, siteColors, authorUrl);
  }

  const review = isObject(openai.review) ? openai.review : null;
  if (!review) {
    problems.error("review", "is missing");
  } else {
    testCases(problems, review, publicDir);
    if (review.commerce !== undefined && typeof review.commerce !== "boolean") {
      problems.error("review.commerce", "must be true or false");
    }
    reviewCopy(problems, "review.commerce_description", text(problems, "review.commerce_description", review.commerce_description, 4_000, { required: false, singleLine: false }));
    if (review.demo_recording_url === undefined) {
      problems.warn("review.demo_recording_url", "is not set yet; MCP review needs it (runbook C4)");
    } else {
      httpsUrl(problems, "review.demo_recording_url", review.demo_recording_url);
    }
  }

  const publication = isObject(openai.publication) ? openai.publication : null;
  if (!publication) {
    problems.error("publication", "is missing");
  } else {
    if (publication.countries !== undefined) {
      if (!Array.isArray(publication.countries) || !publication.countries.every((code) => typeof code === "string" && /^[A-Z]{2}$/.test(code))) {
        problems.error("publication.countries", "must be a list of uppercase country codes, or [] for every country");
      }
    }
    listingCopy(problems, "publication.release_notes", text(problems, "publication.release_notes", publication.release_notes, LIMITS.longDescription, { singleLine: false }));
    if (publication.translations !== undefined) {
      problems.error("publication.translations", "is not part of the first ZIP");
    }
  }

  return { errors: problems.errors, warnings: problems.warnings, manifest, mcp, files };
}
