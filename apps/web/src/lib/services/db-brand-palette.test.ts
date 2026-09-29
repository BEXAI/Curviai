import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { members, workspaces } from "@curvi/db/schema";
import { createTestDb, type TestDb } from "@curvi/db/testing";
import type { Db } from "@curvi/db";
import type { BrandKitSuggestion } from "@curvi/pipeline/brand";
import type { BrandPaletteArgs, BrandPaletteRun } from "@curvi/trigger/brand-palette";
import { brandKitCopy } from "@/components/marketing/brand-kit-copy";
import { DbService } from "./db";

// docs/phases/PHASE_16.md workstream 7, service side: the logo palette runs
// only for editors on a plan with a brand kit, on a key in this workspace,
// after the upload check, and it never writes the brand kit.

const OWNER = "00000000-0000-4000-8000-0000000000b1";
const CLIENT = "00000000-0000-4000-8000-0000000000b3";

let client: Awaited<ReturnType<typeof createTestDb>>["client"];
let db: TestDb;
let ws: string;
let freeWs: string;
let otherWs: string;
let currentUser = OWNER;

const suggestion: BrandKitSuggestion = {
  colors: [
    {
      hex: "#1B2A4A",
      name: "blue",
      share: 0.6,
      text: { backgroundHex: "#1B2A4A", textHex: "#FFFFFF", ratio: 14.2, passes: true },
    },
  ],
  background: { hex: "#EEF1F7", text: { backgroundHex: "#EEF1F7", textHex: "#1B1F24", ratio: 14.9, passes: true } },
  source: "pixels",
  ambiguous: false,
};

function run(overrides: Partial<BrandPaletteRun> = {}): BrandPaletteRun {
  return { missing: false, unreadable: false, suggestion, askedVision: false, costMicros: 0, ...overrides };
}

let palette = vi.fn(async (_args: BrandPaletteArgs) => run());
let ingest = vi.fn(async () => ({ ok: true }) as never);

function service() {
  return new DbService({
    db: db as unknown as Db,
    getUserId: async () => currentUser,
    getSupabase: async () => null,
    ingestUpload: ingest,
    brandPalette: palette,
  });
}

async function kitCount(): Promise<number> {
  return (await db.query.brandKits.findMany()).length;
}

beforeAll(async () => {
  const created = await createTestDb();
  client = created.client;
  db = created.db;
  const [w] = await db.insert(workspaces).values({ name: "Brand", plan: "starter" }).returning();
  const [f] = await db.insert(workspaces).values({ name: "Free", plan: "free" }).returning();
  const [o] = await db.insert(workspaces).values({ name: "Other", plan: "starter" }).returning();
  ws = w.id;
  freeWs = f.id;
  otherWs = o.id;
  await db.insert(members).values([
    { workspaceId: ws, userId: OWNER, role: "owner" },
    { workspaceId: ws, userId: CLIENT, role: "client" },
    { workspaceId: freeWs, userId: OWNER, role: "owner" },
  ]);
}, 60_000);

afterAll(async () => {
  await client.close();
});

beforeEach(() => {
  currentUser = OWNER;
  palette = vi.fn(async (_args: BrandPaletteArgs) => run());
  ingest = vi.fn(async () => ({ ok: true }) as never);
});

describe("DbService.suggestBrandPalette", () => {
  it("returns the suggestion without saving the kit", async () => {
    const key = `ws/${ws}/src/logo.png`;
    const outcome = await service().suggestBrandPalette(ws, key);
    expect(outcome).toEqual({ ok: true, suggestion });
    expect(palette).toHaveBeenCalledTimes(1);
    expect(palette.mock.calls[0][0]).toMatchObject({ workspaceId: ws, logoKey: key });
    expect(ingest).toHaveBeenCalledWith(key, "image");
    expect(await kitCount()).toBe(0);
  });

  it("refuses a client seat and a key from another workspace before reading", async () => {
    currentUser = CLIENT;
    expect(await service().suggestBrandPalette(ws, `ws/${ws}/src/logo.png`)).toMatchObject({ ok: false, reason: "forbidden" });
    currentUser = OWNER;
    for (const key of [`ws/${otherWs}/src/logo.png`, `ws/${ws}/src/../../${otherWs}/src/logo.png`, "logo.png"]) {
      expect(await service().suggestBrandPalette(ws, key)).toEqual({
        ok: false,
        reason: "foreign_key",
        notice: brandKitCopy.paletteMissing,
      });
    }
    expect(palette).not.toHaveBeenCalled();
  });

  it("asks a Free workspace to upgrade instead of spending on its logo", async () => {
    const outcome = await service().suggestBrandPalette(freeWs, `ws/${freeWs}/src/logo.png`);
    expect(outcome).toMatchObject({ ok: false, reason: "upgrade_required" });
    expect(palette).not.toHaveBeenCalled();
  });

  it("refuses an upload that fails the server side check", async () => {
    ingest = vi.fn(async () => ({ ok: false, retryable: false, notice: "That file is not an image." }) as never);
    const outcome = await service().suggestBrandPalette(ws, `ws/${ws}/src/logo.png`);
    expect(outcome).toEqual({ ok: false, reason: "invalid_upload", notice: "That file is not an image." });
    expect(palette).not.toHaveBeenCalled();
  });

  it("maps a logo with no colors, an unreadable file and a runner failure to plain notices", async () => {
    const key = `ws/${ws}/src/logo.png`;
    palette = vi.fn(async () => run({ suggestion: { ...suggestion, colors: [] } }));
    expect(await service().suggestBrandPalette(ws, key)).toEqual({
      ok: false,
      reason: "no_colors",
      notice: brandKitCopy.paletteNoColors,
    });
    palette = vi.fn(async () => run({ unreadable: true, suggestion: null }));
    expect(await service().suggestBrandPalette(ws, key)).toMatchObject({ ok: false, reason: "invalid_upload" });
    palette = vi.fn(async () => {
      throw new Error("worker down");
    });
    expect(await service().suggestBrandPalette(ws, key)).toEqual({
      ok: false,
      reason: "unavailable",
      notice: brandKitCopy.paletteUnavailable,
    });
    expect(await kitCount()).toBe(0);
  });
});
