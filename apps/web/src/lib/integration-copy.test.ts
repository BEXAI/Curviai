import { describe, expect, it } from "vitest";
import { rule9Problems } from "@curvi/pipeline";
import { unqualifiedClaims } from "@/lib/marketing-facts";
import { AMAZON_NOT_CONNECTED, SHOPIFY_NOT_CONNECTED } from "./integration-copy";
import { DemoService, DemoStore } from "./services/demo";

// docs/phases/PHASE_20.md P20-08: the settings Shopify row sells nothing that
// does not run and links to help until P20-26's Shopify article ships.

describe("settings integration rows", () => {
  it("says the Shopify app is on the way and links to help", () => {
    expect(SHOPIFY_NOT_CONNECTED.detail).toBe(
      "The Shopify app is on the way. Your packs already use Shopify ready file names.",
    );
    expect(SHOPIFY_NOT_CONNECTED.link?.href).toBe("/help/upload-images-to-shopify");
  });

  it("keeps the copy plain and promises no auto packs", () => {
    for (const row of [SHOPIFY_NOT_CONNECTED, AMAZON_NOT_CONNECTED]) {
      expect(rule9Problems(row.detail)).toEqual([]);
      expect(row.detail).not.toMatch(/auto packs?/i);
    }
    expect(unqualifiedClaims(SHOPIFY_NOT_CONNECTED.detail)).toEqual([]);
  });

  it("is what the demo service shows", async () => {
    const services = new DemoService(new DemoStore());
    const rows = await services.listIntegrations("ws_demo");
    expect(rows.find((row) => row.kind === "shopify")).toMatchObject({ status: "not_connected", ...SHOPIFY_NOT_CONNECTED });
  });
});
