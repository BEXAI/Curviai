import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Inventory } from "./inventory";
import { indexNowKeyLocation } from "./model";

const mocks = vi.hoisted(() => ({ collect: vi.fn<() => Promise<Inventory>>() }));
vi.mock("./inventory", async (original) => ({ ...await original<typeof import("./inventory")>(), collectInventory: mocks.collect }));
import { runIndexNow } from "./command";

const KEY = "testtesttesttest";
const PAGE = "https://curvi.ai/pricing";
const sample = (hash = "a"): Inventory => ({ observations: [{ url: PAGE, kind: "page", fingerprint: hash.repeat(64) }], excluded: [] });
let parent: string;
let directory: string;
let output: string[];
const run = (command: string, ...args: string[]) => runIndexNow([command, "--state-dir", directory, ...args], (line) => output.push(line));

beforeEach(async () => {
  parent = await mkdtemp(join(tmpdir(), "curvi-indexnow-command-"));
  directory = join(parent, "state");
  output = [];
  mocks.collect.mockReset().mockResolvedValue(sample());
  vi.stubEnv("INDEXNOW_KEY", KEY);
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Unexpected network request"); }));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await rm(parent, { recursive: true, force: true });
});

describe("manual IndexNow command lifecycle", () => {
  it("initializes without submission, previews without writes, sends a change once and preserves outcomes", async () => {
    expect(await run("initialize")).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
    const initial = await readFile(join(directory, "state.json"), "utf8");
    mocks.collect.mockResolvedValue(sample("b"));
    expect(await run("plan")).toBe(0);
    expect(await readFile(join(directory, "state.json"), "utf8")).toBe(initial);
    expect(JSON.parse(output.at(-1)!).changes).toHaveLength(1);
    const network = vi.fn(async (input: string | URL | Request) => String(input) === indexNowKeyLocation(KEY)
      ? new Response(KEY, { headers: { "content-type": "text/plain" } })
      : new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", network);
    expect(await run("submit", "--execute")).toBe(0);
    expect(network).toHaveBeenCalledTimes(2);
    expect(await run("submit", "--execute")).toBe(0);
    expect(network).toHaveBeenCalledTimes(2);
    const state = JSON.parse(await readFile(join(directory, "state.json"), "utf8"));
    expect(state.entries[0]).toMatchObject({ outcome: "accepted", indexing: "unknown" });
    expect(output.join("\n")).not.toContain(KEY);
    const scans = mocks.collect.mock.calls.length;
    expect(await run("status")).toBe(0);
    expect(mocks.collect).toHaveBeenCalledTimes(scans);
  });

  it("holds ambiguous delivery and requires a separate reviewed retry", async () => {
    await run("initialize");
    mocks.collect.mockResolvedValue(sample("b"));
    const network = vi.fn(async (input: string | URL | Request) => {
      if (String(input) === indexNowKeyLocation(KEY)) return new Response(KEY, { headers: { "content-type": "text/plain" } });
      throw new Error("network timeout");
    });
    vi.stubGlobal("fetch", network);
    expect(await run("submit", "--execute")).toBe(2);
    await expect(run("retry", "--url", PAGE)).rejects.toThrow("duplicate risk");
    expect(await run("retry", "--url", PAGE, "--acknowledge-duplicate-risk")).toBe(0);
    expect(network).toHaveBeenCalledTimes(2);
  });

  it("does not reset existing baselines or change state after a failed inventory scan", async () => {
    await run("initialize");
    await expect(run("initialize")).rejects.toThrow("already exists");
    const before = await readFile(join(directory, "state.json"), "utf8");
    mocks.collect.mockRejectedValue(new Error("site in maintenance"));
    await expect(run("submit", "--execute")).rejects.toThrow("maintenance");
    expect(await readFile(join(directory, "state.json"), "utf8")).toBe(before);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("records a confirmed Bing observation separately from notification state", async () => {
    await run("initialize");
    const observed = new Date().toISOString();
    await expect(run("record-indexing", "--url", PAGE, "--result", "indexed", "--observed-at", observed)).rejects.toThrow("explicit Bing");
    expect(await run("record-indexing", "--url", PAGE, "--result", "indexed", "--observed-at", observed, "--confirm-bing-observation")).toBe(0);
    const state = JSON.parse(await readFile(join(directory, "state.json"), "utf8"));
    expect(state.entries[0]).toMatchObject({ outcome: "baseline", indexing: "indexed", indexingSource: "operator_recorded_bing_inspection" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses submit without execute, key, valid limits or a baseline", async () => {
    await expect(run("submit")).rejects.toThrow("--execute");
    await expect(run("submit", "--execute", "--max-urls", "501")).rejects.toThrow("between 1 and 500");
    await expect(run("submit", "--execute")).rejects.toThrow("Initialize");
    vi.stubEnv("INDEXNOW_KEY", "");
    await expect(run("submit", "--execute")).rejects.toThrow("INDEXNOW_KEY");
    expect(mocks.collect).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects unrelated flags, private URLs and state inside the repository", async () => {
    await expect(run("status", "--execute")).rejects.toThrow("does not apply");
    await expect(run("retry", "--url", "https://curvi.ai/app/ops")).rejects.toThrow("public canonical");
    await expect(runIndexNow(["initialize", "--state-dir", resolve(".indexnow-state")], () => undefined)).rejects.toThrow("outside the repository");
    expect(mocks.collect).not.toHaveBeenCalled();
  });

  it("offers offline help without touching configuration or the site", async () => {
    vi.stubEnv("INDEXNOW_KEY", "");
    await expect(runIndexNow(["--help"], (line) => output.push(line))).resolves.toBe(0);
    expect(output[0]).toContain("without submitting historical URLs");
    expect(mocks.collect).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});
