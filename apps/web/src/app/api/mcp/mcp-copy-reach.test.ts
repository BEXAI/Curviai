import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rule9Problems } from "@curvi/pipeline";
import { tiers } from "@curvi/pipeline/seed";
import { authenticateApiKey, type ApiAuthResult, type ApiCaller } from "@/lib/api-keys/auth";
import { setApiKeyBackendForTests } from "@/lib/api-keys/backend";
import { PROTOCOL_VERSION_META, handleMcpPost } from "@/lib/api-v1/mcp";
import { MCP_BANNED_WORDS, MCP_COPY, mcpCopyProblems, type McpCopyKey } from "@/lib/api-v1/mcp-copy";
import { GET_PROFILE_TOOL, MCP_INSTRUCTIONS, toolDescriptor, toolList } from "@/lib/api-v1/mcp-tools";
import { demoApiFixture, mainImagePng, type DemoApiFixture } from "@/lib/api-v1/test-fixtures";
import { tierName } from "@/lib/entitlements";
import { JOB_ERROR_COPY, jobErrorLineFor, publicJobError } from "@/lib/job-copy";
import { MemoryRateLimitStore, setRateLimitStoreForTests } from "@/lib/rate-limit";
import { INSUFFICIENT_CREDITS_MESSAGE, NO_BILLABLE_SHOTS_MESSAGE, RESTARTING_MESSAGE } from "@/lib/services/errors";
import { BRAND_COLOR_UPGRADE_MESSAGE, INVALID_OPTIONS_MESSAGE, OPTIONS_UNAVAILABLE_MESSAGE } from "@/lib/services/output-options";
import type { CreateJobRejection, JobView } from "@/lib/services/types";

// PHASE_19 "Done when": no string reachable through /api/mcp promotes an
// upgrade, a top up or a plan, and none asks for an API key (OpenAI O6: no
// upselling, no plan shown, never collect keys or passwords in the chat).
// This walks every string a tool can send: the copy table, the server
// instructions, every descriptor text (with and without the chat
// attachment fields), the pack failure lines an assistant reads, and the
// text of every refusal and success the tools answer, driven through the
// endpoint. The 401 answer before any tool runs is the sign in branch's
// (P19-08, p19/auth), which owns its copy and its test.

const VERSION = "2026-07-28";
let fixture: DemoApiFixture;
let keyCaller: ApiCaller;
let nextId = 1;

/** Every seed plan name, as a word: no plan may be named to an assistant
 * ("free" in any case is refused by mcpCopyProblems). */
const PLAN_NAMES = new RegExp(`\\b(${tiers.map((tier) => tierName(tier.key)).join("|")})\\b`);

/** Web form wording an assistant cannot act on: buttons and choices that
 * exist only on curvi.ai's pages. */
const WEB_FORM_WORDS = /\bchoose a file\b|\bmarketplace ready\b|\bclick\b|\bdrag and drop\b|\bupload one\b/i;

function problemsOf(text: string): string[] {
  return [
    ...rule9Problems(text),
    ...mcpCopyProblems(text),
    ...(PLAN_NAMES.test(text) ? ["names a plan"] : []),
    ...(WEB_FORM_WORDS.test(text) ? ["web form wording"] : []),
    ...(/\bapi key\b/i.test(text) && !/^API keys are not part of this workspace's current plan\.$/.test(text) ? ["mentions an API key"] : []),
  ];
}

function expectClean(texts: readonly string[], where: string): void {
  expect(texts.length, where).toBeGreaterThan(0);
  for (const text of texts) {
    expect(problemsOf(text), `${where}: ${text}`).toEqual([]);
  }
}

function rpc(name: string, args: Record<string, unknown>): Request {
  return new Request("https://curvi.ai/api/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "mcp-protocol-version": VERSION,
      "mcp-method": "tools/call",
      "mcp-name": name,
      authorization: `Bearer ${fixture.key}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method: "tools/call", params: { name, arguments: args, _meta: { [PROTOCOL_VERSION_META]: VERSION } } }),
  });
}

/** Every string a tool answer carries for the model: the text blocks and,
 * for a success, the sentences inside the view (user data such as the
 * product title aside). */
async function textsOf(name: string, args: Record<string, unknown>, auth?: ApiAuthResult): Promise<string[]> {
  const response = await handleMcpPost(rpc(name, args), auth ? { authenticate: async () => auth } : {});
  const body = (await response.json()) as {
    result?: { isError: boolean; content: Array<{ text: string }>; structuredContent?: Record<string, unknown> };
    error?: { message: string };
  };
  if (!body.result) {
    return [body.error?.message ?? ""];
  }
  const view = body.result.structuredContent ?? {};
  const sentences = [
    view.message,
    view.error,
    ...((view.left_out as Array<{ reason: string }> | undefined) ?? []).map((entry) => entry.reason),
    ...((view.channels as Array<{ note?: string | null }> | undefined) ?? []).flatMap((channel) =>
      typeof channel === "object" && channel?.note ? [channel.note] : [],
    ),
  ].filter((text): text is string => typeof text === "string");
  return [...(body.result.isError ? body.result.content.map((block) => block.text) : body.result.content.slice(1).map((b) => b.text)), ...sentences];
}

function rejection(reason: CreateJobRejection["reason"], message: string, extra: Partial<CreateJobRejection> = {}): CreateJobRejection {
  return { outcome: "rejected", reason, message, ...extra };
}

/** Every refusal createJob and estimateJob can send, with its web line. */
const REJECTIONS: CreateJobRejection[] = [
  rejection("insufficient_credits", INSUFFICIENT_CREDITS_MESSAGE, { creditsNeeded: 30, creditsAvailable: 5 }),
  rejection("insufficient_credits", NO_BILLABLE_SHOTS_MESSAGE),
  rejection("over_max_credits", "This pack needs 30 credits, more than the 20 allowed for it, so it was not started.", { creditsNeeded: 30, maxCredits: 20 }),
  rejection("upgrade_required", BRAND_COLOR_UPGRADE_MESSAGE),
  rejection("upgrade_required", "Video comes with the Pro plan and above. Upgrade, or remove the video channels to start this pack."),
  rejection("feature_unavailable", "Video is coming soon, so video channels cannot be added to a pack yet. Remove them to start this pack."),
  rejection("feature_unavailable", OPTIONS_UNAVAILABLE_MESSAGE),
  rejection("role_forbidden", "Client seats can review assets but cannot start packs or spend credits."),
  rejection("needs_photo", "Listing Mode needs at least one real photo of this product. Upload one first."),
  rejection("unknown_product", "That product does not exist in this workspace."),
  rejection("unavailable", RESTARTING_MESSAGE),
  rejection("invalid_upload", "One of these photos cannot be used for a pack. Remove it and upload another."),
  rejection("invalid_options", INVALID_OPTIONS_MESSAGE),
  rejection("mode_unavailable", "Concept Mode is not available yet. Start a Listing Mode pack from a real photo."),
];

beforeEach(async () => {
  fixture = demoApiFixture();
  setApiKeyBackendForTests(fixture.backend);
  setRateLimitStoreForTests(new MemoryRateLimitStore());
  const authed = await authenticateApiKey(new Headers({ authorization: `Bearer ${fixture.key}` }), null);
  if (!authed.ok) {
    throw new Error("the demo key should authenticate");
  }
  keyCaller = authed.caller;
});

afterEach(() => {
  setApiKeyBackendForTests(null);
  setRateLimitStoreForTests(null);
  vi.restoreAllMocks();
});

describe("strings an assistant can be sent", () => {
  it("the copy table", () => {
    const samples: Partial<Record<McpCopyKey, unknown[]>> = { unknownChannels: [["myspace"]], featureNotInPlan: ["Video"], linksValid: [1440] };
    const lines = (Object.keys(MCP_COPY) as McpCopyKey[]).map((key) => {
      const entry: unknown = MCP_COPY[key];
      if (typeof entry === "string") {
        return entry;
      }
      const fn = entry as (...args: unknown[]) => string;
      return fn(...(samples[key] ?? Array.from({ length: fn.length }, (_, index) => 12 + index)));
    });
    expectClean(lines, "MCP_COPY");
    expect(MCP_BANNED_WORDS).toEqual(["upgrade", "top up", "billing", "see plans", "pricing", "checkout", "subscribe", "free trial"]);
  });

  it("the instructions and every descriptor text, with and without chat attachments", () => {
    const strings = (node: unknown): string[] =>
      Array.isArray(node)
        ? node.flatMap(strings)
        : node && typeof node === "object"
          ? Object.values(node as Record<string, unknown>).flatMap(strings)
          : typeof node === "string" && /\s/.test(node)
            ? [node]
            : [];
    expectClean([MCP_INSTRUCTIONS], "instructions");
    for (const descriptor of [...toolList(), ...toolList({ chatFiles: true }), toolDescriptor(GET_PROFILE_TOOL)]) {
      expectClean(strings(descriptor), String(descriptor.name));
    }
  });

  it("every pack failure line, as an assistant reads it", () => {
    const lines = Object.values(JOB_ERROR_COPY).map((line) => jobErrorLineFor(line, "assistant") ?? "");
    expectClean(lines, "job errors");
    expect(publicJobError("credit reservation failed", "assistant")).toBe(MCP_COPY.packStoppedForCredits);
    // The web keeps its own lines.
    expect(publicJobError("credit reservation failed")).toBe(JOB_ERROR_COPY.credits);
    expect(JOB_ERROR_COPY.credits).toContain("Top up");
    expect(INSUFFICIENT_CREDITS_MESSAGE).toBe("Not enough credits for this pack. Top up or pick fewer channels.");
  });

  it("every refusal createJob and estimateJob send, through create_pack and estimate_pack", async () => {
    for (const refused of REJECTIONS) {
      vi.spyOn(fixture.service, "createJob").mockResolvedValue(refused);
      vi.spyOn(fixture.service, "estimateJob").mockResolvedValue(refused);
      const where = `${refused.reason}: ${refused.message}`;
      expectClean(await textsOf("create_pack", { channels: ["amazon.main"] }), `create_pack ${where}`);
      expectClean(await textsOf("estimate_pack", { channels: ["amazon.main"] }), `estimate_pack ${where}`);
      vi.restoreAllMocks();
    }
  });

  it("the refusals the tools make themselves", async () => {
    const png = (await mainImagePng(1200, 0.8)).toString("base64");
    const oauth: ApiAuthResult = { ok: true, caller: { ...keyCaller, kind: "oauth", keyId: null, prefix: null, connectionId: "c1", ipExempt: true } };
    const client: ApiAuthResult = { ok: true, caller: { ...keyCaller, principal: { ...keyCaller.principal, role: "client" } } };
    const cases: Array<[string, Record<string, unknown>, ApiAuthResult | undefined]> = [
      ["create_pack", { channels: ["myspace"] }, undefined],
      ["create_pack", { channels: ["amazon.main"] }, client],
      ["create_pack", { channels: ["amazon.main"] }, oauth],
      ["create_pack", { channels: ["amazon.main"], quote: "q1.1.1.k.x", max_credits: 1 }, oauth],
      ["create_pack", { channels: ["amazon.main"], max_credits: 0 }, undefined],
      ["create_pack", { channels: ["amazon.main"], idempotency_key: "reach-1" }, undefined],
      ["create_pack", { channels: ["shopify.product"], idempotency_key: "reach-1" }, undefined],
      ["create_pack", { channels: [] }, undefined],
      ["estimate_pack", { channels: ["amazon.main"], photos: [{ data: "bm90IGFuIGltYWdl" }] }, undefined],
      ["estimate_pack", { channels: ["amazon.main"], photos: [{ url: "http://127.0.0.1/photo.png" }] }, undefined],
      ["get_pack", { pack_id: "5a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d" }, undefined],
      ["check_main_image", { data: "bm90IGFuIGltYWdl" }, undefined],
      ["check_main_image", { url: "https://127.0.0.1/x.png" }, undefined],
      ["check_main_image", { url: "http://example.com/x.jpg" }, undefined],
      ["check_main_image", { url: "https://127.0.0.1/x.png" }, oauth],
      ["check_main_image", { data: "bm90IGFuIGltYWdl" }, oauth],
      ["list_channels", { surprise: true }, undefined],
      // The key's plan has no API access, or the key lacks the scope.
      ["create_pack", { channels: ["amazon.main"] }, { ok: false, error: { status: 403, reason: "upgrade_required", message: "API keys come with the Growth plan and above. Upgrade to use them." } }],
      ["create_pack", { channels: ["amazon.main"] }, { ok: true, caller: { ...keyCaller, scopes: ["checks"] } }],
    ];
    for (const [name, args, auth] of cases) {
      expectClean(await textsOf(name, args, auth), `${name} ${JSON.stringify(args)}`);
    }
    // And the successes, from a whole pack.
    const successes = [
      ...(await textsOf("list_channels", {})),
      ...(await textsOf("estimate_pack", { channels: ["amazon", "instagram"], photos: [{ data: png }] })),
      ...(await textsOf("check_main_image", { data: png })),
    ];
    const created = await handleMcpPost(rpc("create_pack", { channels: ["amazon.main"], photos: [{ data: png }] }));
    const packId = ((await created.json()) as { result: { structuredContent: { pack_id: string } } }).result.structuredContent.pack_id;
    for (let i = 0; i < 12; i += 1) {
      successes.push(...(await textsOf("get_pack", { pack_id: packId })));
    }
    expectClean(successes, "successes");
  });

  it("a refused key with sign in on gets the neutral line, in the error and in the challenge", async () => {
    vi.stubEnv("MCP_OAUTH_ENABLED", "1");
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://curvi.ai");
    try {
      const wrongKey = `${fixture.key.slice(0, -1)}${fixture.key.endsWith("a") ? "b" : "a"}`;
      for (const method of ["tools/call", "tools/list", "initialize"]) {
        const request = rpc("list_channels", {});
        request.headers.set("authorization", `Bearer ${wrongKey}`);
        request.headers.set("mcp-method", method);
        const sent = new Request(request.url, {
          method: "POST",
          headers: request.headers,
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: nextId++,
            method,
            params:
              method === "tools/call"
                ? { name: "list_channels", arguments: {}, _meta: { [PROTOCOL_VERSION_META]: VERSION } }
                : { _meta: { [PROTOCOL_VERSION_META]: VERSION } },
          }),
        });
        const response = await handleMcpPost(sent);
        expect(response.status, method).toBe(401);
        const body = (await response.json()) as { error: { message: string } };
        const description = /error_description="([^"]*)"/.exec(response.headers.get("www-authenticate") ?? "")?.[1] ?? "";
        expect(body.error.message, method).toBe(MCP_COPY.keyRefused);
        expect(description, method).toBe(MCP_COPY.keyRefused);
        expectClean([body.error.message, description], `refused key, ${method}`);
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("every failed pack's line through get_pack", async () => {
    const job = (error: string): JobView => ({
      id: "5a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d",
      productId: "3f2e1d0c-9b8a-4765-8432-10fedcba9876",
      productTitle: "Mug",
      status: "failed",
      mode: "listing",
      channels: ["amazon.main"],
      creditsReserved: 4,
      creditsCharged: 0,
      createdAt: "2026-10-01T12:00:00.000Z",
      shots: [],
      error,
    });
    for (const line of Object.values(JOB_ERROR_COPY)) {
      vi.spyOn(fixture.service, "getJob").mockResolvedValue(job(line));
      vi.spyOn(fixture.service, "listJobFiles").mockResolvedValue({ jobId: "x", status: "failed", files: [] });
      expectClean(await textsOf("get_pack", { pack_id: "5a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d" }), `failed: ${line}`);
      vi.restoreAllMocks();
    }
  });
});
