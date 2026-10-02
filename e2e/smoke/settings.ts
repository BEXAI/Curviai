export type SmokeMode = "demo" | "production" | "staging" | "synthetic";
export interface SmokeSettings { baseURL: string; mode: SmokeMode; packEnabled: boolean }

/** Refuse ambiguous targets before a browser or API request is made. */
export function smokeSettings(env: Readonly<Record<string, string | undefined>>): SmokeSettings {
  const raw = env.SMOKE_BASE_URL;
  if (!raw) throw new Error("Set SMOKE_BASE_URL to an existing deployment.");
  const url = new URL(raw);
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("SMOKE_BASE_URL must be an origin without credentials, path, query or fragment.");
  }
  const mode = env.SMOKE_MODE ?? "demo";
  if (!["demo", "production", "staging", "synthetic"].includes(mode)) throw new Error("Unknown SMOKE_MODE.");
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  const production = url.hostname === "curvi.ai" || url.hostname === "www.curvi.ai";
  if (!local && url.protocol !== "https:") throw new Error("Remote smoke targets require https.");
  if (local && !["http:", "https:"].includes(url.protocol)) throw new Error("Local smoke targets require http or https.");
  if (mode === "demo" && !local) throw new Error("Demo smoke runs only on loopback.");
  if ((mode === "production" || mode === "synthetic") && !production) throw new Error("Production smoke requires the canonical production host.");
  if (mode === "staging" && (local || production)) throw new Error("Staging smoke requires its separate remote origin.");
  const packEnabled = mode === "staging"
    ? env.SMOKE_ALLOW_PACKS === "1"
    : mode === "synthetic" && env.SMOKE_ALLOW_PRODUCTION_PACK === "1" && env.SMOKE_WORKSPACE_EXCLUDED === "1";
  if (mode === "synthetic" && !packEnabled) {
    throw new Error("Synthetic smoke requires explicit production-pack opt-in and a verified excluded operator workspace.");
  }
  if (packEnabled && !env.SMOKE_API_KEY) throw new Error("An enabled pack smoke needs SMOKE_API_KEY for that environment.");
  return { baseURL: url.origin, mode: mode as SmokeMode, packEnabled };
}
