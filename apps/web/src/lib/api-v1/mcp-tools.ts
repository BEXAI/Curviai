/**
 * The hosted MCP server's tools (PHASE_16 workstream 5): definitions, the
 * tools/list descriptors and the tools/call results. create_pack, get_pack,
 * check_main_image and list_channels run the same actions as the public API
 * v1 (./actions). The transport, discovery and authentication live in
 * ./mcp; PHASE_19 P19-02 split them apart so the sign in work (mcp.ts,
 * p19/auth) and the tool work (this file, p19/tools) touch different files.
 */

import { z } from "zod";
import type { ApiScope } from "@/lib/api-keys/format";
import { GET_PROFILE_LISTED, getProfile } from "@/lib/mcp-auth/profile";
import { checkMainImage, createPack, getPack, listChannels, listPackFiles, type ApiContext, type ApiResult } from "./actions";
import { CreatePackRequestNoFiles, MainImageCheckRequestNoFiles } from "./schemas";

export const MCP_INSTRUCTIONS =
  "Curvi makes marketplace ready product image packs from real product photos and never redraws the product. " +
  "Call list_channels to see the channels and bundles. Call create_pack with photo links, channels and a fresh idempotency_key; it holds credits. " +
  "Then call get_pack until finished is true, with include_files to get download links that work for 15 minutes. " +
  "check_main_image checks an Amazon main image for free.";

const CreatePackArgs = z
  .object({
    ...CreatePackRequestNoFiles.shape,
    idempotency_key: z
      .string()
      .min(1)
      .max(200)
      .describe("A fresh value for each new pack; send the same value again only to retry the same request."),
  })
  .strict();

const GetPackArgs = z
  .object({
    pack_id: z.string().describe("The pack id create_pack returned."),
    include_files: z
      .boolean()
      .optional()
      .describe("Also list the delivered files with download links signed for 15 minutes."),
  })
  .strict();

const ListChannelsArgs = z.object({}).strict();

const GetProfileArgs = z.object({}).strict();

export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  scope: ApiScope | null;
  args: z.ZodType;
  annotations: Record<string, boolean>;
  /** args is the parsed arguments; raw is what the client sent, for tools
   * whose action parses again and must not see the schema's defaults. */
  run: (ctx: ApiContext, args: never, raw: Record<string, unknown>) => Promise<ApiResult>;
}

function inputSchemaOf(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { io: "input", unrepresentable: "any", target: "draft-2020-12" }) as Record<
    string,
    unknown
  >;
  const { $schema: _dialect, ...rest } = json;
  return rest;
}

/** get_profile (PHASE_19 P19-11): the account and workspace behind an OAuth
 * connection. p19/auth fills lib/mcp-auth/profile.ts and lists it there. */
export const GET_PROFILE_TOOL: ToolDefinition = {
  name: "get_profile",
  title: "Get your Curvi account",
  description: "Returns the Curvi account and workspace this connection uses.",
  scope: null,
  args: GetProfileArgs,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  run: async (ctx) => getProfile(ctx),
};

const CORE_TOOLS: readonly ToolDefinition[] = [
  {
    name: "create_pack",
    title: "Create a pack",
    description:
      "Start a Curvi pack from real product photos for the chosen channels. Holds credits like the web form. Returns the pack; poll get_pack until finished.",
    scope: "packs:write",
    args: CreatePackArgs,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    run: async (ctx, args: z.infer<typeof CreatePackArgs>, raw) => {
      // createPack parses the body itself: pass it as sent, so the output
      // options' defaults do not clash with the bundle or look shortcuts.
      const { idempotency_key: _key, ...body } = raw;
      return createPack(ctx, body, args.idempotency_key);
    },
  },
  {
    name: "get_pack",
    title: "Get a pack",
    description: "Read a pack's status and per shot results, and optionally its files with short lived download links.",
    scope: "packs:read",
    args: GetPackArgs,
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: async (ctx, args: z.infer<typeof GetPackArgs>) => {
      const pack = await getPack(ctx, args.pack_id);
      if (pack.status !== 200 || !args.include_files) {
        return pack;
      }
      const files = await listPackFiles(ctx, args.pack_id);
      if (files.status !== 200) {
        return files;
      }
      const filesBody = files.body as { files: unknown[]; notice?: string };
      return {
        status: 200,
        body: {
          ...(pack.body as Record<string, unknown>),
          files: filesBody.files,
          ...(filesBody.notice ? { filesNotice: filesBody.notice } : {}),
        },
      };
    },
  },
  {
    name: "check_main_image",
    title: "Check an Amazon main image",
    description:
      "Check an Amazon main image against the real rules: longest side, pure white edges and product fill. Free, uses no credits.",
    scope: "checks",
    args: MainImageCheckRequestNoFiles,
    annotations: { readOnlyHint: true, openWorldHint: true },
    run: async (ctx, args: z.infer<typeof MainImageCheckRequestNoFiles>) => checkMainImage(ctx, args),
  },
  {
    name: "list_channels",
    title: "List channels",
    description: "List the channel specs and pack bundles create_pack accepts, with availability on this workspace's plan.",
    scope: null,
    args: ListChannelsArgs,
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: async (ctx) => listChannels(ctx),
  },
];

/** The tools tools/list offers and tools/call runs, in a fixed order. */
export const MCP_TOOLS: readonly ToolDefinition[] = [...CORE_TOOLS, ...(GET_PROFILE_LISTED ? [GET_PROFILE_TOOL] : [])];

/** The tool of a tools/call, or undefined for a name the server does not offer. */
export function findTool(name: unknown): ToolDefinition | undefined {
  return MCP_TOOLS.find((tool) => tool.name === name);
}

export function toolList(): Array<Record<string, unknown>> {
  return MCP_TOOLS.map((tool) => ({
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: inputSchemaOf(tool.args),
    annotations: tool.annotations,
  }));
}

export function toolResult(result: ApiResult): Record<string, unknown> {
  const body = result.body as Record<string, unknown>;
  if (result.status < 400) {
    return { content: [{ type: "text", text: JSON.stringify(body) }], structuredContent: body, isError: false };
  }
  const message = typeof body?.error === "string" ? body.error : "The call failed.";
  const issues = Array.isArray(body?.issues) ? ` ${(body.issues as string[]).join(" ")}` : "";
  return { content: [{ type: "text", text: `${message}${issues}` }], structuredContent: body, isError: true };
}
