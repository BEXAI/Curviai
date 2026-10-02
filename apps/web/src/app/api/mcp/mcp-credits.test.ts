import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authenticateApiKey, type ApiAuthResult, type ApiCaller } from "@/lib/api-keys/auth";
import { setApiKeyBackendForTests } from "@/lib/api-keys/backend";
import { EstimateChat, PackChat } from "@/lib/api-v1/chat-views";
import { PROTOCOL_VERSION_META, handleMcpPost } from "@/lib/api-v1/mcp";
import { MCP_COPY } from "@/lib/api-v1/mcp-copy";
import { canonicalPack, quoteSigningKeys, signQuote } from "@/lib/api-v1/pack-quote";
import { CreatePackRequest } from "@/lib/api-v1/schemas";
import { demoApiFixture, mainImagePng, type DemoApiFixture } from "@/lib/api-v1/test-fixtures";
import { MemoryRateLimitStore, setRateLimitStoreForTests } from "@/lib/rate-limit";
import { DEMO_WORKSPACE_ID } from "@/lib/services/demo";
import type { CreateJobInput } from "@/lib/services/types";

// Credits shown before they are spent (docs/phases/PHASE_19.md P19-16,
// founder decision 5), end to end through /api/mcp over the demo services:
// estimate_pack's figure is the hold create_pack makes, an OAuth create_pack
// needs a matching quote and max_credits, nothing is held above them, and a
// retry replays whatever idempotency_key the model writes.

const VERSION = "2026-07-28";
const DEMO_PRODUCT_ID = "00000000-0000-4000-8000-000000000101";
let fixture: DemoApiFixture;
let keyCaller: ApiCaller;
let nextId = 1;

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
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: nextId++,
      method: "tools/call",
      params: { name, arguments: args, _meta: { [PROTOCOL_VERSION_META]: VERSION } },
    }),
  });
}

interface ToolAnswer {
  isError: boolean;
  structuredContent?: Record<string, unknown>;
  content: Array<{ type: string; text: string }>;
}

/** An OAuth caller (P19-08 builds these on p19/auth): the key's member and
 * workspace, reached through a connection. */
function oauthCaller(overrides: Partial<ApiCaller> = {}): ApiCaller {
  return { ...keyCaller, kind: "oauth", keyId: null, prefix: null, connectionId: "conn-1", ipExempt: true, ...overrides };
}

async function call(name: string, args: Record<string, unknown>, caller: ApiCaller | null = null): Promise<ToolAnswer> {
  const deps = caller ? { authenticate: async (): Promise<ApiAuthResult> => ({ ok: true, caller }) } : {};
  const response = await handleMcpPost(rpc(name, args), deps);
  const body = (await response.json()) as { result?: ToolAnswer; error?: unknown };
  if (!body.result) {
    throw new Error(`no result: ${JSON.stringify(body)}`);
  }
  return body.result;
}

async function estimate(args: Record<string, unknown>, caller: ApiCaller | null = null): Promise<EstimateChat> {
  const answer = await call("estimate_pack", args, caller);
  expect(answer.isError, answer.content[0]?.text).toBe(false);
  return EstimateChat.parse(answer.structuredContent);
}

function jobCount(): number {
  return (fixture.service as unknown as { store: { jobs: Map<string, unknown> } }).store.jobs.size;
}

let photoData: string;

beforeEach(async () => {
  fixture = demoApiFixture();
  setApiKeyBackendForTests(fixture.backend);
  setRateLimitStoreForTests(new MemoryRateLimitStore());
  const authed = await authenticateApiKey(new Headers({ authorization: `Bearer ${fixture.key}` }), null);
  if (!authed.ok) {
    throw new Error("the demo key should authenticate");
  }
  keyCaller = authed.caller;
  photoData ??= (await mainImagePng(1200, 0.7)).toString("base64");
});

afterEach(() => {
  setApiKeyBackendForTests(null);
  setRateLimitStoreForTests(null);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("estimate_pack", () => {
  const REQUESTS: Array<Record<string, unknown>> = [
    { channels: ["amazon.main", "shopify"] },
    { channels: ["amazon"], bundle: "main", title: "Desk lamp" },
    { channels: ["etsy", "ebay"], look: "keep_photo", photos: [{ data: "PHOTO" }] },
    { channels: ["instagram"], outputOptions: { color: { kind: "swatch", key: "sand" } }, photos: [{ data: "PHOTO", angle: "front" }] },
    { channels: ["meta.feed_1x1", "pinterest"], productId: DEMO_PRODUCT_ID, look: "marketplace" },
  ];

  function withPhoto(args: Record<string, unknown>): Record<string, unknown> {
    const photos = args.photos as Array<Record<string, unknown>> | undefined;
    return photos ? { ...args, photos: photos.map((photo) => ({ ...photo, data: photoData })) } : args;
  }

  it("returns exactly the hold create_pack then makes, and stores nothing", async () => {
    vi.stubEnv("NEXT_PUBLIC_OUTPUT_OPTIONS", "1");
    for (const raw of REQUESTS) {
      const args = withPhoto(raw);
      const before = jobCount();
      const quoted = await estimate(args, oauthCaller());
      expect(jobCount(), JSON.stringify(raw)).toBe(before);
      expect(quoted.credits_needed).toBeGreaterThan(0);
      expect(quoted.quote_valid_minutes).toBe(15);
      expect(quoted.enough).toBe(quoted.credits_available >= quoted.credits_needed);
      expect(quoted.message).toBe(MCP_COPY.estimateReady(quoted.credits_needed, quoted.credits_available));

      const created = await call(
        "create_pack",
        { ...args, quote: quoted.quote, max_credits: quoted.credits_needed },
        oauthCaller(),
      );
      expect(created.isError, created.content[0]?.text).toBe(false);
      const pack = PackChat.parse(created.structuredContent);
      expect(pack.credits.held, JSON.stringify(raw)).toBe(quoted.credits_needed);
    }
    vi.unstubAllEnvs();
  });

  it("maps instagram to the live Meta specs", async () => {
    const quoted = await estimate({ channels: ["instagram"] });
    expect(quoted.channels.length).toBeGreaterThan(0);
    expect(quoted.channels.every((id) => id.startsWith("meta."))).toBe(true);
  });

  it("refuses an unknown channel and a client seat with the neutral copy", async () => {
    const unknown = await call("estimate_pack", { channels: ["myspace"] });
    expect(unknown).toMatchObject({ isError: true, content: [{ text: MCP_COPY.unknownChannels(["myspace"]) }] });
    const seat = await call("estimate_pack", { channels: ["amazon.main"] }, oauthCaller({
      principal: { ...keyCaller.principal, role: "client" },
    }));
    expect(seat).toMatchObject({ isError: true, content: [{ text: MCP_COPY.clientSeat }] });
  });
});

describe("create_pack for an OAuth caller", () => {
  const ARGS = { channels: ["amazon.main", "shopify.product"], title: "Mug" };

  it("needs a quote and max_credits, and refuses an expired, foreign or altered quote with nothing held", async () => {
    const quoted = await estimate(ARGS, oauthCaller());
    const before = jobCount();

    const missing = await call("create_pack", ARGS, oauthCaller());
    expect(missing).toMatchObject({ isError: true, content: [{ text: MCP_COPY.quoteNeeded }] });
    // A quote without max_credits names the missing field: a new estimate
    // would not fix it, so the model must not loop back to estimate_pack.
    const noMax = await call("create_pack", { ...ARGS, quote: quoted.quote }, oauthCaller());
    expect(noMax).toMatchObject({ isError: true, content: [{ text: MCP_COPY.maxCreditsNeeded }] });
    expect(noMax.content[0]?.text).toContain("max_credits");
    expect(noMax.content[0]?.text).not.toContain("estimate_pack with");

    const keys = quoteSigningKeys();
    if (!keys) {
      throw new Error("tests sign with the process key");
    }
    const request = CreatePackRequest.parse(ARGS);
    const foreign = signQuote(keys, {
      workspaceId: "00000000-0000-4000-8000-0000000000ff",
      pack: canonicalPack(request, ["amazon.main", "shopify.product"], []),
      credits: quoted.credits_needed,
      now: new Date(),
    });
    for (const quote of [foreign, quoted.quote.replace(/^q1\.\d+\./, "q1.1."), "q1.nope"]) {
      const refused = await call("create_pack", { ...ARGS, quote, max_credits: quoted.credits_needed }, oauthCaller());
      expect(refused, quote).toMatchObject({ isError: true, content: [{ text: MCP_COPY.quoteNeeded }] });
    }
    // A quote for other choices does not start this pack.
    const otherChoices = await call(
      "create_pack",
      { ...ARGS, channels: ["amazon.main"], quote: quoted.quote, max_credits: quoted.credits_needed },
      oauthCaller(),
    );
    expect(otherChoices.content[0]?.text).toBe(MCP_COPY.quoteNeeded);

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 16 * 60_000);
    const expired = await call("create_pack", { ...ARGS, quote: quoted.quote, max_credits: quoted.credits_needed }, oauthCaller());
    expect(expired.content[0]?.text).toBe(MCP_COPY.quoteNeeded);
    expect(jobCount()).toBe(before);
  });

  it("holds nothing when the pack needs more than max_credits", async () => {
    const quoted = await estimate(ARGS, oauthCaller());
    const before = jobCount();
    const over = await call(
      "create_pack",
      { ...ARGS, quote: quoted.quote, max_credits: quoted.credits_needed - 1 },
      oauthCaller(),
    );
    expect(over).toMatchObject({
      isError: true,
      content: [{ text: MCP_COPY.overMaxCredits(quoted.credits_needed, quoted.credits_needed - 1) }],
    });
    expect(over.structuredContent).toBeUndefined();
    expect(jobCount()).toBe(before);
    const after = await estimate(ARGS, oauthCaller());
    expect(after.credits_available).toBe(quoted.credits_available);
  });

  it("replays a retry whatever idempotency_key the model sends, across the 10 minute window edge", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-01T12:09:30.000Z"));
    const quoted = await estimate(ARGS, oauthCaller());
    const first = await call(
      "create_pack",
      { ...ARGS, quote: quoted.quote, max_credits: quoted.credits_needed, idempotency_key: "model-1" },
      oauthCaller(),
    );
    const pack = PackChat.parse(first.structuredContent);
    vi.setSystemTime(new Date("2026-10-01T12:11:00.000Z"));
    const retry = await call(
      "create_pack",
      { ...ARGS, quote: quoted.quote, max_credits: quoted.credits_needed, idempotency_key: "model-2" },
      oauthCaller(),
    );
    expect(retry.isError).toBe(false);
    expect(retry.structuredContent).toMatchObject({ pack_id: pack.pack_id, replayed: true, message: MCP_COPY.packReplayed });
    // Another member's connection is another request.
    const other = await call(
      "create_pack",
      { ...ARGS, quote: quoted.quote, max_credits: quoted.credits_needed },
      oauthCaller({ connectionId: "conn-2" }),
    );
    expect(PackChat.parse(other.structuredContent).pack_id).not.toBe(pack.pack_id);
  });

  it("starts a Listing Mode pack through createJob with the cap and the derived keys", async () => {
    const spy = vi.spyOn(fixture.service, "createJob");
    const quoted = await estimate(ARGS, oauthCaller());
    await call("create_pack", { ...ARGS, quote: quoted.quote, max_credits: quoted.credits_needed + 5 }, oauthCaller());
    const input = spy.mock.calls[0]?.[1] as CreateJobInput;
    expect(input.mode).toBe("listing");
    expect(input.maxCredits).toBe(quoted.credits_needed);
    expect(input.idempotencyKey).toMatch(/^mcp:[0-9a-f]{64}$/);
    expect(input.previousIdempotencyKeys).toHaveLength(1);
  });
});

describe("create_pack for an API key caller", () => {
  it("keeps today's input: no quote needed, and its own idempotency_key is honored", async () => {
    const args = { channels: ["amazon.main"], idempotency_key: "key-own-1" };
    const created = await call("create_pack", args);
    expect(created.isError, created.content[0]?.text).toBe(false);
    const retry = await call("create_pack", args);
    expect(retry.structuredContent).toMatchObject({ replayed: true });
    const conflict = await call("create_pack", { ...args, channels: ["shopify.product"] });
    expect(conflict).toMatchObject({ isError: true, content: [{ text: MCP_COPY.idempotencyConflict }] });
  });

  it("derives the key when the model leaves it out, and still honors max_credits", async () => {
    const first = await call("create_pack", { channels: ["etsy"] });
    const again = await call("create_pack", { channels: ["etsy"] });
    expect(again.structuredContent).toMatchObject({ pack_id: (first.structuredContent as { pack_id: string }).pack_id, replayed: true });
    const capped = await call("create_pack", { channels: ["walmart"], max_credits: 0 });
    expect(capped.isError).toBe(true);
    expect(capped.content[0]?.text).toMatch(/^This pack needs \d+ credits, more than the 0 in the estimate/);
  });
});

describe("refusals an assistant reads", () => {
  it("says both numbers when the workspace is short, and never a top up", async () => {
    const short = { outcome: "rejected" as const, reason: "insufficient_credits" as const, message: "Not enough credits for this pack. Top up or pick fewer channels.", creditsNeeded: 9, creditsAvailable: 4 };
    vi.spyOn(fixture.service, "createJob").mockResolvedValue(short);
    vi.spyOn(fixture.service, "estimateJob").mockResolvedValue(short);
    const created = await call("create_pack", { channels: ["amazon.main"] });
    expect(created.content[0]?.text).toBe(MCP_COPY.insufficientCredits(9, 4));
    const estimated = await call("estimate_pack", { channels: ["amazon.main"] });
    expect(estimated.content[0]?.text).toBe(MCP_COPY.insufficientCredits(9, 4));
  });

  it("names brand colors, not a plan, when the plan has no brand kit", async () => {
    vi.spyOn(fixture.service, "estimateJob").mockResolvedValue({
      outcome: "rejected",
      reason: "upgrade_required",
      message: "Your plan does not include brand kits, so brand colors are not available. Pick another color or upgrade on the billing page.",
    });
    const refused = await call("estimate_pack", { channels: ["amazon.main"], outputOptions: { color: { kind: "brand", index: 0 } } });
    expect(refused.content[0]?.text).toBe(MCP_COPY.brandColorsNotInPlan);
  });

  it("asks for the photo again when a pack has none", async () => {
    vi.spyOn(fixture.service, "estimateJob").mockResolvedValue({
      outcome: "rejected",
      reason: "needs_photo",
      message: "Listing Mode needs at least one real photo of this product. Upload one first.",
    });
    const refused = await call("estimate_pack", { channels: ["amazon.main"] });
    expect(refused.content[0]?.text).toBe(MCP_COPY.noAttachment);
  });

  it("reports an unreadable photo by its number", async () => {
    const refused = await call("estimate_pack", { channels: ["amazon.main"], photos: [{ data: photoData }, { data: "bm90IGFuIGltYWdl" }] });
    expect(refused).toMatchObject({ isError: true, content: [{ text: MCP_COPY.photoUnreadable(2) }] });
  });

  it("refuses to count credits in production without signing keys", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://curvi.ai");
    vi.stubEnv("MCP_LINK_KEYS", "");
    const refused = await call("estimate_pack", { channels: ["amazon.main"] });
    expect(refused.content[0]?.text).toBe(MCP_COPY.estimateUnavailable);
    vi.unstubAllEnvs();
  });

  it("keeps the demo workspace's balance for the key's own workspace only", async () => {
    expect(await fixture.service.workspaceBalance(DEMO_WORKSPACE_ID)).toBeGreaterThan(0);
    expect(await fixture.service.workspaceBalance("00000000-0000-4000-8000-0000000000ff")).toBeNull();
  });
});
