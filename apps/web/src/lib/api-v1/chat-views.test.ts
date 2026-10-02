import { describe, expect, it } from "vitest";
import { z } from "zod";
import { backgroundSwatches, presets, tiers } from "@curvi/pipeline/seed";
import { tierName } from "@/lib/entitlements";
import { JOB_ERROR_COPY } from "@/lib/job-copy";
import { CHANNEL_SPECS } from "@/lib/marketing-facts";
import { DEMO_TIER } from "@/lib/services/demo";
import type { JobFileView } from "@/lib/services/types";
import { expandChannels, listChannels } from "./actions";
import {
  CHAT_VIEWS,
  CHAT_VIEW_FIELDS,
  ChannelsChat,
  EstimateChat,
  PackChat,
  ProfileChat,
  channelsChatOf,
  chatViewFields,
  estimateChatOf,
  packChatOf,
  packImagesOf,
  packProgressOf,
} from "./chat-views";
import { MCP_COPY } from "./mcp-copy";
import type { Pack } from "./schemas";

// The chat views (PHASE_19 P19-02 shapes, P19-14 builders): only what the
// seller asked about, and a field list for the privacy policy (P19-23).

describe("chat views", () => {
  it("lists every field, nested ones included", () => {
    expect(chatViewFields(PackChat)).toEqual(
      expect.arrayContaining(["pack_id", "credits", "credits.held", "images", "images[].preview_url", "images[].download_url"]),
    );
    expect(CHAT_VIEW_FIELDS).toEqual(expect.arrayContaining(["quote", "left_out[].reason", "scene_styles[].label", "email"]));
    expect([...CHAT_VIEW_FIELDS]).toEqual([...new Set(CHAT_VIEW_FIELDS)].sort());
  });

  it("carries none of the fields the REST pack body keeps to itself", () => {
    for (const dropped of ["createdAt", "productId", "shots", "links", "background", "upgradeTo", "availability", "id"]) {
      expect(chatViewFields(PackChat), dropped).not.toContain(dropped);
    }
    expect(CHAT_VIEW_FIELDS.some((field) => /created|timestamp|session|trace|request_id/i.test(field))).toBe(false);
  });

  it("makes output schemas with no extra properties, and a profile whose id is required", () => {
    for (const [name, view] of Object.entries(CHAT_VIEWS)) {
      const schema = z.toJSONSchema(view, { io: "output", target: "draft-2020-12" }) as Record<string, unknown>;
      expect(schema.type, name).toBe("object");
      expect(schema.additionalProperties, name).toBe(false);
    }
    expect(ProfileChat.safeParse({ id: "" }).success).toBe(false);
    expect(ProfileChat.safeParse({ id: "   " }).success).toBe(false);
    expect(ProfileChat.safeParse({ id: "p1", name: "Shop", email: "a@b.co" }).success).toBe(true);
    expect(ProfileChat.safeParse({ id: "p1", user_id: "u" }).success).toBe(false);
  });
});

/** A REST pack as packOf answers it. */
function restPack(overrides: Partial<Pack> = {}): Pack {
  return {
    id: "5a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d",
    status: "done",
    finished: true,
    productId: "3f2e1d0c-9b8a-4765-8432-10fedcba9876",
    productTitle: "Desk lamp",
    channels: ["amazon.main", "shopify.product"],
    creditsReserved: 12,
    creditsCharged: 8,
    createdAt: "2026-10-01T12:00:00.000Z",
    error: null,
    shots: [
      { id: "shot-1", type: "amazon_main", status: "done", channels: ["amazon.main"], credits: 4, note: null, compliance: { pass: true, fillPct: 86, background: [255, 255, 255], fidelity: null } },
      { id: "shot-2", type: "alt_angle_white", status: "done", channels: ["shopify.product"], credits: 4, note: null, compliance: { pass: false, fillPct: 40, background: [250, 250, 250], fidelity: null } },
      { id: "shot-3", type: "lifestyle", status: "skipped", channels: ["shopify.product"], credits: 0, note: "Needs photo", compliance: null },
    ],
    links: { self: "/api/v1/packs/x", files: "/api/v1/packs/x/files" },
    ...overrides,
  };
}

const FILES: JobFileView[] = [
  { id: "v_1", name: "amazon-main.jpg", channel: "amazon", specId: "amazon.main", kind: "image", bytes: 1, url: null, downloadUrl: "/d/1", shotId: "shot-1" },
  { id: "v_2", name: "shopify.jpg", channel: "shopify", specId: "shopify.product", kind: "image", bytes: 1, url: null, downloadUrl: "/d/2", shotId: "shot-2" },
  { id: "p_1", name: "amazon.zip", channel: "amazon", specId: null, kind: "zip", bytes: 1, url: null, downloadUrl: "/d/3" },
];

describe("pack view builder", () => {
  it("keeps only what the seller asked about and drops ids, timestamps, links and RGB backgrounds", () => {
    const links = new Map([
      ["v_1", { preview_url: "https://curvi.ai/api/mcp/preview/t1", download_url: "https://curvi.ai/api/mcp/files/t1" }],
      ["p_1", { preview_url: "https://curvi.ai/api/mcp/preview/zip", download_url: "https://curvi.ai/api/mcp/files/t3" }],
    ]);
    const images = packImagesOf(FILES, restPack().shots, links);
    const view = PackChat.parse(packChatOf(restPack(), { images, linksValidMinutes: 24 * 60 }));
    const text = JSON.stringify(view);
    for (const dropped of ["createdAt", "productId", "shot-1", "/api/v1/", "2026-10-01", "background", "3f2e1d0c"]) {
      expect(text, dropped).not.toContain(dropped);
    }
    expect(view).toMatchObject({
      pack_id: restPack().id,
      product: "Desk lamp",
      credits: { held: 12, charged: 8 },
      progress: { done: 2, total: 2 },
      links_valid_hours: 24,
      error: null,
      message: `${MCP_COPY.packReady(1, 2)} ${MCP_COPY.linksValid(24 * 60)}`,
    });
    expect(view.images).toEqual([
      { name: "amazon-main.jpg", channel: "amazon.main", kind: "image", passes_channel_rules: true, fill_percent: 86, fidelity: null, preview_url: links.get("v_1")!.preview_url, download_url: links.get("v_1")!.download_url },
      { name: "shopify.jpg", channel: "shopify.product", kind: "image", passes_channel_rules: false, fill_percent: 40, fidelity: null, preview_url: null, download_url: null },
      // A zip carries no check and no preview, whatever the provider signs.
      { name: "amazon.zip", channel: "amazon", kind: "zip", passes_channel_rules: null, fill_percent: null, fidelity: null, preview_url: null, download_url: links.get("p_1")!.download_url },
    ]);
  });

  it("says no link lifetime when no link was signed, and minutes for short links", () => {
    const none = packChatOf(restPack(), { images: packImagesOf(FILES, restPack().shots, new Map()), linksValidMinutes: 15 });
    expect(none.links_valid_hours).toBeUndefined();
    expect(none.message).toBe(MCP_COPY.packReady(1, 2));
    const short = packChatOf(restPack(), {
      images: packImagesOf(FILES, restPack().shots, new Map([["v_1", { preview_url: null, download_url: "https://r2.example/x" }]])),
      linksValidMinutes: 15,
    });
    expect(short.links_valid_hours).toBeUndefined();
    expect(short.message).toBe(`${MCP_COPY.packReady(1, 2)} ${MCP_COPY.linksValid(15)}`);
    expect(MCP_COPY.linksValid(15)).toBe("The links work for 15 minutes.");
  });

  it("gives one plain sentence for each state", () => {
    const shots = restPack().shots.map((shot) => (shot.status === "skipped" ? shot : { ...shot, status: "generating" as const }));
    expect(packChatOf(restPack({ status: "queued", finished: false })).message).toBe(MCP_COPY.packQueued);
    expect(packChatOf(restPack({ status: "planning", finished: false, shots: [] })).message).toBe(MCP_COPY.packPlanning);
    expect(packChatOf(restPack({ status: "generating", finished: false, shots })).message).toBe(MCP_COPY.packWorking(0, 2));
    expect(packChatOf(restPack({ status: "canceled" })).message).toBe(MCP_COPY.packCanceled);
    expect(packChatOf(restPack({ status: "failed", error: null })).message).toBe(MCP_COPY.packFailed);
    expect(packChatOf(restPack(), { created: true }).message).toBe(`${MCP_COPY.packStarted(12)} ${MCP_COPY.packTakesMinutes}`);
    expect(packChatOf(restPack(), { replayed: true })).toMatchObject({ replayed: true, message: MCP_COPY.packReplayed });
    expect(packChatOf(restPack({ shots: [] }), { images: [] }).message).toBe(MCP_COPY.packReadyNoImages);
    expect(packProgressOf([])).toEqual({ done: 0, total: 0 });
  });

  it("swaps the web's top up line for the neutral one and keeps every other failure line", () => {
    const credits = packChatOf(restPack({ status: "failed", error: JOB_ERROR_COPY.credits }));
    expect(credits.error).toBe(MCP_COPY.packStoppedForCredits);
    expect(credits.message).toBe(MCP_COPY.packStoppedForCredits);
    expect(packChatOf(restPack({ status: "failed", error: JOB_ERROR_COPY.cutout })).error).toBe(JOB_ERROR_COPY.cutout);
  });

  it("reports unavailable screening without labeling the product prohibited", () => {
    const chat = packChatOf(restPack({ status: "failed", error: JOB_ERROR_COPY.screeningUnavailable }));
    expect(chat.error).toBe(MCP_COPY.screeningUnavailable);
    expect(chat.message).toBe(MCP_COPY.screeningUnavailable);
    expect(chat.message).not.toBe(MCP_COPY.restrictedProduct);
  });
});

describe("estimate view builder", () => {
  it("says both numbers, whether they are enough, and why a channel is left out", () => {
    const view = EstimateChat.parse(
      estimateChatOf({
        creditsNeeded: 12,
        creditsAvailable: 40,
        channels: ["etsy.listing"],
        leftOut: [
          { specId: "amazon.secondary", reason: "not_made" },
          { specId: "tiktok.video", reason: "coming_soon" },
        ],
        quote: "q1.12.1.k.sig",
        quoteValidMinutes: 15,
      }),
    );
    expect(view).toEqual({
      credits_needed: 12,
      credits_available: 40,
      enough: true,
      channels: ["etsy.listing"],
      left_out: [
        { channel: "amazon.secondary", reason: MCP_COPY.channelNotMade },
        { channel: "tiktok.video", reason: MCP_COPY.channelComingSoon },
      ],
      quote: "q1.12.1.k.sig",
      quote_valid_minutes: 15,
      message: MCP_COPY.estimateReady(12, 40),
    });
    const short = estimateChatOf({ creditsNeeded: 12, creditsAvailable: 4, channels: [], leftOut: [], quote: "q", quoteValidMinutes: 15 });
    expect(short).toMatchObject({ enough: false, message: MCP_COPY.estimateShort(12, 4) });
  });
});

describe("list_channels for the chat (P19-18)", () => {
  const view = (plan: string) =>
    ChannelsChat.parse(channelsChatOf(listChannels({ caller: { principal: { plan } } as never }).body as never));

  it("takes every value from the registry and the seed", () => {
    const free = view("free");
    expect(free.channels.map((channel) => channel.id)).toEqual(
      CHANNEL_SPECS.filter((spec) => free.channels.some((channel) => channel.id === spec.specId)).map((spec) => spec.specId),
    );
    expect(free.backgrounds).toEqual(Object.entries(backgroundSwatches).map(([key, swatch]) => ({ key, label: swatch.label, hex: swatch.hex })));
    expect(free.scene_styles.map((style) => style.value)).toEqual(["auto", ...Object.keys(presets)]);
    expect(free.bundles.length).toBeGreaterThan(0);
    expect(free.aliases).toEqual([
      { alias: "instagram", channel: "meta" },
      { alias: "facebook", channel: "meta" },
    ]);
  });

  it("offers no background or scene choice while the output options switch is off", () => {
    const rest = listChannels({ caller: { principal: { plan: "free" } } as never }).body as never;
    const paused = ChannelsChat.parse(channelsChatOf(rest, { optionsOn: false }));
    expect(paused.backgrounds).toEqual([]);
    expect(paused.scene_styles).toEqual([]);
    expect(paused.channels).toEqual(view("free").channels);
    expect(ChannelsChat.parse(channelsChatOf(rest, { optionsOn: true })).backgrounds.length).toBeGreaterThan(0);
  });

  it("says what the plan includes without naming a plan to buy", () => {
    for (const plan of ["free", DEMO_TIER, "agency"]) {
      const channels = view(plan);
      const text = JSON.stringify(channels);
      for (const tier of tiers) {
        expect(new RegExp(`\\b${tierName(tier.key)}\\b`).test(text), `${plan}: ${tier.key}`).toBe(false);
        expect(text, `${plan}: ${tier.key}`).not.toContain(`"${tier.key}"`);
      }
      expect(text).not.toMatch(/upgrade|upgradeTo|availability/i);
      for (const channel of channels.channels) {
        expect(channel.available ? channel.note : channel.note === MCP_COPY.channelComingSoon || channel.note === MCP_COPY.channelNotInPlan).toBe(
          channel.available ? null : true,
        );
      }
    }
  });

  it("expands instagram and facebook to the live Meta specs, whatever the case", () => {
    const meta = CHANNEL_SPECS.filter((spec) => spec.status === "live" && spec.specId.startsWith("meta.")).map((spec) => spec.specId);
    expect(meta.length).toBeGreaterThan(0);
    expect(expandChannels(["instagram"])).toEqual({ channels: meta, unknown: [] });
    expect(expandChannels(["Facebook", "meta"])).toEqual({ channels: meta, unknown: [] });
    expect(expandChannels(["myspace"])).toEqual({ channels: [], unknown: ["myspace"] });
  });
});
