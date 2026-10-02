import { afterEach, describe, expect, it, vi } from "vitest";
import { shareLoop } from "@curvi/pipeline/seed";
import { afterDemoImage, beforeDemoImage } from "@/components/marketing/demo-images";
import { identityClaims, unqualifiedClaims } from "@/lib/marketing-facts";
import { allLoopCopy, quoteAttribution, SHARE_TEXT } from "./loop-copy";
import { DEVICE_SHARE_SOURCE, SHARE_NETWORKS, shareIntentUrl, taggedShareUrl } from "./share-links";
import { gallerySitemapRows, resetShareSitemapCacheForTests, shareSitemapRows } from "./sitemap";
import type { GalleryEntry } from "./types";

// P18-14: share URLs carry the network's UTM tags and are encoded; the
// sitemap lists only gallery listed, real share pages; the copy is plain.

const FORBIDDEN_COPY = /[‒-―←-⇿⟵-⟿]|\s-\s|--|\p{Extended_Pictographic}/u;
const PAGE = "https://curvi.ai/s/abcd2345ef";
const IMAGE = `${PAGE}/og`;

function utmOf(link: string) {
  const url = new URL(link);
  return {
    source: url.searchParams.get("utm_source"),
    medium: url.searchParams.get("utm_medium"),
    campaign: url.searchParams.get("utm_campaign"),
  };
}

describe("share links", () => {
  it("tag the page with the network, share and pack_share", () => {
    expect(utmOf(taggedShareUrl(PAGE, "x"))).toEqual({ source: "x", medium: "share", campaign: "pack_share" });
    expect(shareLoop).toMatchObject({ utmMedium: "share", utmCampaign: "pack_share" });
    // Tags already on the page are replaced, never doubled.
    const twice = taggedShareUrl(`${PAGE}?utm_source=reddit&utm_medium=cpc`, DEVICE_SHARE_SOURCE);
    expect(new URL(twice).searchParams.getAll("utm_source")).toEqual(["device"]);
    expect(new URL(twice).searchParams.getAll("utm_medium")).toEqual(["share"]);
  });

  it("open each network's own share page with the tagged link encoded", () => {
    const input = { pageUrl: PAGE, imageUrl: IMAGE, text: SHARE_TEXT };
    const x = new URL(shareIntentUrl("x", input));
    expect(`${x.origin}${x.pathname}`).toBe("https://x.com/intent/tweet");
    expect(x.searchParams.get("text")).toBe(SHARE_TEXT);
    expect(utmOf(x.searchParams.get("url")!)).toMatchObject({ source: "x" });

    const linkedin = new URL(shareIntentUrl("linkedin", input));
    expect(`${linkedin.origin}${linkedin.pathname}`).toBe("https://www.linkedin.com/sharing/share-offsite/");
    expect(utmOf(linkedin.searchParams.get("url")!)).toMatchObject({ source: "linkedin" });

    const pinterest = new URL(shareIntentUrl("pinterest", input));
    expect(`${pinterest.origin}${pinterest.pathname}`).toBe("https://www.pinterest.com/pin/create/button/");
    expect(pinterest.searchParams.get("media")).toBe(IMAGE);
    expect(pinterest.searchParams.get("description")).toBe(SHARE_TEXT);
    expect(utmOf(pinterest.searchParams.get("url")!)).toMatchObject({ source: "pinterest" });

    const reddit = new URL(shareIntentUrl("reddit", input));
    expect(`${reddit.origin}${reddit.pathname}`).toBe("https://www.reddit.com/submit");
    expect(reddit.searchParams.get("title")).toBe(SHARE_TEXT);
    expect(utmOf(reddit.searchParams.get("url")!)).toMatchObject({ source: "reddit" });

    for (const network of SHARE_NETWORKS) {
      const raw = shareIntentUrl(network, input);
      // The page link is encoded inside the share URL, never left raw.
      expect(raw).not.toContain("utm_source=x&utm_medium");
      expect(raw.startsWith("https://")).toBe(true);
    }
  });
});

describe("share loop copy", () => {
  it("is plain spoken and claims nothing it should not", () => {
    for (const text of allLoopCopy()) {
      expect(text, text).not.toMatch(FORBIDDEN_COPY);
      expect(unqualifiedClaims(text), text).toEqual([]);
      expect(identityClaims(text), text).toEqual([]);
    }
  });

  it("shows a quote's name only when the seller typed one", () => {
    expect(quoteAttribution("  Ana, Juniper Candles ")).toBe("Ana, Juniper Candles");
    expect(quoteAttribution(null)).toBeNull();
    expect(quoteAttribution("   ")).toBeNull();
  });
});

function entry(slug: string, src = "/s/x/image/v_1"): GalleryEntry {
  return { slug, title: "Candle", category: null, before: null, after: { ref: "v_1", src, alt: "Candle" } };
}

describe("share pages in the sitemap", () => {
  afterEach(() => {
    resetShareSitemapCacheForTests();
  });

  it("lists gallery shares and never a drawn illustration", () => {
    const rows = shareSitemapRows("https://curvi.ai", [
      entry("realshare1"),
      entry("drawnshare", afterDemoImage),
      { ...entry("drawnbefore"), before: { ref: "before", src: beforeDemoImage, alt: "x" } },
    ]);
    expect(rows.map((row) => row.url)).toEqual(["https://curvi.ai/s/realshare1"]);
  });

  it("holds the seeded cap", () => {
    const many = Array.from({ length: shareLoop.sitemapMaxShares + 5 }, (_, i) => entry(`share${i}aaaa`));
    expect(shareSitemapRows("https://curvi.ai", many)).toHaveLength(shareLoop.sitemapMaxShares);
  });

  it("rereads the gallery at most once per refresh window, and lists none when the read fails", async () => {
    const list = vi.fn(async () => [entry("realshare1")]);
    const t0 = 1_000_000;
    expect(await gallerySitemapRows("https://curvi.ai", list, t0)).toHaveLength(1);
    await gallerySitemapRows("https://curvi.ai", list, t0 + 1000);
    expect(list).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledWith(shareLoop.sitemapMaxShares);
    await gallerySitemapRows("https://curvi.ai", list, t0 + shareLoop.sitemapRefreshSeconds * 1000 + 1);
    expect(list).toHaveBeenCalledTimes(2);

    resetShareSitemapCacheForTests();
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const failing = vi.fn(async () => {
      throw new Error("db down");
    });
    expect(await gallerySitemapRows("https://curvi.ai", failing, t0)).toEqual([]);
    expect(await gallerySitemapRows("https://curvi.ai", list, t0 + 1)).toHaveLength(1);
    error.mockRestore();
  });
});
