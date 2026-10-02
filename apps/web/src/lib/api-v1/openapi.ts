/**
 * The OpenAPI 3.1 document for the public API v1, served at
 * /api/v1/openapi.json (PHASE_16 workstream 5). The schemas are generated
 * from the zod schemas the routes parse with (./schemas), and the contract
 * tests call every operation listed here and check each answer against
 * them, so the document describes what the server does. A typed client
 * (the SDK, later) is generated from this document.
 */

import { z } from "zod";
import type { ApiScope } from "@/lib/api-keys/format";
import { SCOPE_LABELS } from "@/lib/api-keys/format";
import { COMPONENT_SCHEMAS } from "./schemas";

export const API_VERSION = "1.0.0";

type ComponentName = keyof typeof COMPONENT_SCHEMAS;

export interface ApiOperation {
  operationId: string;
  method: "get" | "post";
  path: string;
  summary: string;
  scope: ApiScope | null;
  request?: ComponentName;
  success: { status: number; schema: ComponentName; description: string }[];
  errors: number[];
  idempotent?: boolean;
}

/** Every v1 operation. The contract tests hold the route files to it. */
export const API_OPERATIONS: readonly ApiOperation[] = [
  {
    operationId: "createPack",
    method: "post",
    path: "/api/v1/packs",
    summary: "Start a pack from real product photos. Holds credits like the web form.",
    scope: "packs:write",
    request: "CreatePackRequest",
    success: [
      { status: 201, schema: "PackResponse", description: "The pack was started." },
      { status: 200, schema: "PackResponse", description: "A retry with the same Idempotency-Key and body: the same pack." },
    ],
    errors: [400, 401, 402, 403, 404, 409, 413, 422, 429, 502, 503, 504],
    idempotent: true,
  },
  {
    operationId: "getPack",
    method: "get",
    path: "/api/v1/packs/{id}",
    summary: "Read a pack's status and per shot results.",
    scope: "packs:read",
    success: [{ status: 200, schema: "PackResponse", description: "The pack." }],
    errors: [401, 403, 404, 503],
  },
  {
    operationId: "listPackFiles",
    method: "get",
    path: "/api/v1/packs/{id}/files",
    summary: "List a pack's delivered files with download links signed for 15 minutes.",
    scope: "packs:read",
    success: [{ status: 200, schema: "PackFilesResponse", description: "The files." }],
    errors: [401, 403, 404, 503],
  },
  {
    operationId: "checkMainImage",
    method: "post",
    path: "/api/v1/checks/main-image",
    summary: "Check a marketplace main image against its verified size, background and fill rules. Uses no credits.",
    scope: "checks",
    request: "MainImageCheckRequest",
    success: [{ status: 200, schema: "MainImageCheckResponse", description: "The measured checks." }],
    errors: [400, 401, 403, 413, 422, 429, 502, 503, 504],
  },
  {
    operationId: "listChannels",
    method: "get",
    path: "/api/v1/channels",
    summary: "List the channel specs and bundles a pack can name, with availability on your plan.",
    scope: null,
    success: [{ status: 200, schema: "ChannelsResponse", description: "The channels." }],
    errors: [401, 403, 503],
  },
  {
    operationId: "getSmokeContext",
    method: "get",
    path: "/api/v1/smoke-context",
    summary: "Verify that the key's own operator workspace is excluded from customer metrics before an authorized synthetic run.",
    scope: "packs:read",
    success: [{ status: 200, schema: "SmokeContextResponse", description: "Verified operator workspace; no pack or credit mutation." }],
    errors: [401, 403, 503],
  },
];

const REQUEST_COMPONENTS = new Set<ComponentName>(["CreatePackRequest", "MainImageCheckRequest"]);

/** A component's JSON Schema: request bodies as sent (before defaults),
 * responses as returned. */
export function componentSchema(name: ComponentName): Record<string, unknown> {
  const schema = z.toJSONSchema(COMPONENT_SCHEMAS[name], {
    io: REQUEST_COMPONENTS.has(name) ? "input" : "output",
    unrepresentable: "any",
    target: "draft-2020-12",
  }) as Record<string, unknown>;
  const { $schema: _dialect, ...rest } = schema;
  return rest;
}

const ERROR_DESCRIPTIONS: Record<number, string> = {
  400: "The request is not valid.",
  401: "The API key is missing, not valid or revoked.",
  402: "Not enough credits, or the plan does not include what was asked.",
  403: "The plan has no API access, the key lacks the scope, or the key's member may not do this.",
  404: "Not found in this workspace.",
  409: "The Idempotency-Key was used with a different request.",
  413: "The request body is too large. Send large photos by link.",
  422: "A photo or option could not be used.",
  429: "Too many requests. Wait for Retry-After seconds.",
  502: "A photo link could not be downloaded.",
  503: "Unavailable for a moment. Retry after Retry-After seconds.",
  504: "A photo link took too long.",
};

function ref(name: ComponentName): { $ref: string } {
  return { $ref: `#/components/schemas/${name}` };
}

export function buildOpenApiDocument(serverUrl?: string): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const op of API_OPERATIONS) {
    const responses: Record<string, unknown> = {};
    for (const success of op.success) {
      responses[String(success.status)] = {
        description: success.description,
        content: { "application/json": { schema: ref(success.schema) } },
      };
    }
    for (const status of op.errors) {
      responses[String(status)] = {
        description: ERROR_DESCRIPTIONS[status] ?? "Error.",
        content: { "application/json": { schema: ref("Error") } },
      };
    }
    const parameters: unknown[] = [];
    if (op.path.includes("{id}")) {
      parameters.push({ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } });
    }
    if (op.idempotent) {
      parameters.push({
        name: "Idempotency-Key",
        in: "header",
        required: true,
        description: "A fresh value for each new pack, the same value when you retry. At most 200 characters.",
        schema: { type: "string", minLength: 1, maxLength: 200 },
      });
    }
    paths[op.path] ??= {};
    paths[op.path]![op.method] = {
      operationId: op.operationId,
      summary: op.summary,
      ...(op.scope ? { "x-curvi-scope": op.scope, description: `Needs a key with the ${op.scope} scope: ${SCOPE_LABELS[op.scope]}.` } : {}),
      ...(parameters.length > 0 ? { parameters } : {}),
      ...(op.request
        ? { requestBody: { required: true, content: { "application/json": { schema: ref(op.request) } } } }
        : {}),
      responses,
    };
  }

  const schemas: Record<string, unknown> = {};
  for (const name of Object.keys(COMPONENT_SCHEMAS) as ComponentName[]) {
    schemas[name] = componentSchema(name);
  }

  return {
    openapi: "3.1.0",
    info: {
      title: "Curvi API",
      version: API_VERSION,
      description:
        "Make marketplace ready product image packs from real photos. The product is never redrawn. Authenticate with a workspace API key from Settings, API keys (Growth plan and above) sent as Authorization: Bearer <key>. The same key works with the MCP server at /api/mcp.",
    },
    ...(serverUrl ? { servers: [{ url: serverUrl }] } : {}),
    security: [{ bearerAuth: [] }],
    paths,
    components: {
      securitySchemes: { bearerAuth: { type: "http", scheme: "bearer", description: "A Curvi workspace API key." } },
      schemas,
    },
  };
}
