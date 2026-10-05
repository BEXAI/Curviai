import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildPlugin } from "./build";
import { channelGroups, channelListingLines, joinNames, liveChannelFamilies, notLiveChannelNames, type ChannelFamilyFact } from "./channels";
import { imageSize } from "./images";
import { DEVELOPER_NAME_PLACEHOLDER, MCP_URL, TEST_CASES } from "./limits";
import { PLUGIN_DIR, WEB_PUBLIC_DIR, checkPlugin, contrastRatio, readSiteColors, type CheckOptions } from "./manifest";
import { readZipListing } from "./zip";

// The plugin ZIP's own checks (docs/phases/PHASE_19.md, P19-25): the
// checked in folder passes them, and each one fails when its rule is broken.

const DEVELOPER = "Example Studio";
const temps: string[] = [];

type Manifest = Record<string, any>;

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "curvi-plugin-"));
  temps.push(dir);
  return dir;
}

/** A copy of package/ with plugin.json (and optionally mcp.json) changed. */
function variant(change: (manifest: Manifest, mcp: Manifest, dir: string) => void): string {
  const dir = tempDir();
  cpSync(PLUGIN_DIR, dir, { recursive: true });
  const manifest = JSON.parse(readFileSync(join(dir, "plugin.json"), "utf8")) as Manifest;
  const mcp = JSON.parse(readFileSync(join(dir, "mcp.json"), "utf8")) as Manifest;
  change(manifest, mcp, dir);
  writeFileSync(join(dir, "plugin.json"), JSON.stringify(manifest));
  writeFileSync(join(dir, "mcp.json"), JSON.stringify(mcp));
  return dir;
}

function errorsFor(change: (manifest: Manifest, mcp: Manifest, dir: string) => void, options: CheckOptions = {}): string[] {
  return checkPlugin({ developerName: DEVELOPER, ...options, dir: variant(change) }).errors;
}

function ui(manifest: Manifest): Manifest {
  return manifest.extensions["com.openai"].interface;
}

function review(manifest: Manifest): Manifest {
  return manifest.extensions["com.openai"].review;
}

/** A PNG header with the given size (the checks read only the header). */
function pngHeader(width: number, height: number): Buffer {
  const header = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header, 0);
  header.writeUInt32BE(13, 8);
  header.write("IHDR", 12, "latin1");
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  return header;
}

afterEach(() => {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("the checked in plugin folder", () => {
  it("passes every check once the verified developer name is set", () => {
    const result = checkPlugin({ developerName: DEVELOPER });
    expect(result.errors).toEqual([]);
    expect(result.manifest?.author).toMatchObject({ name: DEVELOPER });
  });

  it("fails only on the developer name while the placeholder stands", () => {
    const manifest = JSON.parse(readFileSync(join(PLUGIN_DIR, "plugin.json"), "utf8")) as Manifest;
    const result = checkPlugin();
    if (manifest.author.name === DEVELOPER_NAME_PLACEHOLDER) {
      expect(result.errors).toEqual([
        "author.name: still holds the placeholder; set the verified developer name (runbook A4)",
        "interface.developerName: still holds the placeholder; set the verified developer name (runbook A4)",
      ]);
    } else {
      expect(result.errors).toEqual([]);
    }
  });

  it("warns that review still needs the demo recording until it is set", () => {
    const manifest = JSON.parse(readFileSync(join(PLUGIN_DIR, "plugin.json"), "utf8")) as Manifest;
    const warnings = checkPlugin({ developerName: DEVELOPER }).warnings;
    expect(warnings).toEqual(review(manifest).demo_recording_url ? [] : [expect.stringContaining("demo_recording_url")]);
  });

  it("carries the plan's listing: name, subtitle, category, the permanent MCP URL and no screenshots", () => {
    const { manifest, mcp } = checkPlugin({ developerName: DEVELOPER });
    expect(manifest).toMatchObject({ name: "curvi", homepage: "https://curvi.ai", author: { email: "support@curvi.ai", url: "https://curvi.ai" } });
    expect(ui(manifest!)).toMatchObject({
      displayName: "Curvi",
      shortDescription: "Listing images from one photo",
      category: "Creativity",
      websiteURL: "https://curvi.ai",
      supportURL: "https://curvi.ai/support",
      privacyPolicyURL: "https://curvi.ai/privacy",
      termsOfServiceURL: "https://curvi.ai/terms",
    });
    expect(ui(manifest!).screenshots).toBeUndefined();
    expect(Object.values(mcp!.mcpServers as Manifest)).toEqual([{ type: "streamable-http", url: MCP_URL }]);
    expect(review(manifest!).test_cases.positive).toHaveLength(TEST_CASES.positive);
    expect(review(manifest!).test_cases.negative).toHaveLength(TEST_CASES.negative);
    expect((manifest as Manifest).extensions["com.openai"].publication).toMatchObject({ countries: [] });
  });

  it("uses the site's brand marks byte for byte", () => {
    const brand = join(WEB_PUBLIC_DIR, "brand");
    expect(readFileSync(join(PLUGIN_DIR, "assets", "logo.png")).equals(readFileSync(join(brand, "curvi-mark-512.png")))).toBe(true);
    expect(readFileSync(join(PLUGIN_DIR, "assets", "composer-icon.png")).equals(readFileSync(join(brand, "curvi-mark-192.png")))).toBe(true);
  });

  it("names a review photo the site serves, a JPEG", () => {
    const photo = readFileSync(join(WEB_PUBLIC_DIR, "review", "sample-product.jpg"));
    expect(imageSize(photo)).toEqual({ format: "jpeg", width: 1200, height: 746 });
  });
});

describe("each check fails when its rule is broken", () => {
  const cases: Array<[string, (manifest: Manifest, mcp: Manifest, dir: string) => void, string]> = [
    ["display name over 30", (m) => (ui(m).displayName = "C".repeat(31)), "interface.displayName: is 31 characters"],
    ["subtitle over 30", (m) => (ui(m).shortDescription = "Listing images from one photo!!"), "interface.shortDescription: is 31 characters"],
    ["long description over 4,000", (m) => (ui(m).longDescription += " ".repeat(4_000)), "interface.longDescription: is"],
    ["root description over 1,024", (m) => (m.description = "a".repeat(1_025)), "description: is 1025 characters"],
    ["a capability over 120", (m) => ui(m).capabilities.push("a".repeat(121)), "interface.capabilities[6]: is 121 characters"],
    ["more than 20 capabilities", (m) => ui(m).capabilities.push(...Array.from({ length: 15 }, (_, i) => `Line ${i}`)), "has 21 entries, over 20"],
    ["a prompt over 128", (m) => (ui(m).defaultPrompt[0] = "a".repeat(129)), "interface.defaultPrompt[0]: is 129 characters"],
    ["more than 3 prompts", (m) => ui(m).defaultPrompt.push("One more"), "has 4 prompts, over 3"],
    ["a repeated prompt", (m) => (ui(m).defaultPrompt[2] = `  ${ui(m).defaultPrompt[1].toUpperCase()} `), "repeats another prompt"],
    ["a prompt that mentions a server", (m) => (ui(m).defaultPrompt[0] = "Ask @curvi for images"), "must not @mention"],
    ["four positive cases", (m) => review(m).test_cases.positive.pop(), "has 4 cases; review needs exactly 5"],
    ["four negative cases", (m) => review(m).test_cases.negative.push({ description: "d", prompt: "p" }), "has 4 cases; review needs exactly 3"],
    ["a negative case with tools", (m) => (review(m).test_cases.negative[0].tools_triggered = "list_channels"), "carries only description and prompt"],
    ["an http URL", (m) => (ui(m).supportURL = "http://curvi.ai/support"), "interface.supportURL: must be an HTTPS URL"],
    ["a URL with credentials", (m) => (ui(m).termsOfServiceURL = "https://user:pass@curvi.ai/terms"), "must not carry credentials"],
    ["a listing URL on another site", (m) => (ui(m).privacyPolicyURL = "https://example.com/privacy"), "must be on curvi.ai"],
    ["test credentials in the ZIP", (m) => (review(m).test_credentials = { email: "a@b.c" }), "review.test_credentials: is refused in the ZIP"],
    ["reviewer instructions in the ZIP", (m) => (m.extensions["com.openai"].reviewer_instructions = "Sign in"), "reviewer_instructions: is refused"],
    ["hooks", (m) => (m.extensions["com.openai"].hooks = "./hooks/hooks.json"), 'extensions["com.openai"].hooks: is not part of this plugin'],
    ["an app manifest", (m) => (m.extensions["com.openai"].apps = "./.app.json"), 'extensions["com.openai"].apps: is not part of this plugin'],
    ["screenshots without UI evidence", (m) => (ui(m).screenshots = ["./assets/one.png"]), "interface.screenshots: needs a supplied MCP snapshot"],
    ["a light brand color under 2:1 on white", (m) => (ui(m).brandColor = "#FCE7F3"), "interface.brandColor: has"],
    ["a dark brand color under 2:1 on #212121", (m) => (ui(m).brandColorDark = "#384153"), "interface.brandColorDark: has"],
    ["a brand color the site does not define", (m) => (ui(m).brandColor = "#123456"), "is not one of the site's brand tokens"],
    ["a brand color that is not hex", (m) => (ui(m).brandColor = "pink"), "must be a six digit hex color"],
    [
      "a logo that is not square",
      (m, _mcp, dir) => {
        writeFileSync(join(dir, "assets", "wide.png"), pngHeader(200, 100));
        ui(m).logo = "./assets/wide.png";
      },
      "interface.logo: must be square, and is 200 by 100",
    ],
    [
      "an icon under 48 px",
      (m, _mcp, dir) => {
        writeFileSync(join(dir, "assets", "tiny.png"), pngHeader(32, 32));
        ui(m).composerIcon = "./assets/tiny.png";
      },
      "interface.composerIcon: must be 48 to 4096 px",
    ],
    ["an asset outside the folder", (m) => (ui(m).logo = "./../logo.png"), "must stay inside the plugin folder"],
    ["a missing asset", (m) => (ui(m).logo = "./assets/gone.png"), "names ./assets/gone.png, which is missing"],
    ["an em dash", (m) => (ui(m).longDescription = ui(m).longDescription.replace("rules. Attach", "rules — attach")), "interface.longDescription: rule 9: dash"],
    ["a spaced hyphen", (m) => (m.description = "Listing images - from one photo."), "description: rule 9: dash"],
    ["an emoji", (m) => (ui(m).capabilities[0] = "Makes marketplace images \u{1F680}"), "rule 9: emoji"],
    ["credits in a listing field", (m) => (ui(m).capabilities[0] = "Uses credits from your account"), 'uses "credit"'],
    ["free in the subtitle", (m) => (ui(m).shortDescription = "Free listing images"), 'interface.shortDescription: uses "free"'],
    ["a price in the release notes", (m) => (m.extensions["com.openai"].publication.release_notes = "Better prices."), 'uses "price"'],
    ["a promotion word", (m) => (ui(m).longDescription += " Upgrade for more."), "banned word: upgrade"],
    ["MCP in the name", (m) => (ui(m).displayName = "Curvi MCP"), "must not add MCP or Plugin"],
    ["a category the directory does not have", (m) => (ui(m).category = "Design"), "interface.category: must be one of"],
    ["a lowercase country code", (m) => (m.extensions["com.openai"].publication.countries = ["us"]), "publication.countries"],
    ["no release notes", (m) => delete m.extensions["com.openai"].publication.release_notes, "publication.release_notes: is missing"],
    ["a version that is not semantic", (m) => (m.version = "1.0"), "version: must be a semantic version"],
    ["a name with a space", (m) => (m.name = "curvi app"), "name: must start with a letter or digit"],
    ["the wrong schema", (m) => (m.$schema = "https://example.com/plugin.json"), "$schema: must be"],
    ["an attachment the site does not serve", (m) => (review(m).test_cases.positive[0].file_attachment_urls = ["https://curvi.ai/review/gone.jpg"]), "which apps/web/public does not have"],
    ["an attachment over http", (m) => (review(m).test_cases.positive[0].file_attachment_urls = ["http://example.com/a.jpg"]), "file_attachment_urls[0]: must be an HTTPS URL"],
    ["tools that are not a list of names", (m) => (review(m).test_cases.positive[1].tools_triggered = "List channels!"), "must list tool names"],
    ["a coming soon channel in the listing", (m) => (ui(m).capabilities[3] = "Plain color backgrounds for Wayfair"), "names Wayfair, which is not a live channel"],
    ["a channel line that drifted", (m) => (ui(m).capabilities[1] = "Sizes images for Amazon and Shopify"), "is missing the channel line generated from the live channels"],
    ["a channel list that drifted", (m) => (ui(m).longDescription = ui(m).longDescription.replace(", Pinterest", "")), "must carry the channel list generated"],
    ["two MCP servers", (_m, mcp) => (mcp.mcpServers.other = { type: "streamable-http", url: MCP_URL }), "has 2 servers"],
    ["an SSE server", (_m, mcp) => (mcp.mcpServers.curvi.type = "sse"), 'type: must be "streamable-http"'],
    ["another MCP URL", (_m, mcp) => (mcp.mcpServers.curvi.url = "https://mcp.curvi.ai/mcp"), "must be https://curvi.ai/api/mcp, the permanent MCP URL"],
    [
      "a skills folder",
      (_m, _mcp, dir) => {
        mkdirSync(join(dir, "skills", "curvi"), { recursive: true });
        writeFileSync(join(dir, "skills", "curvi", "SKILL.md"), "# Curvi");
      },
      "skills/curvi/SKILL.md: skills are not part of the first ZIP",
    ],
    [
      "a hooks file",
      (_m, _mcp, dir) => {
        mkdirSync(join(dir, "hooks"));
        writeFileSync(join(dir, "hooks", "hooks.json"), "{}");
      },
      "hooks/hooks.json: hooks and app manifests are not part of this plugin",
    ],
  ];

  it.each(cases)("%s", (_name, change, expected) => {
    const families: ChannelFamilyFact[] = [...liveChannelFamilies(), { family: "wayfair", name: "Wayfair", status: "coming_soon" }];
    const errors = errorsFor(change, { families });
    expect(errors.some((error) => error.includes(expected)), errors.join("\n")).toBe(true);
  });

  it("refuses the placeholder developer name", () => {
    const errors = checkPlugin({ dir: variant(() => {}) }).errors;
    expect(errors).toEqual(expect.arrayContaining([expect.stringContaining("author.name: still holds the placeholder")]));
  });

  it("refuses a listing developer name that differs from the author (decision 8)", () => {
    const dir = variant((m) => {
      m.author.name = "Studio A";
      ui(m).developerName = "Studio B";
    });
    expect(checkPlugin({ dir }).errors).toEqual(["interface.developerName: must equal author.name (decision 8)"]);
  });

  it("refuses the listing when a channel it names stops being live", () => {
    const families = liveChannelFamilies().map((family) => (family.family === "tiktok" ? { ...family, status: "coming_soon" as const } : family));
    const errors = checkPlugin({ developerName: DEVELOPER, families }).errors;
    expect(errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining('is missing the channel line generated from the live channels: "Makes ad images for Meta and Pinterest placements"'),
        expect.stringContaining("names TikTok, which is not a live channel"),
      ]),
    );
    // TikTok Shop stays live, and is not mistaken for TikTok.
    expect(errors.some((error) => error.includes("names TikTok Shop"))).toBe(false);
  });
});

describe("channel lines (decision 17)", () => {
  it("come from the live channel list, split by the spec registry", () => {
    expect(channelGroups(liveChannelFamilies())).toEqual({
      marketplaces: ["Amazon", "Shopify", "Walmart", "Etsy", "eBay", "TikTok Shop", "Google Merchant"],
      ads: ["Meta", "Pinterest", "TikTok"],
    });
    expect(channelListingLines(liveChannelFamilies()).capabilities).toEqual([
      "Sizes images for Amazon, Shopify, Walmart, Etsy, eBay, TikTok Shop and Google Merchant",
      "Makes ad images for Meta, Pinterest and TikTok placements",
    ]);
  });

  it("joins names and finds the ones that are not live", () => {
    expect(joinNames(["A"])).toBe("A");
    expect(joinNames(["A", "B", "C"], "or")).toBe("A, B or C");
    const families: ChannelFamilyFact[] = [
      { family: "tiktokshop", name: "TikTok Shop", status: "live" },
      { family: "tiktok", name: "TikTok", status: "coming_soon" },
    ];
    expect(notLiveChannelNames("Sizes images for TikTok Shop", families)).toEqual([]);
    expect(notLiveChannelNames("TikTok Shop and TikTok ads", families)).toEqual(["TikTok"]);
  });
});

describe("helpers", () => {
  it("reads the site's colors and measures contrast as WCAG does", () => {
    expect(readSiteColors()).toEqual(expect.arrayContaining(["#ec4899", "#2dd4bf"]));
    expect(contrastRatio("#ffffff", "#000000")).toBeCloseTo(21, 5);
    expect(contrastRatio("#ec4899", "#ffffff")).toBeGreaterThan(2);
    expect(contrastRatio("#ec4899", "#212121")).toBeGreaterThan(2);
  });

  it("reads PNG and JPEG sizes from their headers and nothing else", () => {
    expect(imageSize(readFileSync(join(PLUGIN_DIR, "assets", "logo.png")))).toEqual({ format: "png", width: 512, height: 512 });
    expect(imageSize(pngHeader(64, 48))).toEqual({ format: "png", width: 64, height: 48 });
    expect(imageSize(Buffer.from("GIF89a"))).toBeNull();
    expect(imageSize(Buffer.from([0xff, 0xd8, 0xff]))).toBeNull();
  });
});

describe("the build", () => {
  it("writes the folder and a ZIP with plugin.json and mcp.json at its root, the same bytes every time", async () => {
    const out = tempDir();
    const first = await buildPlugin({ developerName: DEVELOPER, out });
    expect(first.ok, first.ok ? "" : first.errors.join("\n")).toBe(true);
    if (!first.ok) {
      return;
    }
    expect(first.entries.sort()).toEqual(["assets/composer-icon.png", "assets/logo.png", "mcp.json", "plugin.json"]);
    expect(first.zipPath).toBe(join(out, "curvi-1.0.1.zip"));
    const zip = readFileSync(first.zipPath);
    expect(readZipListing(zip).names.sort()).toEqual(first.entries.sort());
    const built = JSON.parse(readFileSync(join(first.folder, "plugin.json"), "utf8")) as Manifest;
    expect(built.author.name).toBe(DEVELOPER);
    expect(ui(built).developerName).toBe(DEVELOPER);
    expect(readFileSync(join(first.folder, "mcp.json"), "utf8")).toBe(readFileSync(join(PLUGIN_DIR, "mcp.json"), "utf8"));

    const second = await buildPlugin({ developerName: DEVELOPER, out });
    expect(second.ok && readFileSync(second.zipPath).equals(zip)).toBe(true);
  });

  it("writes nothing when a check fails", async () => {
    const out = tempDir();
    const result = await buildPlugin({ out, dir: variant((m) => (ui(m).displayName = "Curvi Plugin")) });
    expect(result.ok).toBe(false);
    expect(result.ok ? [] : result.errors).toEqual(expect.arrayContaining([expect.stringContaining("must not add MCP or Plugin")]));
  });
});
