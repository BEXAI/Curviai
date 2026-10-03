import { beforeEach, describe, expect, it, vi } from "vitest";

const auditEnabled = vi.hoisted(() => vi.fn(async () => false));
vi.mock("@/lib/store-audit/switch", () => ({ storeAuditEnabled: auditEnabled }));
vi.mock("@/lib/shares", () => ({ getShareStore: () => ({ listGallery: async () => [] }) }));

import sitemap from "./sitemap";
import { clearShareSitemapCache } from "@/lib/shares/sitemap";
import { LEGAL_FACTS } from "@/lib/legal/facts";

const contentDates = new Map([
  ["/terms", LEGAL_FACTS.termsLastUpdated],
  ["/privacy", LEGAL_FACTS.privacyLastUpdated],
  ["/legal/subprocessors", LEGAL_FACTS.subprocessorsLastUpdated],
]);

beforeEach(() => {
  auditEnabled.mockResolvedValue(false);
  clearShareSitemapCache();
});

describe("public sitemap", () => {
  it("includes the canonical public policy pages linked by the footer", async () => {
    const urls = (await sitemap()).map((entry) => entry.url);
    for (const path of ["/terms", "/privacy", "/legal/subprocessors"]) {
      expect(urls).toContain(`https://curvi.ai${path}`);
    }
  });

  it.each([false, true])("lists the store audit only while its page is available: %s", async (enabled) => {
    auditEnabled.mockResolvedValue(enabled);
    const urls = (await sitemap()).map((entry) => entry.url);
    expect(urls.some((url) => url === "https://curvi.ai/tools/store-image-audit")).toBe(enabled);
  });

  it("contains unique production paths without private, token or artificial freshness entries", async () => {
    auditEnabled.mockResolvedValue(true);
    const rows = await sitemap();
    expect(new Set(rows.map((row) => row.url)).size).toBe(rows.length);
    for (const row of rows) {
      const url = new URL(row.url);
      expect(url.origin).toBe("https://curvi.ai");
      expect(url.search).toBe("");
      expect(url.hash).toBe("");
      expect(url.pathname).not.toMatch(/^\/(?:app|api|auth|oauth|feedback|email|r)(?:\/|$)/);
      expect(["/welcome", "/account-deleted", "/forgot-password", "/reset-password"]).not.toContain(url.pathname);
      // Only the policy pages have content dates maintained with their text.
      // Omit lastmod elsewhere rather than assigning a request/build time.
      expect(row.lastModified).toBe(contentDates.get(url.pathname));
    }
  });
});
