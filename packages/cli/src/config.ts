/**
 * Where the CLI keeps the API key: a JSON file in the user config directory,
 * readable by the owner only. CURVI_API_KEY and CURVI_API_URL in the
 * environment win over the file, so an agent or CI can run without it.
 *
 * Directory, first match wins:
 *   CURVI_CONFIG_DIR
 *   Windows: %APPDATA%\curvi
 *   macOS: ~/Library/Application Support/curvi
 *   elsewhere: $XDG_CONFIG_HOME/curvi, else ~/.config/curvi
 */

import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { UsageError } from "./args.ts";
import { DEFAULT_BASE_URL } from "./client.ts";

export const CONFIG_FILE_NAME = "config.json";

export interface StoredConfig {
  apiKey?: string;
  apiUrl?: string;
}

export interface ConfigEnv {
  env: Record<string, string | undefined>;
  platform: NodeJS.Platform;
  homedir: string;
}

export function configDir({ env, platform, homedir }: ConfigEnv): string {
  if (env.CURVI_CONFIG_DIR) return env.CURVI_CONFIG_DIR;
  if (platform === "win32") {
    return join(env.APPDATA ?? join(homedir, "AppData", "Roaming"), "curvi");
  }
  if (platform === "darwin") {
    return join(homedir, "Library", "Application Support", "curvi");
  }
  return join(env.XDG_CONFIG_HOME ?? join(homedir, ".config"), "curvi");
}

export function configPath(where: ConfigEnv): string {
  return join(configDir(where), CONFIG_FILE_NAME);
}

/** The stored config, or an empty one when the file is missing or unreadable. */
export async function readConfig(where: ConfigEnv): Promise<StoredConfig> {
  let text: string;
  try {
    text = await readFile(configPath(where), "utf8");
  } catch {
    return {};
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    const record = parsed as Record<string, unknown>;
    return {
      ...(typeof record.apiKey === "string" ? { apiKey: record.apiKey } : {}),
      ...(typeof record.apiUrl === "string" ? { apiUrl: record.apiUrl } : {}),
    };
  } catch {
    return {};
  }
}

/** Writes the config with owner only permissions (0700 folder, 0600 file). */
export async function writeConfig(where: ConfigEnv, config: StoredConfig): Promise<string> {
  const dir = configDir(where);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = configPath(where);
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  // writeFile keeps the mode of a file that already exists; set it again.
  if (where.platform !== "win32") await chmod(path, 0o600);
  return path;
}

export async function deleteConfig(where: ConfigEnv): Promise<void> {
  await rm(configPath(where), { force: true });
}

export interface ResolvedAuth {
  apiKey: string | null;
  apiUrl: string;
  /** Where the key came from, for curvi auth status. */
  keySource: "env" | "config" | null;
}

export function resolveAuth(
  env: Record<string, string | undefined>,
  stored: StoredConfig,
  apiUrlFlag?: string,
): ResolvedAuth {
  const envKey = env.CURVI_API_KEY?.trim();
  const apiKey = envKey || stored.apiKey || null;
  return {
    apiKey,
    apiUrl: apiUrlFlag || env.CURVI_API_URL || stored.apiUrl || DEFAULT_BASE_URL,
    keySource: envKey ? "env" : stored.apiKey ? "config" : null,
  };
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Checks an API base URL before a key is sent to it or saved with it: https
 * only, with plain http allowed for this machine alone, so a typo or a proxy
 * never carries the bearer key in cleartext.
 */
export function checkApiUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new UsageError(`The API URL ${value} is not a valid URL.`);
  }
  if (url.protocol === "https:") return url;
  if (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname)) return url;
  throw new UsageError(
    `The API URL must start with https. Plain http is allowed only for localhost; ${value} was refused.`,
  );
}

/** The origin a saved key belongs to: the URL saved with it at login. */
export function savedKeyOrigin(stored: StoredConfig): string {
  return checkApiUrl(stored.apiUrl ?? DEFAULT_BASE_URL).origin;
}

/**
 * Refuses to send a key where it does not belong. The URL must pass
 * checkApiUrl, and a key saved by curvi auth login only goes to the origin it
 * was saved for; --api-url or CURVI_API_URL pointing elsewhere needs a new
 * login there (or CURVI_API_KEY), so an injected flag cannot repoint it.
 */
export function assertKeyTarget(auth: ResolvedAuth, stored: StoredConfig): void {
  const target = checkApiUrl(auth.apiUrl).origin;
  if (auth.keySource !== "config") return;
  const bound = savedKeyOrigin(stored);
  if (target !== bound) {
    throw new UsageError(
      `The saved key is for ${bound}, so it was not sent to ${target}. ` +
        `To use that API, run curvi auth login --api-url ${auth.apiUrl} or set CURVI_API_KEY.`,
    );
  }
}

/** "curvi_live_ab12...wxyz": enough to tell keys apart, never the secret. */
export function maskKey(key: string): string {
  if (key.length <= 12) return `${key.slice(0, 2)}...`;
  return `${key.slice(0, 10)}...${key.slice(-4)}`;
}
