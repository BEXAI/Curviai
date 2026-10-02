/**
 * The hosted MCP server's tools (PHASE_16 workstream 5, PHASE_19 P19-13 to
 * P19-18): definitions, the tools/list descriptors and the tools/call
 * results. The tools run the same actions as the public API v1 (./actions)
 * and answer with the chat views (./chat-views), never the REST bodies. The
 * transport, discovery and authentication live in ./mcp; PHASE_19 P19-02
 * split them apart so the sign in work (mcp.ts, p19/auth) and the tool work
 * (this file, p19/tools) touch different files.
 *
 * Every descriptor carries what OpenAI's plugin reference and review ask for
 * (docs/verification.md, "PHASE_19: ChatGPT and Codex plugin", O2, O4, O6):
 * readOnlyHint, destructiveHint and openWorldHint set on every tool, the
 * OAuth security scheme and its _meta mirror, an outputSchema generated from
 * the chat view, status text and the MCP Apps visibility. The descriptions
 * and the server instructions are API documentation for outside models, kept
 * here and pinned by tests (founder decision 17); every enumerated value an
 * assistant may send comes from the registry and the seed, through the
 * schemas and list_channels.
 */

import { z } from "zod";
import type { ApiCaller } from "@/lib/api-keys/auth";
import type { ApiScope } from "@/lib/api-keys/format";
import { mcpOAuthEnabled } from "@/lib/mcp-auth/config";
import { GET_PROFILE_LISTED, getProfile } from "@/lib/mcp-auth/profile";
import { MCP_LINK_TTL_SECONDS, linkSigningKeys, packFileLinks } from "@/lib/mcp-links";
import type { SigningKey } from "@/lib/mcp-signing";
import { PACK_VIEWER_TEMPLATE } from "@/lib/mcp-ui/pack-viewer/resource";
import { DOWNLOAD_URL_TTL_SECONDS } from "@/lib/r2";
import type { JobFileView } from "@/lib/services/types";
import {
  checkMainImage,
  createPack,
  errorResult,
  estimatePack,
  getPack,
  listChannels,
  type ApiContext,
  type ApiResult,
} from "./actions";
import {
  ChannelsChat,
  EstimateChat,
  MainImageCheckChat,
  PackChat,
  ProfileChat,
  channelsChatOf,
  packChatOf,
  packImagesOf,
  type PackFileLinks,
} from "./chat-views";
import { MCP_COPY, mcpCopyProblems } from "./mcp-copy";
import { logMcpEvent } from "./mcp-log";
import {
  CHAT_FILES_WIRED,
  CreatePackRequest,
  CreatePackRequestNoFiles,
  MainImageCheckRequest,
  MainImageCheckRequestNoFiles,
  type ChannelsResponse,
  type MainImageCheckResponse,
  type Pack,
} from "./schemas";

/**
 * The server instructions (PHASE_19 "Tools"): the whole flow inside the first
 * 512 characters (O7), and never a request to call get_pack in a loop.
 */
export const MCP_INSTRUCTIONS =
  "Curvi turns a real product photo into marketplace and ad images. It never redraws the product; it changes only the background, size and surroundings. It does not draw new images or write listing text. " +
  "To make images, pick channels and a background (list_channels), call estimate_pack with the photo and tell the user the credits, then call create_pack with its quote and max_credits. " +
  "A pack takes a few minutes; call get_pack when the user asks. check_main_image checks main images and uses no credits.";

/** Every tool asks for the same sign in: Curvi's OAuth with the two OIDC
 * scopes it uses (decision 2; Supabase offers no custom scopes, SB4). */
export const SECURITY_SCHEMES = [{ type: "oauth2", scopes: ["openid", "email"] }] as const;

/**
 * The caching hints MCP 2026-07-28 requires on tools/list, the resources
 * methods and server/discover (CacheableResult, M2; docs/verification.md).
 * The tool list is the same for every caller, so it may be shared, and a
 * deploy that changes it reaches clients within five minutes.
 */
export const MCP_LIST_CACHE = { ttlMs: 300_000, cacheScope: "public" } as const;

/** The four hints, all required by OpenAI's review (annotations_required). */
export interface ToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  openWorldHint: boolean;
  idempotentHint: boolean;
}

export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  scope: ApiScope | null;
  /** The arguments tools/call parses, with chat attachments when they are
   * wired (CHAT_FILES_WIRED). */
  args: z.ZodType;
  /** The arguments without the chat attachment fields. */
  argsNoFiles: z.ZodType;
  /** The chat view a success result carries; its JSON Schema is the
   * descriptor's outputSchema. */
  output: z.ZodType;
  annotations: ToolAnnotations;
  /** ChatGPT's status text while the tool runs and after (at most 64
   * characters each, O2), or null for none. */
  status: { invoking: string; invoked: string } | null;
  /** Who may call the tool: the model, the pack viewer app, or both (M5;
   * the host refuses an app's call to a tool without "app"). */
  visibility: ReadonlyArray<"model" | "app">;
  /** The MCP Apps UI that renders the result (`_meta.ui.resourceUri`, M5):
   * the pack viewer, on create_pack only (P19-19; O11: only the render tool
   * names the template, so the viewer is not drawn again on every call). */
  resourceUri?: string;
  /** Top level arguments that carry chat attachments (O2 openai/fileParams). */
  fileParams?: readonly string[];
  /** The tool is the profile tool (O1 openai/profile). */
  profile?: true;
  /** args is the parsed arguments; raw is what the client sent, for tools
   * whose action parses again and must not see the schema's defaults. */
  run: (ctx: ApiContext, args: never, raw: Record<string, unknown>) => Promise<ApiResult>;
}

/** create_pack's own arguments beside the pack request (P19-16). */
const PACK_GUARD_FIELDS = {
  quote: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe("The quote estimate_pack returned for these same photos and choices."),
  max_credits: z
    .number()
    .int()
    .min(0)
    .max(1_000_000)
    .optional()
    .describe("The most credits this pack may hold: the credits_needed estimate_pack returned. A pack that needs more is not started."),
  idempotency_key: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe("Leave this out. A repeat of the same photos and choices within 10 minutes returns the same pack without holding credits again."),
};

const CreatePackArgs = z.object({ ...CreatePackRequest.shape, ...PACK_GUARD_FIELDS }).strict();
const CreatePackArgsNoFiles = z.object({ ...CreatePackRequestNoFiles.shape, ...PACK_GUARD_FIELDS }).strict();
type CreatePackArgs = z.infer<typeof CreatePackArgs>;

const GetPackArgs = z
  .object({
    pack_id: z.string().describe("The pack_id create_pack returned."),
    include_files: z
      .boolean()
      .optional()
      .describe("Also list the files before the pack is finished. A finished pack always lists them."),
  })
  .strict();

const ListChannelsArgs = z.object({}).strict();

const GetProfileArgs = z.object({}).strict();

function jsonSchemaOf(schema: z.ZodType, io: "input" | "output"): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { io, unrepresentable: "any", target: "draft-2020-12" }) as Record<string, unknown>;
  const { $schema: _dialect, ...rest } = json;
  return rest;
}

/**
 * Preview and download links for a pack's delivered files. get_pack hands out
 * P19-17's lasting curvi.ai links (decision 7, LASTING_PACK_LINKS);
 * SHORT_LIVED_PACK_LINKS is the REST API's short lived download links with no
 * previews, the fallback packLinksFor picks.
 */
export interface PackLinkProvider {
  /** How long the links work, in minutes. */
  validMinutes: number;
  /** Links by file id; a file missing from the map gets none. */
  links(ctx: ApiContext, packId: string, files: readonly JobFileView[]): Promise<Map<string, PackFileLinks>>;
}

/** Today's links: the download link the REST API signs for each stored file
 * (DOWNLOAD_URL_TTL_SECONDS), no previews. */
export const SHORT_LIVED_PACK_LINKS: PackLinkProvider = {
  validMinutes: Math.round(DOWNLOAD_URL_TTL_SECONDS / 60),
  async links(ctx, packId, files) {
    const workspaceId = ctx.caller.principal.workspaceId;
    const entries = await Promise.all(
      files.map(async (file) => {
        const download = file.downloadUrl
          ? await ctx.caller.services.getJobFileDownload(workspaceId, packId, file.id)
          : null;
        return [file.id, { preview_url: null, download_url: download?.url ?? null }] as const;
      }),
    );
    return new Map(entries);
  },
};

/** The lasting curvi.ai links (P19-17, decision 7): signed with
 * MCP_LINK_KEYS for MCP_LINK_TTL_SECONDS, tied to the caller's connection or
 * key and checked again on every click (lib/mcp-links.ts). A file gets none
 * while the keys are unset or the caller has no connection or key. */
export const LASTING_PACK_LINKS: PackLinkProvider = {
  validMinutes: MCP_LINK_TTL_SECONDS / 60,
  async links(ctx, packId, files) {
    return packFileLinks(ctx.caller, packId, files, ctx.now ? { now: ctx.now } : {});
  },
};

/**
 * The links get_pack hands this caller. The lasting links need MCP_LINK_KEYS;
 * while it is unset or malformed every caller gets the short lived links
 * instead, so a missing key never takes download links away. With
 * MCP_OAUTH_ENABLED off (the rollback), an API key caller gets exactly the
 * links it got before PHASE_19, the short lived ones.
 */
export function packLinksFor(
  caller: Pick<ApiCaller, "kind">,
  options: { keys?: readonly SigningKey[] | null; oauthEnabled?: boolean } = {},
): PackLinkProvider {
  const keys = options.keys === undefined ? linkSigningKeys() : options.keys;
  if (!keys || keys.length === 0) {
    return SHORT_LIVED_PACK_LINKS;
  }
  if (caller.kind !== "oauth" && !(options.oauthEnabled ?? mcpOAuthEnabled())) {
    return SHORT_LIVED_PACK_LINKS;
  }
  return LASTING_PACK_LINKS;
}

/** A success result carrying a chat view, parsed against it so the
 * structured content always matches the declared outputSchema (M4 MUST). A
 * view that does not parse is logged and answered as an error, never sent. */
function viewResult(tool: string, view: z.ZodType, body: unknown, summary?: string): ApiResult {
  const parsed = view.safeParse(body);
  if (!parsed.success) {
    logMcpEvent("tool_error", { reason: "view_invalid", tool }, { level: "error" });
    return errorResult(500, "unavailable", MCP_COPY.unavailable);
  }
  return { status: 200, body: parsed.data, ...(summary ? { summary } : {}) };
}

/** get_pack: the pack, and its files with links once it is finished (or
 * when asked). */
async function packView(ctx: ApiContext, packId: string, includeFiles: boolean): Promise<ApiResult> {
  const got = await getPack(ctx, packId);
  if (got.status !== 200) {
    return got;
  }
  const pack = (got.body as { pack: Pack }).pack;
  const packLinks = packLinksFor(ctx.caller);
  let images: ReturnType<typeof packImagesOf> | undefined;
  if (pack.finished || includeFiles) {
    const view = await ctx.caller.services.listJobFiles(ctx.caller.principal.workspaceId, pack.id);
    if (view) {
      images = packImagesOf(view.files, pack.shots, await packLinks.links(ctx, pack.id, view.files));
    }
  }
  const chat = packChatOf(pack, { ...(images ? { images } : {}), linksValidMinutes: packLinks.validMinutes });
  return viewResult("get_pack", PackChat, chat, chat.message);
}

/** get_profile (PHASE_19 P19-11): the account and workspace behind an OAuth
 * connection. p19/auth fills lib/mcp-auth/profile.ts and lists it there. */
export const GET_PROFILE_TOOL: ToolDefinition = {
  name: "get_profile",
  title: "Get your Curvi account",
  description: "Returns the Curvi account and workspace this connection uses.",
  scope: null,
  args: GetProfileArgs,
  argsNoFiles: GetProfileArgs,
  output: ProfileChat,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  status: null,
  visibility: ["model"],
  profile: true,
  run: async (ctx) => {
    // The profile goes through its view like every result, so it always
    // matches the declared outputSchema (O1 also asks for the JSON text
    // block, which toolResult adds).
    const result = await getProfile(ctx);
    return result.status < 400 ? viewResult("get_profile", ProfileChat, result.body) : result;
  },
};

/** The tools in their fixed tools/list order (M4: deterministic). */
const CORE_TOOLS: readonly ToolDefinition[] = [
  {
    name: "list_channels",
    title: "List channels",
    description:
      "Use this when the user asks which marketplaces, ad placements, sizes, backgrounds or scene styles Curvi can make. Lists what create_pack accepts and what this workspace's plan includes. Uses no credits.",
    scope: null,
    args: ListChannelsArgs,
    argsNoFiles: ListChannelsArgs,
    output: ChannelsChat,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
    status: { invoking: "Reading channels", invoked: "Channels ready" },
    visibility: ["model"],
    run: async (ctx) => {
      const rest = listChannels(ctx);
      // With the output options switch off, create_pack refuses background
      // and scene choices, so list_channels does not offer them.
      const optionsOn = await ctx.caller.services.outputOptionsEnabled();
      return viewResult(
        "list_channels",
        ChannelsChat,
        channelsChatOf(rest.body as z.infer<typeof ChannelsResponse>, { optionsOn }),
      );
    },
  },
  {
    name: "estimate_pack",
    title: "Estimate a pack",
    description:
      "Use this before create_pack, with the same photos and choices, to find out how many credits the pack will use and how many the workspace has. Tell the user both numbers, then pass the quote it returns to create_pack. Uses no credits and stores nothing.",
    scope: "packs:write",
    args: CHAT_FILES_WIRED ? CreatePackRequest : CreatePackRequestNoFiles,
    argsNoFiles: CreatePackRequestNoFiles,
    output: EstimateChat,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true, idempotentHint: true },
    status: { invoking: "Counting credits", invoked: "Credits counted" },
    visibility: ["model"],
    fileParams: ["images"],
    run: async (ctx, _args, raw) => {
      // estimatePack parses the body itself, as createPack does.
      const result = await estimatePack(ctx, raw);
      return result.status === 200 ? viewResult("estimate_pack", EstimateChat, result.body, result.summary) : result;
    },
  },
  {
    name: "create_pack",
    title: "Create a pack",
    description:
      "Use this when the user wants listing or ad images made from a real product photo. Curvi cuts the product out and changes only the background, size and surroundings; it never redraws the product. Do not use it to draw or invent new images or to write listing text. This spends credits from the connected workspace, so call estimate_pack first with the same photos and choices, tell the user the number, and pass its quote and max_credits. A repeat call with the same photos and choices within 10 minutes returns the same pack without spending again. Returns at once; the pack takes a few minutes, so call get_pack when the user asks.",
    scope: "packs:write",
    args: CHAT_FILES_WIRED ? CreatePackArgs : CreatePackArgsNoFiles,
    argsNoFiles: CreatePackArgsNoFiles,
    output: PackChat,
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true, idempotentHint: false },
    status: { invoking: "Starting your pack", invoked: "Pack started" },
    visibility: ["model"],
    ...(PACK_VIEWER_TEMPLATE ? { resourceUri: PACK_VIEWER_TEMPLATE } : {}),
    fileParams: ["images"],
    run: async (ctx, args: CreatePackArgs, raw) => {
      // createPack parses the body itself: pass it as sent, so the output
      // options' defaults do not clash with the bundle or look shortcuts.
      const { idempotency_key: _key, quote: _quote, max_credits: _max, ...body } = raw;
      // An OAuth caller's key is always derived on the server, so a key
      // written by the model cannot defeat replay; an API key caller's own
      // key is honored (P19-16).
      const oauth = ctx.caller.kind === "oauth";
      const result = await createPack(ctx, body, oauth ? null : (args.idempotency_key ?? null), {
        ...(args.quote !== undefined ? { quote: args.quote } : {}),
        ...(args.max_credits !== undefined ? { maxCredits: args.max_credits } : {}),
        quoteRequired: oauth,
      });
      if (result.status >= 400) {
        return result;
      }
      const sent = result.body as { pack: Pack; replayed?: boolean };
      const chat = packChatOf(sent.pack, sent.replayed ? { replayed: true } : { created: true });
      return viewResult("create_pack", PackChat, chat, chat.message);
    },
  },
  {
    name: "get_pack",
    title: "Get a pack",
    description:
      "Use this to see how a pack is going and to get its finished images. Returns each image's status and channel check, with preview and download links that work for 24 hours. Uses no credits.",
    scope: "packs:read",
    args: GetPackArgs,
    argsNoFiles: GetPackArgs,
    output: PackChat,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
    status: { invoking: "Checking your pack", invoked: "Pack checked" },
    // The pack viewer polls get_pack, and only get_pack (decision 6, M5).
    visibility: ["model", "app"],
    run: async (ctx, args: z.infer<typeof GetPackArgs>) => packView(ctx, args.pack_id, args.include_files === true),
  },
  {
    name: "check_main_image",
    title: "Check a marketplace main image",
    description:
      "Use this when the user wants a marketplace main image checked. Set channel to one of the verified choices in the schema; Amazon is the default. Checks the channel's size, background and product fill rules where defined. Uses no credits and stores nothing. Do not use it to edit the photo, to draw new images or to write listing text.",
    scope: "checks",
    args: CHAT_FILES_WIRED ? MainImageCheckRequest : MainImageCheckRequestNoFiles,
    argsNoFiles: MainImageCheckRequestNoFiles,
    output: MainImageCheckChat,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true, idempotentHint: true },
    status: { invoking: "Checking the main image", invoked: "Main image checked" },
    visibility: ["model"],
    fileParams: ["image"],
    run: async (ctx, args: z.infer<typeof MainImageCheckRequestNoFiles>) => {
      const result = await checkMainImage(ctx, args, { audience: "assistant" });
      if (result.status >= 400) {
        return result;
      }
      const body = result.body as z.infer<typeof MainImageCheckResponse>;
      return viewResult("check_main_image", MainImageCheckChat, body, body.summary);
    },
  },
];

/** The tools tools/list offers and tools/call runs, in a fixed order. */
export const MCP_TOOLS: readonly ToolDefinition[] = [...CORE_TOOLS, ...(GET_PROFILE_LISTED ? [GET_PROFILE_TOOL] : [])];

/** Tools offered to OAuth callers only (mcp.ts): an API key client sees the
 * list it saw before PHASE_19. */
export const OAUTH_ONLY_TOOL_NAMES: ReadonlySet<string> = new Set([GET_PROFILE_TOOL.name]);

/** The tools an API key client of the MCP server can call, in order. */
export const API_KEY_MCP_TOOLS: readonly ToolDefinition[] = MCP_TOOLS.filter((tool) => !OAUTH_ONLY_TOOL_NAMES.has(tool.name));

/** The tool of a tools/call, or undefined for a name the server does not offer. */
export function findTool(name: unknown): ToolDefinition | undefined {
  return MCP_TOOLS.find((tool) => tool.name === name);
}

/**
 * One tools/list entry. chatFiles (CHAT_FILES_WIRED by default) adds the
 * attachment fields to inputSchema and names them in openai/fileParams; a
 * test passes true to check the wired shape before P19-15 turns it on.
 */
export function toolDescriptor(
  tool: ToolDefinition,
  options: { chatFiles?: boolean } = {},
): Record<string, unknown> {
  const chatFiles = options.chatFiles ?? CHAT_FILES_WIRED;
  const fileParams = chatFiles && tool.fileParams ? tool.fileParams : [];
  const args = fileParams.length > 0 ? fileArgsOf(tool) : tool.argsNoFiles;
  return {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: jsonSchemaOf(args, "input"),
    outputSchema: jsonSchemaOf(tool.output, "output"),
    annotations: { ...tool.annotations },
    securitySchemes: SECURITY_SCHEMES,
    _meta: {
      securitySchemes: SECURITY_SCHEMES,
      ui: { visibility: [...tool.visibility], ...(tool.resourceUri ? { resourceUri: tool.resourceUri } : {}) },
      ...(tool.status
        ? {
            "openai/toolInvocation/invoking": tool.status.invoking,
            "openai/toolInvocation/invoked": tool.status.invoked,
          }
        : {}),
      ...(fileParams.length > 0 ? { "openai/fileParams": [...fileParams] } : {}),
      ...(tool.profile ? { "openai/profile": true } : {}),
    },
  };
}

/** The arguments with the chat attachment fields, for a tool that has them. */
function fileArgsOf(tool: ToolDefinition): z.ZodType {
  switch (tool.name) {
    case "create_pack":
      return CreatePackArgs;
    case "estimate_pack":
      return CreatePackRequest;
    case "check_main_image":
      return MainImageCheckRequest;
    default:
      return tool.args;
  }
}

export function toolList(options: { chatFiles?: boolean } = {}): Array<Record<string, unknown>> {
  return MCP_TOOLS.map((tool) => toolDescriptor(tool, options));
}

/**
 * A descriptor without the base64 `data` photo fields, for OAuth callers:
 * their requests keep the small body cap (mcp.ts, MCP_UNKEYED_BODY_MAX_BYTES)
 * because ChatGPT sends photos as attachments or links, so a photo sent as
 * base64 could only fail as an oversized request. The arguments still parse
 * the same way; only the advertisement changes.
 */
export function withoutInlinePhotoBytes(descriptor: Record<string, unknown>): Record<string, unknown> {
  const input = structuredClone(descriptor.inputSchema) as { properties?: Record<string, unknown> } | undefined;
  const properties = input?.properties;
  if (!properties) {
    return descriptor;
  }
  delete properties.data;
  const photos = properties.photos as { items?: { properties?: Record<string, unknown> } } | undefined;
  if (photos?.items?.properties) {
    delete photos.items.properties.data;
  }
  return { ...descriptor, inputSchema: input };
}

/** Refusal reasons whose REST text must not reach an assistant, when the
 * action did not give the line itself (the authentication refusals mcp.ts
 * passes through here, and the replay conflict). */
const REASON_COPY: Readonly<Record<string, string>> = {
  // A key whose plan has no API access (checkApiAccess); never a plan name.
  upgrade_required: MCP_COPY.apiKeysNotInPlan,
  insufficient_scope: MCP_COPY.insufficientScope,
  idempotency_conflict: MCP_COPY.idempotencyConflict,
  role_forbidden: MCP_COPY.clientSeat,
};

/**
 * The text of a refusal: the action's assistant line, else the line for its
 * reason, else the REST text with its issues. The last guard: a line that
 * would still promote a plan or ask for a key is replaced with a neutral one
 * and logged, so no such string ever reaches an assistant.
 */
export function assistantErrorText(result: ApiResult, tool?: string): string {
  const body = (result.body ?? {}) as { error?: unknown; reason?: unknown; issues?: unknown };
  const reason = typeof body.reason === "string" ? body.reason : undefined;
  let text = result.assistantMessage ?? (reason ? REASON_COPY[reason] : undefined);
  if (text === undefined) {
    const message = typeof body.error === "string" ? body.error : MCP_COPY.unavailable;
    const issues = Array.isArray(body.issues) ? ` ${(body.issues as string[]).join(" ")}` : "";
    text = `${message}${issues}`;
  }
  if (mcpCopyProblems(text).length > 0) {
    logMcpEvent("tool_error", { reason: "copy_guard", ...(tool ? { tool } : {}) }, { level: "error" });
    return MCP_COPY.unavailable;
  }
  return text;
}

/**
 * A tools/call result. Success: the chat view as structuredContent, the same
 * object serialized as the first text block (M4, R36), and the plain
 * sentence as a second block when there is one. Refusal: isError and text
 * only, never structuredContent, so a refusal can never break the
 * outputSchema.
 */
export function toolResult(result: ApiResult): Record<string, unknown> {
  if (result.status < 400) {
    const body = result.body as Record<string, unknown>;
    const content: Array<{ type: "text"; text: string }> = [{ type: "text", text: JSON.stringify(body) }];
    if (result.summary && mcpCopyProblems(result.summary).length === 0) {
      content.push({ type: "text", text: result.summary });
    }
    return { content, structuredContent: body, isError: false };
  }
  return { content: [{ type: "text", text: assistantErrorText(result) }], isError: true };
}
