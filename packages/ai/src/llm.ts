/**
 * Provider neutral LLM contract (docs/phases/PHASE_17.md workstream 1).
 *
 * The runner, the recipes and their tests speak only these shapes. Each LLM
 * adapter translates an LlmRequest into its own wire format and its reply
 * into an LlmResult, so any provider can serve any recipe from seed data
 * alone (CLAUDE.md rule 2). No code outside an adapter builds a provider
 * shaped content block or reads a provider shaped reply.
 */

/** Image formats every LLM adapter accepts as base64 input. GIF is kept
 * because the runner forwards an undecodable upload as sniffed. */
export type LlmImageMediaType = "image/jpeg" | "image/png" | "image/webp" | "image/gif";

export type LlmContentBlock =
  | { type: "text"; text: string }
  | {
      type: "image";
      mediaType: LlmImageMediaType;
      /** The image bytes, base64 encoded, without a data URL prefix. */
      base64: string;
      /** Resolution hint for providers that take one; others ignore it. */
      detail?: "low" | "high";
    };

/**
 * Reasoning effort. "none" turns reasoning or thinking off where the model
 * allows it. Valid values differ by model, so recipes set effort per model id
 * (LlmRequest.modelOptions) and a model without an entry runs at its default.
 */
export type LlmEffort = "none" | "low" | "medium" | "high" | "xhigh" | "max";

/** Per model settings from the recipe row. */
export interface LlmModelOptions {
  effort?: LlmEffort;
}

export interface LlmMessage {
  role: "user" | "assistant";
  content: LlmContentBlock[];
}

/** The structured answer a request asks for. */
export interface LlmOutputSpec {
  /** A short identifier for the answer, e.g. "emit_result". */
  name: string;
  /** JSON Schema of the answer. */
  schema: unknown;
  /** Ask the provider to enforce the schema exactly. */
  strict: boolean;
}

export interface LlmRequest {
  system: string;
  messages: LlmMessage[];
  /** Structured output. Without it the answer is free text, and json is
   * whatever JSON object the text holds. */
  output?: LlmOutputSpec;
  /** Output token budget (reasoning included where the provider counts it
   * there). The adapter default applies when unset. */
  maxOutputTokens?: number;
  /** Effort for any model without its own entry in modelOptions. */
  effort?: LlmEffort;
  /** Effort per model id from the recipe body. Each provider in a failover
   * chain applies only the entry for the model it runs. */
  modelOptions?: Record<string, LlmModelOptions>;
  /** Pins the model. Leave unset in a failover chain: each provider runs
   * its own model. */
  model?: string;
  /** Per attempt timeout. The router enforces timeouts; adapters ignore it. */
  timeoutMs?: number;
}

export type LlmFinish = "complete" | "truncated" | "refused" | "filtered";

export interface LlmUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
}

export interface LlmResult {
  /** The structured answer, or null when the reply held none. */
  json: unknown;
  /** The reply's visible text, empty when there was none. */
  text: string;
  finish: LlmFinish;
  usage: LlmUsage;
  /** The provider's reply, for logs only. */
  raw: unknown;
}

/** The effort a request runs at on one model. */
export function llmEffortFor(request: Pick<LlmRequest, "effort" | "modelOptions">, model: string): LlmEffort | undefined {
  return request.modelOptions?.[model]?.effort ?? request.effort;
}

/** True for an adapter's LlmResult. Test and demo providers may return the
 * answer object itself, which callers then take as the json. */
export function isLlmResult(value: unknown): value is LlmResult {
  if (!value || typeof value !== "object") {
    return false;
  }
  const v = value as Partial<LlmResult>;
  return "json" in v && typeof v.text === "string" && typeof v.finish === "string" && typeof v.usage === "object";
}

/** Zero usage, the start of a sum. */
export function emptyLlmUsage(): LlmUsage {
  return { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0 };
}

/**
 * The provider family of a registered LLM provider name. The live runtime
 * registers each model as "<family>:<model>" (trigger/src/recipes.ts
 * llmModelProviderName), so the family is the part before the first colon.
 * Null for a name without one (test and demo providers).
 */
export function llmProviderFamilyOf(providerName: string): string | null {
  const colon = providerName.indexOf(":");
  return colon > 0 ? providerName.slice(0, colon) : null;
}

/**
 * The JSON a free text answer holds: the whole text, else a fenced block,
 * else the outermost object literal. Null when none parses. Adapters use it
 * when a model answers in text instead of the structured channel.
 */
export function jsonFromText(text: string): unknown {
  const candidates = [text];
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) {
    candidates.push(fenced[1]);
  }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    candidates.push(text.slice(start, end + 1));
  }
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as unknown;
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}
