import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildPlugin, parseBuildArgs } from "./build";
import { checkPlugin, PLUGIN_DIR } from "./manifest";
import { checkToolSnapshot, checkToolsFile, EXTERNAL_SUBMISSION_CHECKS, MAX_TOOLS_SNAPSHOT_BYTES } from "./submission";

// Deliberate local fixtures, never evidence of a deployed client or portal scan.
const temps: string[] = [];
const developerName = "Fixture Studio";
function temp(): string {
  const path = mkdtempSync(join(tmpdir(), "curvi-submission-"));
  temps.push(path);
  return path;
}
function snapshot() {
  return { tools: [
    ["list_channels", true, false, false],
    ["estimate_pack", true, false, true],
    ["create_pack", false, true, true],
    ["get_pack", true, false, false],
    ["show_pack", true, false, false],
    ["check_main_image", true, false, true],
    ["get_profile", true, false, false],
  ].map(([name, readOnlyHint, destructiveHint, openWorldHint]) => ({
    name: name as string,
    inputSchema: { type: "object", properties: { pack_id: { type: "string" } }, required: ["pack_id"] },
    outputSchema: { type: "object", properties: { message: { type: "string" } }, required: ["message"] },
    annotations: { readOnlyHint, destructiveHint, openWorldHint },
    _meta: { ui: { visibility: name === "get_pack" ? ["model", "app"] : ["model"], ...(["create_pack", "show_pack"].includes(name as string) ? { resourceUri: "ui://curvi/pack-viewer/v2.html" } : {}) } },
  })) };
}
function toolsFile(value: unknown = snapshot()): string {
  const path = join(temp(), "tools-list.json");
  writeFileSync(path, JSON.stringify(value));
  return path;
}
function packageVariant(change?: (manifest: any, dir: string) => void): string {
  const dir = join(temp(), "package");
  cpSync(PLUGIN_DIR, dir, { recursive: true });
  const manifest = JSON.parse(readFileSync(join(dir, "plugin.json"), "utf8"));
  manifest.extensions["com.openai"].review.demo_recording_url = "https://curvi.ai/review/fixture-recording";
  change?.(manifest, dir);
  writeFileSync(join(dir, "plugin.json"), JSON.stringify(manifest));
  return dir;
}
function pngHeader(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(33);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
  bytes.writeUInt32BE(13, 8); bytes.write("IHDR", 12);
  bytes.writeUInt32BE(width, 16); bytes.writeUInt32BE(height, 20);
  return bytes;
}
function screenshots(manifest: any, dir: string, width = 706, height = 500) {
  manifest.extensions["com.openai"].interface.screenshots = [0, 1, 2].map((n) => {
    const path = `./assets/case-${n}.png`;
    writeFileSync(join(dir, path), pngHeader(width, height));
    return path;
  });
}
afterEach(() => temps.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));

describe("submission descriptor checks", () => {
  it("accepts a complete result or JSON-RPC response and identifies both render tools", () => {
    expect(checkToolSnapshot(snapshot())).toEqual({ errors: [], uiTools: ["create_pack", "show_pack"] });
    expect(checkToolSnapshot({ jsonrpc: "2.0", id: 1, result: snapshot() }).errors).toEqual([]);
  });
  it("rejects missing, duplicate and unreviewed tool names", () => {
    const value = snapshot();
    value.tools.pop();
    value.tools.push(value.tools[0]!, { ...value.tools[0]!, name: "new_tool" });
    expect(checkToolSnapshot(value).errors).toEqual(expect.arrayContaining([
      expect.stringContaining("missing tool get_profile"), expect.stringContaining("duplicate tool list_channels"), expect.stringContaining("new_tool needs an explicit annotation review"),
    ]));
  });
  it("rejects changed/missing annotations, broken schemas and a missing pack identifier", () => {
    const value: any = snapshot();
    value.tools[2].annotations.destructiveHint = false;
    delete value.tools[0].annotations.readOnlyHint;
    delete value.tools[1].inputSchema;
    value.tools[5].outputSchema.required = ["missing"];
    value.tools[3].inputSchema.required = [];
    expect(checkToolSnapshot(value).errors).toEqual(expect.arrayContaining([
      expect.stringContaining("create_pack.destructiveHint"), expect.stringContaining("list_channels.readOnlyHint"), expect.stringContaining("estimate_pack needs an object inputSchema"), expect.stringContaining("check_main_image needs an object outputSchema"), expect.stringContaining("get_pack must require a string pack_id"),
    ]));
  });
  it("rejects disabled/stale UI, unsafe app visibility and repeated rendering on a poll", () => {
    const value: any = snapshot();
    value.tools[2]._meta.ui.resourceUri = "ui://curvi/pack-viewer/v1.html";
    value.tools[4]._meta.ui.visibility = ["model", "app"];
    value.tools[3]._meta.ui.resourceUri = "ui://curvi/pack-viewer/v2.html";
    expect(checkToolSnapshot(value).errors).toEqual(expect.arrayContaining([
      expect.stringContaining("create_pack must use the current"), expect.stringContaining("show_pack has unexpected UI visibility"), expect.stringContaining("get_pack must stay data-only"),
    ]));
  });
  it("rejects pagination, absent tools and malformed JSON without echoing data", () => {
    expect(checkToolSnapshot({ ...snapshot(), nextCursor: "more" }).errors).not.toEqual([]);
    expect(checkToolSnapshot({}).errors).not.toEqual([]);
    const path = toolsFile();
    writeFileSync(path, "secret-marker-not-json");
    expect(checkToolsFile(path).errors).toEqual(["MCP snapshot: cannot read a valid JSON tools/list file"]);
  });
  it("bounds reads, accepts only explicit JSON files and refuses directories", () => {
    const path = toolsFile();
    writeFileSync(path, Buffer.alloc(MAX_TOOLS_SNAPSHOT_BYTES + 1));
    expect(checkToolsFile(path).errors).toEqual(["MCP snapshot: must be a regular JSON file no larger than 2 MiB"]);
    expect(checkToolsFile(join(temp(), ".env.local")).errors).toEqual(["MCP snapshot: must be an explicitly supplied .json descriptor file"]);
    const directory = join(temp(), "directory.json"); mkdirSync(directory);
    expect(checkToolsFile(directory).errors).not.toEqual([]);
  });
});

describe("local submission mode", () => {
  it("keeps draft builds useful but refuses a final package missing its recording and snapshot", () => {
    expect(checkPlugin({ developerName }).errors).toEqual([]);
    expect(checkPlugin({ developerName }).warnings).toEqual([expect.stringContaining("demo_recording_url")]);
    const result = checkPlugin({ developerName, mode: "submission" });
    expect(result.errors).toEqual(expect.arrayContaining([expect.stringContaining("needs --tools-file"), expect.stringContaining("demo_recording_url: is required")]));
  });
  it("does not fabricate identity, accepts optional screenshot omission and rejects credential-bearing recordings", () => {
    const file = toolsFile();
    const dir = packageVariant();
    expect(checkPlugin({ dir, toolsFile: file, mode: "submission" }).errors).toEqual(expect.arrayContaining([expect.stringContaining("still holds the placeholder")]));
    expect(checkPlugin({ dir, developerName, toolsFile: file, mode: "submission" }).errors).toEqual([]);
    const invalid = packageVariant((m) => { m.extensions["com.openai"].review.demo_recording_url = "https://name:password@curvi.ai/video"; });
    expect(checkPlugin({ dir: invalid, developerName, toolsFile: file, mode: "submission" }).errors).toEqual(expect.arrayContaining([expect.stringContaining("must not carry credentials")]));
  });
  it("keeps descriptor evidence outside the package", () => {
    const dir = packageVariant();
    const file = join(dir, "tools.json"); writeFileSync(file, JSON.stringify(snapshot()));
    expect(checkPlugin({ dir, developerName, toolsFile: file, mode: "submission" }).errors).toEqual(expect.arrayContaining([expect.stringContaining("must stay outside the package")]));
  });
  it("checks optional screenshot dimensions, count, format and UI evidence", () => {
    const file = toolsFile();
    const dir = packageVariant(screenshots);
    expect(checkPlugin({ dir, developerName, toolsFile: file, mode: "submission" }).errors).toEqual([]);
    expect(checkPlugin({ dir, developerName }).errors).toEqual(expect.arrayContaining([expect.stringContaining("needs a supplied MCP snapshot")]));
    const wrongSize = packageVariant((m, path) => screenshots(m, path, 705, 500));
    expect(checkPlugin({ dir: wrongSize, developerName, toolsFile: file, mode: "submission" }).errors).toEqual(expect.arrayContaining([expect.stringContaining("706 px wide")]));
    const wrongCount = packageVariant((m, path) => { screenshots(m, path); m.extensions["com.openai"].interface.screenshots.pop(); });
    expect(checkPlugin({ dir: wrongCount, developerName, toolsFile: file, mode: "submission" }).errors).toEqual(expect.arrayContaining([expect.stringContaining("one image per starter prompt")]));
    const mismatch = packageVariant((m, path) => { screenshots(m, path); m.extensions["com.openai"].interface.screenshots[0] = "./assets/not-jpeg.jpg"; writeFileSync(join(path, "assets/not-jpeg.jpg"), pngHeader(706, 500)); });
    expect(checkPlugin({ dir: mismatch, developerName, toolsFile: file, mode: "submission" }).errors).toEqual(expect.arrayContaining([expect.stringContaining("matching PNG or JPEG header")]));
  });
  it("refuses screenshot traversal and symlink escape before reading an outside image", () => {
    const file = toolsFile();
    const outside = join(temp(), "outside.png"); writeFileSync(outside, pngHeader(706, 500));
    const dir = packageVariant((m, path) => {
      screenshots(m, path);
      m.extensions["com.openai"].interface.screenshots[0] = "./assets/../assets/case-0.png";
      m.extensions["com.openai"].interface.screenshots[1] = "./assets/outside.png";
      symlinkSync(outside, join(path, "assets/outside.png"));
    });
    expect(checkPlugin({ dir, developerName, toolsFile: file, mode: "submission" }).errors).toEqual(expect.arrayContaining([
      expect.stringContaining("without parent traversal"), expect.stringContaining("must resolve inside the plugin folder"),
    ]));
  });
  it("fails before creating artifacts and never labels a local pass as external approval", async () => {
    const out = join(temp(), "out");
    const failed = await buildPlugin({ developerName, mode: "submission", out });
    expect(failed.ok).toBe(false); expect(existsSync(out)).toBe(false);
    const built = await buildPlugin({ dir: packageVariant(), developerName, mode: "submission", toolsFile: toolsFile(), out });
    expect(built.ok, built.ok ? "" : built.errors.join("\n")).toBe(true);
    if (!built.ok) return;
    expect(built.mode).toBe("submission");
    expect(built.externalChecks).toEqual(EXTERNAL_SUBMISSION_CHECKS);
    expect(built.entries).toEqual(expect.not.arrayContaining(["tools-list.json"]));
    expect(built).not.toHaveProperty("approved");
  });
});

describe("submission CLI", () => {
  it("parses explicit submission options and preserves draft as default", () => {
    expect(parseBuildArgs([])).toEqual({ options: {}, errors: [] });
    expect(parseBuildArgs(["--submission", "--tools-file=/tmp/tools.json", "--developer-name", "Actual Publisher", "--out", "/tmp/artifact"])).toEqual({ options: { mode: "submission", toolsFile: "/tmp/tools.json", developerName: "Actual Publisher", out: "/tmp/artifact" }, errors: [] });
  });
  it.each([["--submision"], ["--tools-file"], ["--out", "--submission"], ["--submission", "--submission"], ["--tools-file=a.json", "--tools-file=b.json"]])("rejects malformed arguments instead of silently falling back: %j", (...args) => {
    expect(parseBuildArgs(args).errors.length).toBeGreaterThan(0);
  });
});
