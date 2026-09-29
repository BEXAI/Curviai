import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EXIT, run, type CliDeps } from "@curvi/cli";
import { API_OPERATIONS } from "@/lib/api-v1/openapi";
import {
  ChannelsResponse,
  CreatePackRequest,
  MainImageCheckRequest,
  MainImageCheckResponse,
  PackFilesResponse,
  PackResponse,
} from "@/lib/api-v1/schemas";
import { setApiKeyBackendForTests } from "@/lib/api-keys/backend";
import { demoApiFixture, mainImagePng, type DemoApiFixture } from "@/lib/api-v1/test-fixtures";
import { MemoryRateLimitStore, setRateLimitStoreForTests } from "@/lib/rate-limit";

// End to end: the curvi CLI (packages/cli) driven through its run() entry
// point, with its fetch wired straight into the /api/v1 route handlers on the
// in memory demo services and the demo API key (PHASE_16 workstream 5, "CLI
// e2e against demo mode"). Every request the CLI sends must be a documented
// OpenAPI operation with a body the server's own schema accepts, and every
// answer it reads must match the documented response schema, so the client
// and the server cannot drift apart.

const packsRoute = await import("./packs/route");
const packRoute = await import("./packs/[id]/route");
const filesRoute = await import("./packs/[id]/files/route");
const checkRoute = await import("./checks/main-image/route");
const channelsRoute = await import("./channels/route");

type Handler = (request: Request, context: { params: Promise<{ id: string }> }) => Promise<Response>;

const ORIGIN = "https://curvi.ai";
const API_URL = `${ORIGIN}/api/v1`;

/** The route handler for an OpenAPI path and method. */
function handlerFor(path: string, method: string): { handler: Handler; template: string; id?: string } | null {
  const routes: Array<[RegExp, string, Record<string, unknown>]> = [
    [/^\/api\/v1\/packs$/, "/api/v1/packs", packsRoute],
    [/^\/api\/v1\/packs\/([^/]+)$/, "/api/v1/packs/{id}", packRoute],
    [/^\/api\/v1\/packs\/([^/]+)\/files$/, "/api/v1/packs/{id}/files", filesRoute],
    [/^\/api\/v1\/checks\/main-image$/, "/api/v1/checks/main-image", checkRoute],
    [/^\/api\/v1\/channels$/, "/api/v1/channels", channelsRoute],
  ];
  for (const [pattern, template, mod] of routes) {
    const match = pattern.exec(path);
    const handler = mod[method] as Handler | undefined;
    if (match && handler) {
      return { handler, template, ...(match[1] ? { id: decodeURIComponent(match[1]) } : {}) };
    }
  }
  return null;
}

interface Sent {
  operationId: string;
  status: number;
  requestBody: unknown;
  responseBody: unknown;
}

let fixture: DemoApiFixture;
let dir: string;
let sent: Sent[];

/** fetch for the CLI: API calls go to the route handlers, checked against
 * the OpenAPI operations and the zod schemas on the way in and out. */
async function apiFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const url = new URL(input);
  const method = (init.method ?? "GET").toUpperCase();
  if (url.origin !== ORIGIN) {
    throw new Error(`The CLI called ${input}, which is not the API.`);
  }
  const route = handlerFor(url.pathname, method);
  if (!route) {
    return Response.json({ error: "Not found.", reason: "not_found" }, { status: 404 });
  }
  const operation = API_OPERATIONS.find((op) => op.path === route.template && op.method === method.toLowerCase());
  expect(operation, `${method} ${route.template} is documented`).toBeDefined();

  const headers = new Headers(init.headers);
  headers.set("x-forwarded-for", "203.0.113.40");
  if (operation!.idempotent) {
    expect(headers.get("idempotency-key"), "Idempotency-Key").toBeTruthy();
  }
  let requestBody: unknown = undefined;
  if (init.body !== undefined && init.body !== null) {
    expect(headers.get("content-type")).toBe("application/json");
    requestBody = JSON.parse(init.body as string);
    const schema = operation!.request === "CreatePackRequest" ? CreatePackRequest : MainImageCheckRequest;
    const parsed = schema.safeParse(requestBody);
    expect(parsed.success, JSON.stringify(parsed.error?.issues ?? [])).toBe(true);
  }

  const response = await route.handler(new Request(url, { method, headers, body: init.body ?? null }), {
    params: Promise.resolve({ id: route.id ?? "" }),
  });
  const documented = [...operation!.success.map((s) => s.status), ...operation!.errors];
  expect(documented, `${operation!.operationId} answered ${response.status}`).toContain(response.status);
  const responseBody = (await response.clone().json()) as unknown;
  sent.push({ operationId: operation!.operationId, status: response.status, requestBody, responseBody });
  return response;
}

interface Harness {
  deps: CliDeps;
  out: () => string;
  err: () => string;
  reset: () => void;
}

function harness(env: Record<string, string | undefined> = {}): Harness {
  let stdout = "";
  let stderr = "";
  let clock = 0;
  return {
    deps: {
      env: { CURVI_CONFIG_DIR: join(dir, "config"), CURVI_API_KEY: fixture.key, CURVI_API_URL: API_URL, ...env },
      platform: process.platform,
      homedir: dir,
      cwd: dir,
      fetch: apiFetch,
      stdout: (text) => {
        stdout += text;
      },
      stderr: (text) => {
        stderr += text;
      },
      readSecret: async () => "",
      sleep: async (ms) => {
        clock += ms;
      },
      now: () => clock,
    },
    out: () => stdout,
    err: () => stderr,
    reset: () => {
      stdout = "";
      stderr = "";
    },
  };
}

beforeEach(async () => {
  fixture = demoApiFixture();
  setApiKeyBackendForTests(fixture.backend);
  setRateLimitStoreForTests(new MemoryRateLimitStore());
  vi.stubEnv("NEXT_PUBLIC_OUTPUT_OPTIONS", "1");
  dir = await mkdtemp(join(tmpdir(), "curvi-cli-e2e-"));
  sent = [];
});

afterEach(async () => {
  setApiKeyBackendForTests(null);
  setRateLimitStoreForTests(null);
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

describe("the curvi CLI against the v1 route handlers in demo mode", () => {
  it("lists channels, makes a pack from a photo on disk, waits for it and reads it back", async () => {
    await writeFile(join(dir, "bottle.png"), await mainImagePng(600, 0.8));
    const h = harness();

    expect(await run(["channels", "--json"], h.deps)).toBe(EXIT.ok);
    const channels = ChannelsResponse.parse(JSON.parse(h.out()));
    expect(channels.channels.some((c) => c.id === "amazon.main")).toBe(true);

    h.reset();
    const create = [
      "pack",
      "create",
      "bottle.png",
      "--channels",
      "amazon",
      "--bundle",
      "main",
      "--look",
      "marketplace",
      "--title",
      "Glass bottle",
      "--note",
      "Keep the label sharp",
      "--idempotency-key",
      "cli-e2e-1",
      "--wait",
      "--json",
    ];
    expect(await run(create, h.deps), h.err()).toBe(EXIT.ok);
    const printed = JSON.parse(h.out()) as { pack: unknown; files: unknown };
    const pack = PackResponse.shape.pack.parse(printed.pack);
    expect(pack.status).toBe("done");
    expect(pack.finished).toBe(true);
    expect(pack.productTitle).toBe("Glass bottle");
    expect(pack.channels).toContain("amazon.main");
    const files = PackFilesResponse.parse(printed.files);
    expect(files.packId).toBe(pack.id);

    // What went over the wire: the documented operations, in order.
    const ops = sent.map((s) => s.operationId);
    expect(ops[0]).toBe("listChannels");
    expect(ops[1]).toBe("createPack");
    expect(ops.slice(2, -1).every((op) => op === "getPack")).toBe(true);
    expect(ops.at(-1)).toBe("listPackFiles");
    const createCall = sent[1]!;
    expect(createCall.status).toBe(201);
    expect(createCall.requestBody).toMatchObject({
      channels: ["amazon"],
      bundle: "main",
      look: "marketplace",
      title: "Glass bottle",
      note: "Keep the label sharp",
      photos: [{ data: expect.any(String) }],
    });
    for (const call of sent.filter((s) => s.operationId === "getPack")) {
      expect(PackResponse.safeParse(call.responseBody).success).toBe(true);
    }

    // The same Idempotency-Key replays the pack instead of making a second one.
    h.reset();
    sent = [];
    expect(await run(create.filter((arg) => arg !== "--wait"), h.deps), h.err()).toBe(EXIT.ok);
    expect(sent[0]).toMatchObject({ operationId: "createPack", status: 200 });
    expect(JSON.parse(h.out())).toMatchObject({ pack: { id: pack.id }, replayed: true });

    // And pack get reads the same pack.
    h.reset();
    expect(await run(["pack", "get", pack.id], h.deps)).toBe(EXIT.ok);
    expect(h.out()).toContain(`Pack ${pack.id} is done.`);
    expect(h.out()).toContain("Product: Glass bottle");
  });

  it("checks main images: exit 0 on a pass and 3 on a fail", async () => {
    await writeFile(join(dir, "good.png"), await mainImagePng(2000, 0.87));
    await writeFile(join(dir, "small.png"), await mainImagePng(600, 0.3));
    const h = harness();

    expect(await run(["check", "good.png", "--json"], h.deps), h.err()).toBe(EXIT.ok);
    const good = MainImageCheckResponse.parse(JSON.parse(h.out()));
    expect(good.pass).toBe(true);
    expect(good.width).toBe(2000);

    h.reset();
    expect(await run(["check", "small.png"], h.deps)).toBe(EXIT.checkFailed);
    expect(h.out()).toMatch(/Fail {2}/);
    expect(sent.map((s) => s.operationId)).toEqual(["checkMainImage", "checkMainImage"]);
  });

  it("reports the server's refusals with exit code 1", async () => {
    const h = harness();
    expect(await run(["pack", "create", "--product", "new", "--channels", "myspace"], h.deps)).toBe(EXIT.error);
    expect(h.err()).toContain("Unknown channels: myspace.");

    const bad = harness({ CURVI_API_KEY: "cv_demo_000000000000_WrongKeyWrongKeyWrongKeyWrongKeyWrongKey000" });
    expect(await run(["pack", "get", "00000000-0000-4000-8000-000000000999"], bad.deps)).toBe(EXIT.error);
    expect(bad.err()).toContain("Check the key with curvi auth status");

    h.reset();
    expect(await run(["pack", "get", "00000000-0000-4000-8000-000000000999"], h.deps)).toBe(EXIT.error);
    expect(h.err()).toContain("This pack does not exist in your workspace.");
  });
});
