import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_BASE_URL } from "./client.ts";
import { EXIT, POLL_INTERVAL_MS, run, safeRelativePath, type CliDeps } from "./cli.ts";
import { configPath, readConfig } from "./config.ts";
import type { Pack, PackFiles } from "./types.ts";

const KEY = "curvi_test_0123456789abcdef";
const ID = "11111111-1111-4111-8111-111111111111";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function packOf(status: Pack["status"], extra: Partial<Pack> = {}): Pack {
  return {
    id: ID,
    status,
    finished: ["done", "failed", "canceled"].includes(status),
    productId: "22222222-2222-4222-8222-222222222222",
    productTitle: "Mug",
    channels: ["amazon.main", "shopify.product"],
    creditsReserved: 3,
    creditsCharged: status === "done" ? 2.5 : 0,
    createdAt: "2026-09-29T10:00:00.000Z",
    error: null,
    shots: [],
    links: { self: `/api/v1/packs/${ID}`, files: `/api/v1/packs/${ID}/files` },
    ...extra,
  };
}

/** The body of POST /packs and GET /packs/{id}. */
function pack(status: Pack["status"], extra: Partial<Pack> = {}): { pack: Pack } {
  return { pack: packOf(status, extra) };
}

const FILES: PackFiles = {
  packId: ID,
  status: "done",
  files: [
    {
      id: "v_1",
      name: "mug_main.jpg",
      channel: "amazon",
      specId: "amazon.main",
      kind: "image",
      bytes: 3,
      url: "https://files.example.com/signed/1?sig=abc",
      expiresAt: "2026-09-29T10:15:00.000Z",
    },
    {
      id: "v_2",
      name: "../../escape.jpg",
      channel: "shopify",
      specId: "shopify.product",
      kind: "image",
      bytes: 3,
      url: "https://files.example.com/signed/2?sig=def",
      expiresAt: "2026-09-29T10:15:00.000Z",
    },
    { id: "p_1", name: "compliance-report.pdf", channel: null, specId: null, kind: "report", bytes: null, url: null, expiresAt: null },
  ],
};

interface Harness {
  deps: CliDeps;
  out: () => string;
  err: () => string;
  fetch: ReturnType<typeof vi.fn>;
  dir: string;
}

let dir: string;

async function harness(
  handler: (url: string, init: RequestInit) => Response | Promise<Response>,
  env: Record<string, string | undefined> = {},
): Promise<Harness> {
  let stdout = "";
  let stderr = "";
  let clock = 0;
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => handler(url, init ?? {}));
  const deps: CliDeps = {
    env: { CURVI_CONFIG_DIR: join(dir, "config"), ...env },
    platform: process.platform,
    homedir: dir,
    cwd: dir,
    fetch: fetchImpl,
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    readSecret: vi.fn(async () => ""),
    sleep: vi.fn(async (ms: number) => {
      clock += ms;
    }),
    now: () => clock,
  };
  return { deps, out: () => stdout, err: () => stderr, fetch: fetchImpl, dir };
}

async function signIn(h: Harness): Promise<void> {
  expect(await run(["auth", "login", "--key", KEY], h.deps)).toBe(EXIT.ok);
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "curvi-cli-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("curvi help and version", () => {
  it("prints help with no command and the version on --version", async () => {
    const h = await harness(() => json({}));
    expect(await run([], h.deps)).toBe(EXIT.ok);
    expect(h.out()).toContain("curvi pack create");
    expect(await run(["--version"], h.deps)).toBe(EXIT.ok);
    expect(h.out()).toContain("0.1.0");
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it("exits 2 on an unknown command or option", async () => {
    const h = await harness(() => json({}));
    expect(await run(["publish"], h.deps)).toBe(EXIT.usage);
    expect(await run(["pack", "create", "a.jpg", "--chanels", "x"], h.deps)).toBe(EXIT.usage);
    expect(h.err()).toContain("Unknown option --chanels.");
  });
});

describe("curvi auth", () => {
  it("saves the key in the config folder and shows it masked", async () => {
    const h = await harness(() => json({}));
    await signIn(h);
    expect(await readConfig(h.deps)).toEqual({ apiKey: KEY });
    expect(h.out()).toContain(configPath(h.deps));
    expect(h.out()).not.toContain(KEY);

    expect(await run(["auth", "status"], h.deps)).toBe(EXIT.ok);
    expect(h.out()).toContain("from the saved settings");
    expect(h.out()).toContain(DEFAULT_BASE_URL);
    expect(h.out()).not.toContain(KEY);
  });

  it("reads the key from the prompt when --key is not given, and keeps a saved API URL", async () => {
    const h = await harness(() => json({}));
    expect(await run(["auth", "login", "--key", KEY, "--api-url", "http://localhost:3000/api/v1"], h.deps)).toBe(0);
    h.deps.readSecret = vi.fn(async () => `  other_key_987654321\n`);
    expect(await run(["auth", "login"], h.deps)).toBe(EXIT.ok);
    expect(await readConfig(h.deps)).toEqual({ apiKey: "other_key_987654321", apiUrl: "http://localhost:3000/api/v1" });
  });

  it("refuses an empty key", async () => {
    const h = await harness(() => json({}));
    expect(await run(["auth", "login"], h.deps)).toBe(EXIT.usage);
    expect(h.err()).toContain("/app/settings/api");
  });

  it("logs out by removing the saved key", async () => {
    const h = await harness(() => json({}));
    await signIn(h);
    expect(await run(["auth", "logout"], h.deps)).toBe(EXIT.ok);
    expect(await run(["auth", "status"], h.deps)).toBe(EXIT.error);
    expect(h.out()).toContain("Not signed in.");
  });

  it("uses CURVI_API_KEY without a saved key", async () => {
    const h = await harness(() => json(pack("queued")), { CURVI_API_KEY: KEY });
    expect(await run(["pack", "get", ID], h.deps)).toBe(EXIT.ok);
    const init = h.fetch.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
  });

  it("asks to sign in before calling the API", async () => {
    const h = await harness(() => json({}));
    expect(await run(["pack", "get", ID], h.deps)).toBe(EXIT.usage);
    expect(h.err()).toContain("Run curvi auth login");
    expect(h.fetch).not.toHaveBeenCalled();
  });
});

describe("curvi pack create", () => {
  it("sends the photos with channels, bundle, look, note and options", async () => {
    await writeFile(join(dir, "mug.JPG"), new Uint8Array([0xff, 0xd8, 0xff]));
    const h = await harness(() => json(pack("queued"), 201));
    await signIn(h);
    const code = await run(
      [
        "pack",
        "create",
        "mug.JPG",
        "https://example.com/back.jpg",
        "--channels",
        "amazon.main,shopify.product",
        "--bundle",
        "listing",
        "--look",
        "marketplace",
        "--note",
        "Matte black",
        "--options",
        '{"variations":2}',
        "--idempotency-key",
        "idem-42",
      ],
      h.deps,
    );
    expect(code).toBe(EXIT.ok);
    const [url, init] = h.fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${DEFAULT_BASE_URL}/packs`);
    expect((init.headers as Record<string, string>)["Idempotency-Key"]).toBe("idem-42");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    expect(JSON.parse(init.body as string)).toEqual({
      channels: ["amazon.main", "shopify.product"],
      bundle: "listing",
      look: "marketplace",
      note: "Matte black",
      outputOptions: { variations: 2 },
      photos: [{ data: Buffer.from([0xff, 0xd8, 0xff]).toString("base64") }, { url: "https://example.com/back.jpg" }],
    });
    expect(h.out()).toContain(`Pack ${ID} is queued.`);
    // Not waiting: no poll and no files call.
    expect(h.fetch).toHaveBeenCalledTimes(1);
  });

  it("waits, then lists the signed file links", async () => {
    const statuses = ["queued", "generating", "done"];
    const h = await harness((url, init) => {
      if (init.method === "POST") return json(pack(statuses.shift() as Pack["status"]), 201);
      if (url.endsWith("/files")) return json(FILES);
      return json(pack(statuses.shift() as Pack["status"]));
    });
    await signIn(h);
    const code = await run(["pack", "create", "https://example.com/mug.jpg", "--channels", "amazon.main", "--wait"], h.deps);
    expect(code).toBe(EXIT.ok);
    expect(h.deps.sleep).toHaveBeenCalledWith(POLL_INTERVAL_MS);
    expect(h.out()).toContain(`Pack ${ID} is done.`);
    expect(h.out()).toContain("Credits: 2.5 charged, 3 held");
    expect(h.out()).toContain("https://files.example.com/signed/1?sig=abc");
    const body = JSON.parse((h.fetch.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.photos).toEqual([{ url: "https://example.com/mug.jpg" }]);
  });

  it("prints JSON for agents", async () => {
    const h = await harness((url) => (url.endsWith("/files") ? json(FILES) : json(pack("done"), 201)));
    await signIn(h);
    const before = h.out().length;
    expect(await run(["pack", "create", "https://example.com/a.jpg", "--channels", "amazon.main", "--json"], h.deps)).toBe(0);
    const printed = JSON.parse(h.out().slice(before));
    expect(printed.pack.id).toBe(ID);
    expect(printed.files.files).toHaveLength(3);
  });

  it("stops waiting at the timeout and says how to go on", async () => {
    const h = await harness(() => json(pack("generating")));
    await signIn(h);
    const code = await run(
      ["pack", "create", "https://example.com/a.jpg", "--channels", "amazon.main", "--wait", "--timeout", "6"],
      h.deps,
    );
    expect(code).toBe(EXIT.ok);
    expect(h.err()).toContain(`curvi pack get ${ID} --wait`);
    // One create plus two polls in six seconds.
    expect(h.fetch).toHaveBeenCalledTimes(3);
  });

  it("needs channels and a readable photo", async () => {
    const h = await harness(() => json(pack("queued")));
    await signIn(h);
    expect(await run(["pack", "create", "missing.jpg", "--channels", "amazon.main"], h.deps)).toBe(EXIT.usage);
    expect(h.err()).toContain("Could not read the photo at missing.jpg.");
    expect(await run(["pack", "create", "https://example.com/a.jpg"], h.deps)).toBe(EXIT.usage);
    expect(await run(["pack", "create", "--channels", "amazon.main"], h.deps)).toBe(EXIT.usage);
    expect(
      await run(["pack", "create", "https://example.com/a.jpg", "--channels", "x", "--answer", "mood=bright"], h.deps),
    ).toBe(EXIT.usage);
    expect(await run(["pack", "create", "https://example.com/a.jpg", "--channels", "x", "--options", "[1]"], h.deps)).toBe(
      EXIT.usage,
    );
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it("shows the server's reason and a hint when the API refuses", async () => {
    const h = await harness(() =>
      json({ error: "API access needs the Growth plan.", reason: "upgrade_required" }, 403),
    );
    await signIn(h);
    expect(await run(["pack", "create", "https://example.com/a.jpg", "--channels", "amazon.main"], h.deps)).toBe(
      EXIT.error,
    );
    expect(h.err()).toContain("API access needs the Growth plan.");
    expect(h.err()).toContain("Growth plan and up");
    const h2 = await harness(() =>
      json({ error: "Invalid request.", reason: "invalid_request", issues: ["Unknown bundle: huge."] }, 400),
    );
    expect(
      await run(["pack", "create", "https://example.com/a.jpg", "--channels", "amazon.main", "--bundle", "huge"], {
        ...h2.deps,
        env: { ...h2.deps.env, CURVI_API_KEY: KEY },
      }),
    ).toBe(EXIT.error);
    expect(h2.err()).toContain("Unknown bundle: huge.");
  });
});

describe("curvi pack get", () => {
  it("shows notes for shots that need review and exits 1 on a failed pack", async () => {
    const h = await harness(() =>
      json(
        pack("failed", {
          error: "The photo could not be read.",
          shots: [
            {
              id: "s1",
              type: "main_white",
              status: "done",
              channels: ["amazon.main"],
              credits: 0.5,
              note: null,
              compliance: null,
            },
            {
              id: "s2",
              type: "lifestyle",
              status: "needs_review",
              channels: ["shopify.product"],
              credits: 1,
              note: "The product edge did not pass.",
              compliance: { pass: false, fillPct: 80, background: [255, 255, 255] },
            },
          ],
        }),
      ),
    );
    await signIn(h);
    expect(await run(["pack", "get", ID], h.deps)).toBe(EXIT.error);
    expect(h.out()).toContain("Shots: 1 done, 1 needs review");
    expect(h.out()).toContain("lifestyle: The product edge did not pass.");
    expect(h.out()).toContain("The photo could not be read.");
  });

  it("downloads files under --out without sending the key and never outside the folder", async () => {
    const h = await harness((url) => {
      if (url.startsWith("https://files.example.com/")) return new Response(new Uint8Array([1, 2, 3]));
      return url.endsWith("/files") ? json(FILES) : json(pack("done"));
    });
    await signIn(h);
    expect(await run(["pack", "get", ID, "--out", "pack"], h.deps)).toBe(EXIT.ok);

    const downloads = h.fetch.mock.calls.filter((call) => (call[0] as string).startsWith("https://files.example.com/"));
    expect(downloads).toHaveLength(2);
    for (const call of downloads) {
      expect(JSON.stringify((call[1] as RequestInit).headers ?? {})).not.toContain(KEY);
    }
    expect((await readdir(join(dir, "pack"))).sort()).toEqual(["amazon", "shopify"]);
    expect(await readdir(join(dir, "pack", "shopify"))).toEqual(["escape.jpg"]);
    expect(await readFile(join(dir, "pack", "amazon", "mug_main.jpg"))).toEqual(Buffer.from([1, 2, 3]));
    expect(h.out()).toContain("Saved 2 files");
  });

  it("needs one pack id", async () => {
    const h = await harness(() => json({}));
    await signIn(h);
    expect(await run(["pack", "get"], h.deps)).toBe(EXIT.usage);
  });
});

describe("curvi check", () => {
  it("exits 0 on a pass and 3 on a fail, with each row", async () => {
    await writeFile(join(dir, "main.png"), new Uint8Array([0x89, 0x50]));
    let pass = true;
    const h = await harness(() =>
      json({
        pass,
        summary: pass ? "Every check passed." : "1 of 3 checks failed.",
        width: 2000,
        height: 2000,
        checks: [
          { key: "resolution", label: "Resolution", pass: true, measured: "2000 px" },
          { key: "fill", label: "Product fill", pass, measured: pass ? "88 percent" : "60 percent" },
        ],
        rules: { minLongSide: 1000, fillMinPercent: 85, fillMaxPercent: 100 },
      }),
    );
    await signIn(h);
    expect(await run(["check", "main.png"], h.deps)).toBe(EXIT.ok);
    pass = false;
    expect(await run(["check", "main.png"], h.deps)).toBe(EXIT.checkFailed);
    expect(h.out()).toContain("Fail  Product fill: 60 percent");
    const body = JSON.parse((h.fetch.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body).toEqual({ data: Buffer.from([0x89, 0x50]).toString("base64") });
    expect((h.fetch.mock.calls[0] as [string])[0]).toBe(`${DEFAULT_BASE_URL}/checks/main-image`);
  });
});

describe("curvi channels", () => {
  it("lists the channels and bundles for the key's plan", async () => {
    const h = await harness(() =>
      json({
        channels: [
          {
            id: "amazon.main",
            channel: "amazon",
            name: "Amazon main image",
            width: 2000,
            height: 2000,
            availability: "available",
            upgradeTo: null,
          },
          {
            id: "meta.feed_1x1",
            channel: "meta",
            name: "Meta feed square",
            width: 1080,
            height: 1080,
            availability: "upgrade_required",
            upgradeTo: "pro",
          },
        ],
        bundles: [{ key: "main", label: "Main image" }],
      }),
    );
    await signIn(h);
    expect(await run(["channels"], h.deps)).toBe(EXIT.ok);
    expect((h.fetch.mock.calls[0] as [string])[0]).toBe(`${DEFAULT_BASE_URL}/channels`);
    expect(h.out()).toContain("amazon.main  Amazon main image, 2000 x 2000, available");
    expect(h.out()).toContain("needs the pro plan");
    expect(h.out()).toContain("main  Main image");
  });
});

describe("safeRelativePath", () => {
  it("keeps paths inside the folder", () => {
    expect(safeRelativePath("amazon", "main.jpg")).toBe(join("amazon", "main.jpg"));
    expect(safeRelativePath(null, "../../etc/passwd")).toBe(join("etc", "passwd"));
    expect(safeRelativePath("meta", "carousel/01.jpg")).toBe(join("meta", "carousel", "01.jpg"));
    expect(safeRelativePath("..", "..")).toBe("file");
    expect(safeRelativePath(null, "C:\\x\\y z.png")).toBe(join("C_", "x", "y_z.png"));
  });
});
