import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Services } from "@/lib/services/types";
import { MemoryRateLimitStore, RATE_LIMIT_POLICIES, setRateLimitStoreForTests } from "@/lib/rate-limit";
import { TEST_WORKSPACE_ID, createFakeServices } from "@/lib/testing/fake-services";

let services: Services;
let sessionUserId: string | null = null;

vi.mock("@/lib/services", () => ({
  getServices: () => services,
}));

vi.mock("@/lib/supabase/server", () => ({
  getSessionUser: async () => (sessionUserId ? { id: sessionUserId } : null),
  createSupabaseServerClient: async () => null,
}));

const { saveBrandKitAction, suggestBrandPaletteAction } = await import("./actions");

const valid = {
  name: "House style",
  colors: ["#1D2433"],
  fonts: { heading: "Inter", body: "Inter" },
  stylePreset: "minimal_studio",
  hasLogo: true,
  logoUrl: "https://signed.example.com/logo.png?sig=abc",
  logoKey: `ws/${TEST_WORKSPACE_ID}/src/logo.png`,
};

beforeEach(() => {
  services = createFakeServices("editor");
  sessionUserId = null;
});

describe("saveBrandKitAction (Update.md 4.2)", () => {
  it("parses the kit and forwards only known fields", async () => {
    const result = await saveBrandKitAction(valid);
    expect(result.ok).toBe(true);
    expect(services.saveBrandKit).toHaveBeenCalledWith(TEST_WORKSPACE_ID, {
      name: "House style",
      colors: ["#1D2433"],
      // "Inter" is the default font's label, stored as the default ("").
      fonts: { heading: "", body: "" },
      stylePreset: "minimal_studio",
      logoKey: `ws/${TEST_WORKSPACE_ID}/src/logo.png`,
      hasLogo: true,
    });
  });

  it.each([
    [{ ...valid, stylePreset: "not_a_preset" }, "Pick a style preset from the list."],
    [{ ...valid, colors: Array.from({ length: 7 }, () => "#000000") }, "Colors must look like #1D2433, with up to 6 colors."],
    [{ ...valid, colors: ["javascript:alert(1)"] }, "Colors must look like #1D2433, with up to 6 colors."],
    [{ ...valid, name: "x".repeat(81) }, "Kit names and fonts must be 80 characters or fewer, with no special characters."],
    [{ ...valid, fonts: { heading: "<script>", body: "Inter" } }, "Kit names and fonts must be 80 characters or fewer, with no special characters."],
    [{ ...valid, logoKey: "k".repeat(513) }, "That logo upload could not be used. Upload it again."],
    [{ ...valid, fonts: { heading: "Comic Sans", body: "" } }, "Pick a font from the list."],
    ["not an object", "Check the brand kit fields and try again."],
  ])("rejects a malformed kit without reaching the service", async (input, notice) => {
    const result = await saveBrandKitAction(input);
    expect(result).toEqual({ ok: false, notice });
    expect(services.saveBrandKit).not.toHaveBeenCalled();
  });

  it("keeps catalog font keys and accepts the automatic style preset", async () => {
    await saveBrandKitAction({ ...valid, fonts: { heading: "playfair_display", body: "Lora" }, stylePreset: "auto" });
    const saved = vi.mocked(services.saveBrandKit).mock.calls[0][1];
    expect(saved.fonts).toEqual({ heading: "playfair_display", body: "lora" });
    expect(saved.stylePreset).toBe("auto");
  });

  it("defaults an empty kit name", async () => {
    await saveBrandKitAction({ ...valid, name: "   " });
    expect(vi.mocked(services.saveBrandKit).mock.calls[0][1].name).toBe("Default");
  });

  it("asks a signed out visitor to sign in", async () => {
    services = createFakeServices(null);
    expect(await saveBrandKitAction(valid)).toEqual({ ok: false, notice: "Sign in to save the brand kit." });
  });
});

describe("suggestBrandPaletteAction (PHASE_16 workstream 7)", () => {
  const key = `ws/${TEST_WORKSPACE_ID}/src/logo.png`;

  beforeEach(() => {
    setRateLimitStoreForTests(new MemoryRateLimitStore());
  });

  it("forwards the logo key and never saves the kit", async () => {
    await suggestBrandPaletteAction(key);
    expect(services.suggestBrandPalette).toHaveBeenCalledWith(TEST_WORKSPACE_ID, key);
    expect(services.saveBrandKit).not.toHaveBeenCalled();
  });

  it.each([[null], [""], [42], ["k".repeat(513)]])("asks for a logo when the key is %j", async (input) => {
    const result = await suggestBrandPaletteAction(input);
    expect(result).toEqual({ ok: false, reason: "foreign_key", notice: "Upload a logo first." });
    expect(services.suggestBrandPalette).not.toHaveBeenCalled();
  });

  it("asks a signed out visitor to sign in", async () => {
    services = createFakeServices(null);
    expect(await suggestBrandPaletteAction(key)).toEqual({
      ok: false,
      reason: "forbidden",
      notice: "Sign in to edit the brand kit.",
    });
  });

  it("rate limits repeated reads", async () => {
    const limit = RATE_LIMIT_POLICIES["brand.palette"].user.limit;
    for (let i = 0; i < limit; i++) {
      await suggestBrandPaletteAction(key);
    }
    expect(await suggestBrandPaletteAction(key)).toMatchObject({ ok: false, reason: "rate_limited" });
    expect(services.suggestBrandPalette).toHaveBeenCalledTimes(limit);
  });

  it("holds the same budget per workspace, so extra seats cannot multiply the vision calls", async () => {
    const limit = RATE_LIMIT_POLICIES["brand.palette"].user.limit;
    for (let i = 0; i < limit; i++) {
      sessionUserId = `user-${i % 3}`;
      expect(await suggestBrandPaletteAction(key)).not.toMatchObject({ reason: "rate_limited" });
    }
    sessionUserId = "user-fresh";
    expect(await suggestBrandPaletteAction(key)).toMatchObject({ ok: false, reason: "rate_limited" });
    expect(services.suggestBrandPalette).toHaveBeenCalledTimes(limit);
  });

  it("refuses a client seat before counting, so it cannot use up the workspace budget", async () => {
    const limit = RATE_LIMIT_POLICIES["brand.palette"].user.limit;
    services = createFakeServices("client");
    for (let i = 0; i <= limit; i++) {
      expect(await suggestBrandPaletteAction(key)).toEqual({
        ok: false,
        reason: "forbidden",
        notice: "Only owners, admins and editors can change the brand kit.",
      });
    }
    expect(services.suggestBrandPalette).not.toHaveBeenCalled();
    services = createFakeServices("owner");
    expect(await suggestBrandPaletteAction(key)).not.toMatchObject({ reason: "rate_limited" });
    expect(services.suggestBrandPalette).toHaveBeenCalledTimes(1);
  });
});
