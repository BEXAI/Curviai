/**
 * Local checks over an explicitly supplied, sanitized tools/list descriptor
 * snapshot. This is not evidence of a live scan or OpenAI approval.
 * Official requirements checked 2026-10-02:
 * https://developers.openai.com/plugins/deploy/submission-errors
 * https://developers.openai.com/plugins/deploy/app-review
 *
 * These rationales are review preparation, not invented manifest fields.
 * Keep them aligned with the actual tools and enter them in the portal.
 */
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { extname } from "node:path";

export const MAX_TOOLS_SNAPSHOT_BYTES = 2 * 1024 * 1024;
export const EXPECTED_PACK_VIEWER_URI = "ui://curvi/pack-viewer/v2.html";

interface AnnotationReview {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  openWorldHint: boolean;
  rationale: string;
}

export const TOOL_ANNOTATION_REVIEW: Readonly<Record<string, AnnotationReview>> = {
  list_channels: {
    readOnlyHint: true, destructiveHint: false, openWorldHint: false,
    rationale: "Reads the supported channel registry and connected workspace entitlements. It creates no pack, spends no credits and accesses no open-ended external destination.",
  },
  estimate_pack: {
    readOnlyHint: true, destructiveHint: false, openWorldHint: true,
    rationale: "Reads the supplied photo and current workspace balance without reconciling jobs, storing photos or reserving credits. It returns an estimate and signed quote. Photo URLs are external inputs, subject to the attachment and destination checks.",
  },
  create_pack: {
    readOnlyHint: false, destructiveHint: true, openWorldHint: true,
    rationale: "Creates a durable generation job, reserves workspace credits and charges delivered outputs. Those consumed credits cannot be undone by this tool. OAuth requires the disclosed signed estimate and credit ceiling. The tool receives external photos and invokes the generation pipeline.",
  },
  get_pack: {
    readOnlyHint: true, destructiveHint: false, openWorldHint: false,
    rationale: "Retrieves an authorized workspace pack and delivered assets using an explicit snapshot read with reconciliation disabled. It starts no generation and does not settle jobs, change credit holds or create completion events. Its results remain within the connected workspace.",
  },
  show_pack: {
    readOnlyHint: true, destructiveHint: false, openWorldHint: false,
    rationale: "Displays an existing authorized pack and delivered files using the same snapshot read as get_pack, with reconciliation disabled. It creates no job, changes no credit hold and publishes nothing to an external destination.",
  },
  check_main_image: {
    readOnlyHint: true, destructiveHint: false, openWorldHint: true,
    rationale: "Reads the supplied image and returns deterministic channel checks without storing or editing it or spending credits. Supplied external photo URLs pass the same destination checks.",
  },
  get_profile: {
    readOnlyHint: true, destructiveHint: false, openWorldHint: false,
    rationale: "Reads the account email and workspace selected by this OAuth connection. It changes no profile, connection or workspace and does not look up external people.",
  },
};

const ANNOTATIONS = ["readOnlyHint", "destructiveHint", "openWorldHint"] as const;
const RENDER_TOOLS = ["create_pack", "show_pack"] as const;

export interface ToolSnapshotCheck {
  errors: string[];
  uiTools: string[];
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function objectSchema(value: unknown): value is Record<string, unknown> {
  if (!object(value) || value.type !== "object" || !object(value.properties)) return false;
  if (!Object.values(value.properties).every((property) => typeof property === "boolean" || object(property))) return false;
  if (value.required === undefined) return true;
  return Array.isArray(value.required) && new Set(value.required).size === value.required.length && value.required.every((name) => typeof name === "string" && Object.hasOwn(value.properties as object, name));
}

/** Accept the tools/list result or its JSON-RPC response, not request logs. */
export function checkToolSnapshot(snapshot: unknown): ToolSnapshotCheck {
  const errors: string[] = [];
  const uiTools: string[] = [];
  const result = object(snapshot) && object(snapshot.result) ? snapshot.result : snapshot;
  if (!object(result) || !Array.isArray(result.tools) || result.nextCursor !== undefined) {
    return { errors: ["MCP snapshot: needs a complete tools/list result with tools and no nextCursor"], uiTools };
  }
  const seen = new Set<string>();
  for (const tool of result.tools) {
    if (!object(tool) || typeof tool.name !== "string" || tool.name.length > 64 || !/^[a-z][a-z0-9_]*$/.test(tool.name)) {
      errors.push("MCP snapshot: contains an invalid tool descriptor name");
      continue;
    }
    const name = tool.name;
    if (seen.has(name)) errors.push(`MCP snapshot: duplicate tool ${name}`);
    seen.add(name);
    const expected = Object.hasOwn(TOOL_ANNOTATION_REVIEW, name) ? TOOL_ANNOTATION_REVIEW[name] : undefined;
    if (!expected) {
      errors.push(`MCP snapshot: ${name} needs an explicit annotation review before submission`);
      continue;
    }
    const annotations = object(tool.annotations) ? tool.annotations : {};
    for (const key of ANNOTATIONS) {
      if (annotations[key] !== expected[key]) {
        errors.push(`MCP snapshot: ${name}.${key} does not match its reviewed behavior`);
      }
    }
    for (const schema of ["inputSchema", "outputSchema"] as const) {
      if (!objectSchema(tool[schema])) errors.push(`MCP snapshot: ${name} needs an object ${schema} with properties and a valid required list`);
    }
    if (["get_pack", "show_pack"].includes(name) && objectSchema(tool.inputSchema)) {
      const properties = tool.inputSchema.properties as Record<string, unknown>;
      if (!object(properties.pack_id) || properties.pack_id.type !== "string" || !Array.isArray(tool.inputSchema.required) || !tool.inputSchema.required.includes("pack_id")) {
        errors.push(`MCP snapshot: ${name} must require a string pack_id`);
      }
    }
    const meta = object(tool._meta) ? tool._meta : {};
    const ui = object(meta.ui) ? meta.ui : {};
    const resource = ui.resourceUri ?? meta["openai/outputTemplate"];
    const visibility = ui.visibility;
    const expectedVisibility = name === "get_pack" ? ["app", "model"] : ["model"];
    if (!Array.isArray(visibility) || [...visibility].sort().join(",") !== expectedVisibility.join(",")) {
      errors.push(`MCP snapshot: ${name} has unexpected UI visibility`);
    }
    if (typeof resource === "string" && /^ui:\/\/[^\s]+$/.test(resource)) {
      uiTools.push(name);
    } else if (resource !== undefined) {
      errors.push(`MCP snapshot: ${name} has an invalid UI resource reference`);
    }
    if ((RENDER_TOOLS as readonly string[]).includes(name) && resource !== EXPECTED_PACK_VIEWER_URI) {
      errors.push(`MCP snapshot: ${name} must use the current Phase 22 viewer URI`);
    }
    if (ui.resourceUri !== undefined && meta["openai/outputTemplate"] !== undefined && ui.resourceUri !== meta["openai/outputTemplate"]) {
      errors.push(`MCP snapshot: ${name} has conflicting UI resource references`);
    }
  }
  for (const name of Object.keys(TOOL_ANNOTATION_REVIEW)) {
    if (!seen.has(name)) errors.push(`MCP snapshot: missing tool ${name}`);
  }
  for (const name of RENDER_TOOLS) {
    if (!uiTools.includes(name)) errors.push(`MCP snapshot: ${name} must expose the Phase 22 pack viewer`);
  }
  if (uiTools.includes("get_pack")) {
    errors.push("MCP snapshot: get_pack must stay data-only for viewer polling");
  }
  return { errors, uiTools };
}

export function checkToolsFile(path: string): ToolSnapshotCheck {
  let fd: number | undefined;
  try {
    if (extname(path).toLowerCase() !== ".json") {
      return { errors: ["MCP snapshot: must be an explicitly supplied .json descriptor file"], uiTools: [] };
    }
    // A FIFO named .json must not block before the regular-file check.
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_TOOLS_SNAPSHOT_BYTES) {
      return { errors: ["MCP snapshot: must be a regular JSON file no larger than 2 MiB"], uiTools: [] };
    }
    const bytes = Buffer.alloc(MAX_TOOLS_SNAPSHOT_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null);
      if (count === 0) break;
      length += count;
    }
    if (length > MAX_TOOLS_SNAPSHOT_BYTES) {
      return { errors: ["MCP snapshot: must be no larger than 2 MiB"], uiTools: [] };
    }
    return checkToolSnapshot(JSON.parse(bytes.toString("utf8", 0, length)) as unknown);
  } catch {
    // Never echo snapshot contents, parser excerpts or arbitrary paths.
    return { errors: ["MCP snapshot: cannot read a valid JSON tools/list file"], uiTools: [] };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** No local metadata check can resolve these external launch gates. */
export const EXTERNAL_SUBMISSION_CHECKS = [
  "Confirm the publisher against the verified OpenAI identity, owning project and submission permission.",
  "Verify live policy/support/sample URLs, accurate legal facts and an accessible real-client recording.",
  "Complete authorized OAuth containment and actual ChatGPT asset/download acceptance on supported surfaces.",
  "Verify the production domain and current tools/UI scan in the OpenAI portal.",
  "Provide working approved reviewer access privately and accept the actual required attestations.",
  "Record submission, approval and publication separately from actual portal evidence.",
] as const;
