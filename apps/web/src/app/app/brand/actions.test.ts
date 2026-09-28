import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Services } from "@/lib/services/types";
import { TEST_WORKSPACE_ID, createFakeServices } from "@/lib/testing/fake-services";

let services: Services;

vi.mock("@/lib/services", () => ({
  getServices: () => services,
}));

const { saveBrandKitAction } = await import("./actions");

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
});

describe("saveBrandKitAction (Update.md 4.2)", () => {
  it("parses the kit and forwards only known fields", async () => {
    const result = await saveBrandKitAction(valid);
    expect(result.ok).toBe(true);
    expect(services.saveBrandKit).toHaveBeenCalledWith(TEST_WORKSPACE_ID, {
      name: "House style",
      colors: ["#1D2433"],
      fonts: { heading: "Inter", body: "Inter" },
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
    ["not an object", "Check the brand kit fields and try again."],
  ])("rejects a malformed kit without reaching the service", async (input, notice) => {
    const result = await saveBrandKitAction(input);
    expect(result).toEqual({ ok: false, notice });
    expect(services.saveBrandKit).not.toHaveBeenCalled();
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
