import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  assetVariants,
  assets,
  creditLedger,
  generationJobs,
  members,
  packClaims,
  products,
  signupAttributions,
  sourceMedia,
  workspaces,
} from "@curvi/db/schema";
import { createTestDb, type TestDb } from "@curvi/db/testing";
import { eq, loadChannelSpecs, recordFunnelEvent, type Db } from "@curvi/db";
import { prospectClaims, staffMonthlyCreditCap } from "@curvi/pipeline/seed";
import type { CreateJobInput, JobView, Services } from "@/lib/services/types";
import { composeFunnelDigest } from "@/lib/funnel-digest";
import { loadFunnelReport } from "@/lib/funnel-report";
import { DbShareStore } from "@/lib/shares/db-store";
import { addProspectCredits, prospectCreditsUsed } from "./credits";
import { buildOutreachKit, measureMainImage } from "./kit";
import type { OperatorContext } from "./operator";
import { claimedPhotoKey, redeemProspectClaim, type ClaimStorage } from "./claim";
import { createProspectPack, makeClaimLink, prospectsWithPublishing, specsForChannels } from "./service";
import {
  currentClaimLink,
  insertProspectClaim,
  isProspectJob,
  issueClaimLink,
  listProspects,
  prospectCampaign,
  prospectViewForSlug,
  takeDownByToken,
} from "./store";
import { hashClaimToken } from "./token";

// The prospect makeover tool (docs/phases/PHASE_18.md P18-04) against the
// real migrations in PGlite: the claim token is hashed and single use, an
// expired or taken down claim cannot be redeemed, a claim attributes the
// signup and copies the product with no extra credits (decision 11), the
// share page is link only with proof on (decision 9), and prospect credits
// stay under the seeded monthly cap.

let client: Awaited<ReturnType<typeof createTestDb>>["client"];
let db: TestDb;
const owner = () => db as unknown as Db;

const OPERATOR = "00000000-0000-4000-8000-00000000f401";
const PROSPECT = "00000000-0000-4000-8000-00000000f402";
const OTHER = "00000000-0000-4000-8000-00000000f403";
const NOW = new Date("2026-10-05T12:00:00Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);

class MemoryStorage implements ClaimStorage {
  readonly objects = new Map<string, Buffer>();
  async get(key: string) {
    return this.objects.get(key) ?? null;
  }
  async put(key: string, body: Buffer) {
    this.objects.set(key, body);
  }
}

async function workspaceFor(userId: string, name: string): Promise<string> {
  const [w] = await db.insert(workspaces).values({ name }).returning();
  await db.insert(members).values({ workspaceId: w.id, userId, role: "owner" });
  return w.id;
}

let staffWs: string;
let storage: MemoryStorage;

/** A finished prospect pack in the operator's workspace, with its photo and one delivered file. */
async function prospectPack(label: string, status: "done" | "generating" = "done") {
  const [p] = await db.insert(products).values({ workspaceId: staffWs, title: `${label} candle`, mode: "listing" }).returning();
  const photoKey = `ws/${staffWs}/src/${label.replace(/\W/g, "")}.png`;
  await db.insert(sourceMedia).values({
    workspaceId: staffWs,
    productId: p.id,
    r2Key: photoKey,
    kind: "image",
    sha256: "a".repeat(64),
    createdAt: new Date(NOW.getTime() - 60_000),
  });
  storage.objects.set(photoKey, PNG);
  const [job] = await db
    .insert(generationJobs)
    .values({ workspaceId: staffWs, productId: p.id, status, creditsCharged: 8, createdAt: NOW })
    .returning();
  const [asset] = await db.insert(assets).values({ workspaceId: staffWs, jobId: job.id, shotType: "amazon_main" }).returning();
  await db.insert(assetVariants).values({
    workspaceId: staffWs,
    assetId: asset.id,
    channelSpecId: "amazon.main",
    r2Key: `ws/${staffWs}/out/${job.id}/main.jpg`,
    filename: "MAIN.jpg",
    width: 2000,
    height: 2000,
  });
  const claim = await insertProspectClaim(owner(), {
    jobId: job.id,
    staffWorkspaceId: staffWs,
    label,
    productSourceUrl: "https://shop.example/products/candle",
    now: NOW,
  });
  return { jobId: job.id, productId: p.id, claimId: claim.id, photoKey };
}

async function publish(jobId: string): Promise<string> {
  const result = await new DbShareStore(owner()).publish({ id: staffWs, role: "owner" }, jobId, {
    kind: "pack",
    gallery: false,
    proof: true,
  });
  if (!result.ok || !result.status.slug) throw new Error("publish failed");
  return result.status.slug;
}

beforeAll(async () => {
  const created = await createTestDb();
  client = created.client;
  db = created.db;
  await loadChannelSpecs(owner());
  storage = new MemoryStorage();
  staffWs = await workspaceFor(OPERATOR, "Founder");
});

afterAll(async () => {
  await client.close();
});

describe("claim links", () => {
  it("store only the token's hash, and a new link replaces the old one", async () => {
    const pack = await prospectPack("Juniper Candles");
    const [row] = await db.select().from(packClaims).where(eq(packClaims.id, pack.claimId));
    expect(row.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.expiresAt.getTime()).toBe(NOW.getTime() + prospectClaims.lifetimeDays * DAY_MS);

    const first = await issueClaimLink(owner(), { claimId: pack.claimId, staffWorkspaceId: staffWs, now: NOW });
    if (!first.ok) throw new Error("no link");
    expect(first.token).toMatch(/^[0-9a-f]{40}$/);
    const [stored] = await db.select().from(packClaims).where(eq(packClaims.id, pack.claimId));
    expect(stored.tokenHash).toBe(hashClaimToken(first.token));
    expect(stored.tokenHash).not.toContain(first.token);

    const slug = await publish(pack.jobId);
    const live = await prospectViewForSlug(owner(), { slug, token: first.token, now: NOW });
    expect(live).toEqual({ store: "Juniper Candles", claimToken: first.token, takedownToken: first.token });

    const second = await issueClaimLink(owner(), { claimId: pack.claimId, staffWorkspaceId: staffWs, now: NOW });
    if (!second.ok) throw new Error("no link");
    const stale = await prospectViewForSlug(owner(), { slug, token: first.token, now: NOW });
    expect(stale).toEqual({ store: "Juniper Candles", claimToken: null, takedownToken: null });
    // Without a token the page still knows it is a prospect pack (the title).
    expect(await prospectViewForSlug(owner(), { slug, token: null, now: NOW })).toMatchObject({ claimToken: null });
    // Expired: no claim, but the takedown still works with the link.
    const later = new Date(NOW.getTime() + (prospectClaims.lifetimeDays + 1) * DAY_MS);
    expect(await prospectViewForSlug(owner(), { slug, token: second.token, now: later })).toMatchObject({
      claimToken: null,
      takedownToken: second.token,
    });
    // Another workspace cannot make a link for it.
    expect(await issueClaimLink(owner(), { claimId: pack.claimId, staffWorkspaceId: await workspaceFor(OTHER, "Other"), now: NOW })).toEqual({
      ok: false,
      reason: "not_found",
    });
  });

  it("with the link secret, can be shown again for the kit without replacing the link the prospect has", async () => {
    const SECRET = "s".repeat(48);
    const pack = await prospectPack("Moss Lane");
    // A claim with no link made yet shows none.
    expect(await currentClaimLink(owner(), { claimId: pack.claimId, staffWorkspaceId: staffWs, now: NOW, secret: SECRET })).toBeNull();

    const first = await issueClaimLink(owner(), { claimId: pack.claimId, staffWorkspaceId: staffWs, now: NOW, secret: SECRET });
    if (!first.ok) throw new Error("no link");
    expect(first.token).toMatch(/^[0-9a-f]{40}$/);
    const [stored] = await db.select().from(packClaims).where(eq(packClaims.id, pack.claimId));
    expect(stored.tokenHash).toBe(hashClaimToken(first.token));
    expect(stored.tokenHash).not.toContain(first.token);
    // Shown again, as often as asked: the same token, and the hash is unchanged.
    for (let i = 0; i < 2; i += 1) {
      expect(await currentClaimLink(owner(), { claimId: pack.claimId, staffWorkspaceId: staffWs, now: NOW, secret: SECRET })).toEqual({
        token: first.token,
        expiresAt: first.expiresAt,
      });
    }
    const [unchanged] = await db.select().from(packClaims).where(eq(packClaims.id, pack.claimId));
    expect(unchanged.tokenHash).toBe(stored.tokenHash);

    // A new link at the same instant still replaces the old one.
    const second = await issueClaimLink(owner(), { claimId: pack.claimId, staffWorkspaceId: staffWs, now: NOW, secret: SECRET });
    if (!second.ok) throw new Error("no link");
    expect(second.token).not.toBe(first.token);
    expect(await currentClaimLink(owner(), { claimId: pack.claimId, staffWorkspaceId: staffWs, now: NOW, secret: SECRET })).toMatchObject({
      token: second.token,
    });
    // Another secret, no secret, another workspace, or past the expiry: nothing to show.
    expect(await currentClaimLink(owner(), { claimId: pack.claimId, staffWorkspaceId: staffWs, now: NOW, secret: "t".repeat(48) })).toBeNull();
    expect(await currentClaimLink(owner(), { claimId: pack.claimId, staffWorkspaceId: staffWs, now: NOW, secret: null })).toBeNull();
    expect(
      await currentClaimLink(owner(), { claimId: pack.claimId, staffWorkspaceId: await workspaceFor(OTHER, "Other"), now: NOW, secret: SECRET }),
    ).toBeNull();
    const later = new Date(NOW.getTime() + (prospectClaims.lifetimeDays + 1) * DAY_MS);
    expect(await currentClaimLink(owner(), { claimId: pack.claimId, staffWorkspaceId: staffWs, now: later, secret: SECRET })).toBeNull();
  });

  it("keep a prospect page out of the gallery whatever the share panel asks", async () => {
    const pack = await prospectPack("Oak Soap Co");
    expect(await isProspectJob(owner(), pack.jobId)).toBe(true);
    const result = await new DbShareStore(owner()).publish({ id: staffWs, role: "owner" }, pack.jobId, {
      kind: "pack",
      gallery: true,
    });
    expect(result.ok && result.status.inGallery).toBe(false);
  });
});

describe("redeeming a claim at signup", () => {
  it("copies the product into the new workspace once, attributes the signup, and adds no credits", async () => {
    const pack = await prospectPack("Fern & Wick");
    await publish(pack.jobId);
    const link = await issueClaimLink(owner(), { claimId: pack.claimId, staffWorkspaceId: staffWs, now: NOW });
    if (!link.ok) throw new Error("no link");
    const prospectWs = await workspaceFor(PROSPECT, "Prospect");
    await db.insert(signupAttributions).values({ userId: PROSPECT, workspaceId: prospectWs, source: "concierge", claimId: null });
    await recordFunnelEvent(owner(), { workspaceId: prospectWs, name: "signup_confirmed", props: { source: "concierge" } });
    const ledgerBefore = await db.select().from(creditLedger).where(eq(creditLedger.workspaceId, prospectWs));

    const deps = { db: owner(), storage, now: () => NOW };
    const result = await redeemProspectClaim(deps, { token: link.token, userId: PROSPECT });
    if (result.kind !== "claimed") throw new Error(`refused ${JSON.stringify(result)}`);
    expect(result.workspaceId).toBe(prospectWs);

    const [product] = await db.select().from(products).where(eq(products.id, result.productId));
    expect(product).toMatchObject({ workspaceId: prospectWs, title: "Fern & Wick candle", mode: "listing" });
    const [media] = await db.select().from(sourceMedia).where(eq(sourceMedia.productId, result.productId));
    expect(media.r2Key).toBe(claimedPhotoKey(prospectWs, pack.claimId, "png"));
    expect(storage.objects.get(media.r2Key)?.equals(PNG)).toBe(true);

    const [attribution] = await db.select().from(signupAttributions).where(eq(signupAttributions.userId, PROSPECT));
    expect(attribution).toMatchObject({ source: "concierge", utmCampaign: "fern-wick", claimId: pack.claimId });
    const events = await client.query<{ name: string; props: Record<string, unknown> }>(
      "select name, props from events where workspace_id = $1 order by id",
      [prospectWs],
    );
    expect(events.rows.find((e) => e.name === "funnel.signup_confirmed")?.props).toMatchObject({
      source: "concierge",
      utm_campaign: "fern-wick",
    });
    expect(events.rows.find((e) => e.name === "funnel.claim_redeemed")?.props).toEqual({ campaign: "fern-wick" });

    // No extra credits (decision 11).
    const ledgerAfter = await db.select().from(creditLedger).where(eq(creditLedger.workspaceId, prospectWs));
    expect(ledgerAfter).toHaveLength(ledgerBefore.length);

    // Single use: the same account gets the same product back; anyone else is refused.
    expect(await redeemProspectClaim(deps, { token: link.token, userId: PROSPECT })).toEqual({
      kind: "already",
      productId: result.productId,
      workspaceId: prospectWs,
    });
    await workspaceFor(OTHER, "Late");
    expect(await redeemProspectClaim(deps, { token: link.token, userId: OTHER })).toEqual({ kind: "refused", reason: "taken" });
    // A claimed pack gets no new link.
    expect(await issueClaimLink(owner(), { claimId: pack.claimId, staffWorkspaceId: staffWs, now: NOW })).toEqual({
      ok: false,
      reason: "claimed",
    });
  });

  it("refuses an expired, a taken down, an unknown and the operator's own claim", async () => {
    const deps = { db: owner(), storage, now: () => NOW };
    const user = "00000000-0000-4000-8000-00000000f404";
    await workspaceFor(user, "Late prospect");

    const expiring = await prospectPack("Expired Co");
    const old = await issueClaimLink(owner(), { claimId: expiring.claimId, staffWorkspaceId: staffWs, now: new Date(NOW.getTime() - 40 * DAY_MS) });
    if (!old.ok) throw new Error("no link");
    expect(await redeemProspectClaim(deps, { token: old.token, userId: user })).toEqual({ kind: "refused", reason: "expired" });

    const removed = await prospectPack("Removed Co");
    const slug = await publish(removed.jobId);
    const link = await issueClaimLink(owner(), { claimId: removed.claimId, staffWorkspaceId: staffWs, now: NOW });
    if (!link.ok) throw new Error("no link");
    expect(await takeDownByToken(owner(), { token: link.token, now: NOW })).toBe("taken_down");
    expect(await takeDownByToken(owner(), { token: link.token, now: NOW })).toBe("already");
    expect(await redeemProspectClaim(deps, { token: link.token, userId: user })).toEqual({ kind: "refused", reason: "taken_down" });
    expect(await prospectViewForSlug(owner(), { slug, token: link.token, now: NOW })).toBeNull();
    const [share] = await client.query<{ is_public: boolean }>("select public as is_public from share_links where slug = $1", [slug]).then((r) => r.rows);
    expect(share.is_public).toBe(false);
    expect(await new DbShareStore(owner()).getPublic(slug)).toBeNull();
    const takedowns = await client.query("select 1 from events where workspace_id = $1 and name = 'funnel.claim_taken_down'", [staffWs]);
    expect(takedowns.rows).toHaveLength(1);

    expect(await redeemProspectClaim(deps, { token: "f".repeat(40), userId: user })).toEqual({ kind: "refused", reason: "not_found" });
    expect(await redeemProspectClaim(deps, { token: "not a token", userId: user })).toEqual({ kind: "refused", reason: "not_found" });
    expect(await takeDownByToken(owner(), { token: "f".repeat(40), now: NOW })).toBe("not_found");

    const own = await prospectPack("Own Co");
    const ownLink = await issueClaimLink(owner(), { claimId: own.claimId, staffWorkspaceId: staffWs, now: NOW });
    if (!ownLink.ok) throw new Error("no link");
    expect(await redeemProspectClaim(deps, { token: ownLink.token, userId: OPERATOR })).toEqual({ kind: "refused", reason: "not_found" });
  });

  it("refuses when the listing photo is gone", async () => {
    const pack = await prospectPack("Gone Photo Co");
    storage.objects.delete(pack.photoKey);
    const link = await issueClaimLink(owner(), { claimId: pack.claimId, staffWorkspaceId: staffWs, now: NOW });
    if (!link.ok) throw new Error("no link");
    const user = "00000000-0000-4000-8000-00000000f405";
    await workspaceFor(user, "Photo less");
    expect(await redeemProspectClaim({ db: owner(), storage, now: () => NOW }, { token: link.token, userId: user })).toEqual({
      kind: "refused",
      reason: "missing_files",
    });
    const [claim] = await db.select().from(packClaims).where(eq(packClaims.id, pack.claimId));
    expect(claim.claimedAt).toBeNull();
  });
});

describe("prospect credits", () => {
  it("grant system credits up to the seeded monthly cap, counted per calendar month", async () => {
    const ws = await workspaceFor("00000000-0000-4000-8000-00000000f406", "Credits");
    const add = (credits: number, now = NOW) =>
      addProspectCredits(owner(), { workspaceId: ws, userId: OPERATOR, credits, now });
    expect(await add(0)).toEqual({ outcome: "invalid" });
    expect(await add(prospectClaims.maxCreditsPerAdd + 1)).toEqual({ outcome: "invalid" });
    expect(await add(1.5)).toEqual({ outcome: "invalid" });

    let added = 0;
    while (added + prospectClaims.maxCreditsPerAdd <= staffMonthlyCreditCap) {
      expect((await add(prospectClaims.maxCreditsPerAdd)).outcome).toBe("added");
      added += prospectClaims.maxCreditsPerAdd;
    }
    const over = await add(staffMonthlyCreditCap - added + 1);
    expect(over).toMatchObject({ outcome: "over_cap", left: staffMonthlyCreditCap - added });
    expect(await prospectCreditsUsed(owner(), ws, NOW)).toBe(added);

    const ledger = await db.select().from(creditLedger).where(eq(creditLedger.workspaceId, ws));
    expect(ledger.every((row) => row.reason === "grant" && row.source === "system")).toBe(true);
    expect(ledger.reduce((sum, row) => sum + Number(row.delta), 0)).toBe(added);

    // A new month starts a new cap.
    expect((await add(10, new Date("2026-11-01T00:00:01Z"))).outcome).toBe("added");
  });

  it("never let two additions at once pass the cap together", async () => {
    const ws = await workspaceFor("00000000-0000-4000-8000-00000000f407", "Race");
    const half = Math.min(prospectClaims.maxCreditsPerAdd, Math.ceil(staffMonthlyCreditCap / 2) + 1);
    const adds = Array.from({ length: Math.ceil(staffMonthlyCreditCap / half) + 2 }, () =>
      addProspectCredits(owner(), { workspaceId: ws, userId: OPERATOR, credits: half, now: NOW }),
    );
    await Promise.all(adds);
    expect(await prospectCreditsUsed(owner(), ws, NOW)).toBeLessThanOrEqual(staffMonthlyCreditCap);
  });
});

function operatorContext(services: Partial<Services>): OperatorContext {
  return {
    db: owner(),
    services: services as Services,
    workspace: { id: staffWs, name: "Founder", plan: "growth", creditBalance: 100, role: "owner" } as OperatorContext["workspace"],
    userId: OPERATOR,
  };
}

describe("making a prospect pack", () => {
  it("goes through createJob with the channels' specs and records the claim once", async () => {
    const created: CreateJobInput[] = [];
    let jobId = "";
    const services: Partial<Services> = {
      createJob: vi.fn(async (_ws: string, input: CreateJobInput) => {
        created.push(input);
        if (!jobId) {
          const [p] = await db.insert(products).values({ workspaceId: staffWs, title: input.newProductTitle ?? "x", mode: "listing" }).returning();
          const [job] = await db.insert(generationJobs).values({ workspaceId: staffWs, productId: p.id }).returning();
          jobId = job.id;
          return { outcome: "created" as const, job: { id: job.id } as JobView };
        }
        return { outcome: "replayed" as const, job: { id: jobId } as JobView };
      }),
    };
    const ctx = operatorContext(services);
    const input = {
      store: "  Lumen   Tea  ",
      productUrl: "https://lumen.example/products/tea",
      title: "Earl Grey tin",
      note: "Loose leaf",
      channels: ["amazon", "shopify"],
      upload: { key: `ws/${staffWs}/src/tea.jpg`, sha256: "b".repeat(64), kind: "image" as const },
      idempotencyKey: "abcdef123456",
    };
    const first = await createProspectPack(ctx, input, NOW);
    if (!first.ok) throw new Error(first.error);
    expect(first.created).toBe(true);
    expect(first.prospect).toMatchObject({ label: "Lumen Tea", state: "making", productSourceUrl: "https://lumen.example/products/tea" });
    expect(created[0]).toMatchObject({
      productId: "new",
      mode: "listing",
      channels: specsForChannels(["amazon", "shopify"]),
      newProductTitle: "Earl Grey tin",
      userDescription: "Loose leaf",
      origin: "import",
      idempotencyKey: "prospect:abcdef123456",
    });
    const again = await createProspectPack(ctx, input, NOW);
    expect(again.ok && again.created).toBe(false);
    const made = await client.query("select 1 from events where workspace_id = $1 and name = 'funnel.prospect_pack_made'", [staffWs]);
    expect(made.rows).toHaveLength(1);
  });

  it("refuses a missing store name, another workspace's upload, a plain http link and an empty balance", async () => {
    const services: Partial<Services> = {
      createJob: vi.fn(async () => ({ outcome: "rejected" as const, reason: "insufficient_credits" as const, message: "Not enough credits." })),
    };
    const ctx = operatorContext(services);
    const base = {
      store: "Shop",
      channels: ["amazon"],
      upload: { key: `ws/${staffWs}/src/a.jpg`, sha256: "c".repeat(64), kind: "image" as const },
      idempotencyKey: "abcdef654321",
    };
    expect(await createProspectPack(ctx, { ...base, store: "   " })).toMatchObject({ ok: false, status: 400 });
    expect(
      await createProspectPack(ctx, { ...base, upload: { ...base.upload, key: "ws/00000000-0000-4000-8000-000000000000/src/a.jpg" } }),
    ).toMatchObject({ ok: false, status: 403 });
    expect(await createProspectPack(ctx, { ...base, productUrl: "http://shop.example/p" })).toMatchObject({ ok: false, status: 400 });
    expect(await createProspectPack(ctx, base)).toMatchObject({ ok: false, status: 402, reason: "insufficient_credits" });
  });
});

describe("publishing and the outreach kit", () => {
  it("publishes a finished prospect pack link only with proof on, then makes the link and kit", async () => {
    const pack = await prospectPack("Kit Co");
    const ctx = operatorContext({});
    const shares = new DbShareStore(owner());
    const rows = await prospectsWithPublishing(ctx, shares, NOW);
    const row = rows.find((r) => r.id === pack.claimId)!;
    expect(row).toMatchObject({ state: "ready", sharePublished: true });
    const share = await client.query<{ show_proof: boolean; kind: string }>("select show_proof, kind from share_links where job_id = $1", [pack.jobId]);
    expect(share.rows).toEqual([{ show_proof: true, kind: "pack" }]);
    const gallery = await client.query("select 1 from gallery_items where share_slug = $1 and published", [row.shareSlug]);
    expect(gallery.rows).toHaveLength(0);

    const decode = vi.fn(async () => {
      // 10 by 10, white with a 5 by 5 dark product in the middle.
      const data = new Uint8Array(10 * 10 * 4).fill(255);
      for (let y = 3; y < 8; y++) for (let x = 3; x < 8; x++) data.fill(20, (y * 10 + x) * 4, (y * 10 + x) * 4 + 3);
      return { data, width: 10, height: 10, naturalWidth: 1600, naturalHeight: 1600 };
    });
    const kit = await buildOutreachKit({ db: owner(), get: (key) => storage.get(key), decode }, { claimId: pack.claimId, staffWorkspaceId: staffWs });
    expect(kit).toMatchObject({ store: "Kit Co", productTitle: "Kit Co candle" });
    expect(kit?.check?.whitePercent).toBe(100);
    expect(kit?.check?.fillPercent).toBe(50);
    expect(kit?.fidelity.deliveredFiles).toBeGreaterThanOrEqual(0);

    const result = await makeClaimLink(ctx, shares, { claimId: pack.claimId, origin: "https://curvi.ai/", get: (key) => storage.get(key), now: NOW });
    if (!result.ok) throw new Error(result.error);
    const url = new URL(result.link);
    expect(url.origin).toBe("https://curvi.ai");
    expect(url.pathname).toBe(`/s/${row.shareSlug}`);
    const token = url.searchParams.get("claim")!;
    expect(await prospectViewForSlug(owner(), { slug: row.shareSlug!, token, now: NOW })).toMatchObject({ claimToken: token });
  });

  it("refuses a link for a pack still being made", async () => {
    const pack = await prospectPack("Busy Co", "generating");
    const result = await makeClaimLink(operatorContext({}), new DbShareStore(owner()), {
      claimId: pack.claimId,
      origin: "https://curvi.ai",
      get: (key) => storage.get(key),
      now: NOW,
    });
    expect(result).toMatchObject({ ok: false, status: 409, reason: "not_ready" });
    const rows = await listProspects(owner(), staffWs, NOW);
    expect(rows.find((r) => r.id === pack.claimId)?.state).toBe("making");
  });

  it("measures a photo it cannot decode as unmeasured", async () => {
    expect(await measureMainImage(PNG, async () => Promise.reject(new Error("bad")))).toBeNull();
  });
});

describe("prospect labels as campaigns", () => {
  it("slug the store name for utm_campaign", () => {
    expect(prospectCampaign("Fern & Wick")).toBe("fern-wick");
    expect(prospectCampaign("  Lumen   Tea ")).toBe("lumen-tea");
    expect(prospectCampaign("!!!")).toBeNull();
  });
});

describe("the weekly funnel email", () => {
  it("counts the claimed signup and lists it by store", async () => {
    const report = await loadFunnelReport(owner(), { now: new Date(Date.now() + 1000) });
    expect(report.claims).toContainEqual({ label: "fern-wick", count: 1 });
    expect(report.since.claimsRedeemed).toBeGreaterThanOrEqual(1);
    expect(report.since.byPageSource).toContainEqual({ label: "concierge", count: 1 });
    expect(composeFunnelDigest(report).text).toMatch(/Prospect claims by store[^\n]*\n[^\n]*\n[^\n]*fern-wick\s+1/);
  });
});
