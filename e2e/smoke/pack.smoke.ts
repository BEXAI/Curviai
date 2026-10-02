import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { expect, test } from "@playwright/test";
import { flatPixelsOnWhite } from "../../packages/pipeline/src/pixels";
import { smokeSettings } from "./settings";

const settings = smokeSettings(process.env);
interface Pack { id: string; status: string; finished: boolean; shots: Array<{ type: string; status: string }> }
interface PackFile { name: string; kind: string; specId: string | null; url: string | null }
test.skip(!settings.packEnabled, "Paid pack smoke is explicitly disabled.");

test("one main-image pack completes and its downloaded ZIP contains the correct white image", async ({ request }) => {
  test.setTimeout(20 * 60_000);
  if (settings.mode === "staging") {
    const home = await request.get("/");
    expect(home.status()).toBe(200);
    expect(await home.text()).toMatch(/data-testid="environment-banner"[^>]*>staging/);
  }
  const headers = { Authorization: `Bearer ${process.env.SMOKE_API_KEY!}` };
  const context = await request.get("/api/v1/smoke-context", { headers });
  expect(context.status(), "The server must verify this operator workspace's metric exclusion before any paid request").toBe(200);
  const verified = await context.json() as { excluded: boolean; workspaceId: string };
  expect(verified.excluded).toBe(true);
  expect(verified.workspaceId).toMatch(/^[a-f0-9-]{36}$/);
  const photo = await readFile(join(__dirname, "../../apps/web/public/review/sample-product.jpg"));
  // A rerun of the same GitHub run reuses the pack. No automatic test retry.
  const run = process.env.GITHUB_RUN_ID ?? randomUUID();
  const create = await request.post("/api/v1/packs", {
    headers: { ...headers, "Idempotency-Key": `smoke-${settings.mode}-${run}` },
    data: { title: "Operator smoke fixture", photos: [{ data: photo.toString("base64") }], channels: ["amazon.main"], bundle: "main" },
    timeout: 90_000,
  });
  expect([200, 201, 202]).toContain(create.status());
  let pack = ((await create.json()) as { pack: Pack }).pack;
  expect(pack.id).toMatch(/^[a-zA-Z0-9_-]+$/);
  await expect.poll(async () => {
    const response = await request.get(`/api/v1/packs/${pack.id}`, { headers });
    expect(response.status()).toBe(200);
    pack = ((await response.json()) as { pack: Pack }).pack;
    return pack.finished;
  }, { timeout: 17 * 60_000, intervals: [5000, 10_000, 15_000] }).toBe(true);
  expect(pack.status).toBe("done");
  const filesResponse = await request.get(`/api/v1/packs/${pack.id}/files`, { headers });
  expect(filesResponse.status()).toBe(200);
  const { files } = await filesResponse.json() as { files: PackFile[] };
  const main = files.find((file) => file.kind === "image" && file.specId === "amazon.main");
  const zip = files.find((file) => file.kind === "zip");
  expect(main, "Delivered main-image file").toBeTruthy();
  expect(zip?.url, "Delivered ZIP download").toBeTruthy();
  // Download requests intentionally carry no API authorization header.
  const downloaded = await request.get(zip!.url!, { timeout: 60_000 });
  expect(downloaded.status()).toBe(200);
  const bytes = await downloaded.body();
  expect(bytes.length).toBeLessThan(50 * 1024 * 1024);
  const directory = await mkdtemp(join(tmpdir(), "curvi-smoke-"));
  try {
    const path = join(directory, "pack.zip");
    await writeFile(path, bytes, { mode: 0o600 });
    // Read one entry through unzip's stdout; never extract paths to disk.
    const names = execFileSync("unzip", ["-Z1", path], { encoding: "utf8", timeout: 10_000, maxBuffer: 1024 * 1024 }).trim().split("\n");
    const name = names.find((entry) => basename(entry) === basename(main!.name));
    expect(name, "The delivered main image is present inside the ZIP").toBeTruthy();
    expect(name).not.toMatch(/[\[\]*?\x00-\x1f]/);
    const image = execFileSync("unzip", ["-p", path, name!], { timeout: 10_000, maxBuffer: 25 * 1024 * 1024 });
    const registry = JSON.parse(await readFile(join(__dirname, "../../packages/specs/src/registry.json"), "utf8")) as {
      specs: Array<{ id: string; width?: number; height?: number; background?: { rgb?: number[]; tolerance?: number } }>;
    };
    const spec = registry.specs.find((entry) => entry.id === "amazon.main")!;
    expect(spec.width).toBeGreaterThan(0);
    expect(spec.height).toBeGreaterThan(0);
    const pixels = await flatPixelsOnWhite(image, Math.max(spec.width!, spec.height!));
    expect(pixels.naturalWidth).toBe(spec.width);
    expect(pixels.naturalHeight).toBe(spec.height);
    const rgb = spec.background!.rgb!;
    const tolerance = spec.background?.tolerance ?? 0;
    for (const [left, top] of [[0, 0], [pixels.width - 8, 0], [0, pixels.height - 8], [pixels.width - 8, pixels.height - 8]]) {
      for (let y = top; y < top + 8; y++) for (let x = left; x < left + 8; x++) {
        const index = (y * pixels.width + x) * 4;
        expect(rgb.every((channel, i) => Math.abs(pixels.data[index + i] - channel) <= tolerance), "White main-image corners").toBe(true);
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
