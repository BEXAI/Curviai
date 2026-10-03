import { expect, test, type APIRequestContext, type FrameLocator, type Page } from "@playwright/test";

// These are browser checks of the production MCP resource in a fixture host,
// not evidence of a real ChatGPT installation, OAuth session or attachment.
// The fixture host stands in for the user's authenticated tools bridge.
const PACK_ID = "0b7a4d1e-5c3f-4a2b-9e8d-7c6b5a4f3e2d";
const PREVIEW = '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="320"><rect width="320" height="320" fill="white"/><rect x="90" y="60" width="140" height="210" rx="12" fill="#9c7bb5"/><text x="160" y="160" text-anchor="middle" fill="white">Sample candle</text></svg>';
interface Rpc { jsonrpc: string; id?: string | number; method?: string; params?: Record<string, unknown>; result?: unknown }
interface HostState { messages: Rpc[]; answered: (string | number)[]; unexpected: string[] }
type FixtureWindow = Window & { __curviViewerFixture: HostState };
interface ViewerResource {
  uri: string; mimeType: string; text: string;
  _meta: { ui: { domain: string; csp: { resourceDomains: string[]; connectDomains?: string[]; frameDomains?: string[] } } };
}

async function resource(request: APIRequestContext): Promise<ViewerResource> {
  const list = await request.post("/api/mcp", { data: { jsonrpc: "2.0", id: 1, method: "resources/list", params: {} } });
  expect(list.ok()).toBe(true);
  const listed = await list.json() as { result: { resources: Pick<ViewerResource, "uri" | "mimeType">[] } };
  const viewer = listed.result.resources.find((entry) => entry.uri === "ui://curvi/pack-viewer/v2.html");
  expect(viewer?.mimeType).toBe("text/html;profile=mcp-app");
  const read = await request.post("/api/mcp", { data: { jsonrpc: "2.0", id: 2, method: "resources/read", params: { uri: viewer!.uri } } });
  expect(read.ok()).toBe(true);
  const payload = await read.json() as { result: { contents: ViewerResource[] } };
  const result = payload.result.contents[0];
  expect(result.uri).toBe(viewer!.uri);
  expect(result.mimeType).toBe(viewer!.mimeType);
  expect(result._meta.ui.csp.resourceDomains).toEqual([result._meta.ui.domain]);
  expect(result._meta.ui.csp.connectDomains ?? []).toEqual([]);
  expect(result._meta.ui.csp.frameDomains ?? []).toEqual([]);
  return result;
}

async function mount(page: Page, request: APIRequestContext, failedPreview?: string) {
  const served = await resource(request);
  const origin = new URL(served._meta.ui.domain).origin;
  const network: string[] = [], unexpectedNetwork: string[] = [], scriptErrors: string[] = [];
  page.on("pageerror", (error) => scriptErrors.push(error.message));
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin || !url.pathname.startsWith("/api/mcp/preview/fixture-")) {
      unexpectedNetwork.push(url.origin + url.pathname);
      await route.abort("blockedbyclient");
      return;
    }
    network.push(url.pathname);
    await route.fulfill(url.pathname.endsWith(failedPreview ?? "NO_FAILED_PREVIEW")
      ? { status: 410, contentType: "text/plain", body: "Fixture link expired" }
      : { status: 200, contentType: "image/svg+xml", body: PREVIEW });
  });
  // The host applies the resource's declared network restrictions. The
  // resource itself is unchanged apart from this host-enforced CSP metadata.
  const csp = `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src ${served._meta.ui.csp.resourceDomains.join(" ")}; connect-src 'none'; frame-src 'none'`;
  const html = served.text.replace("<head>", `<head><meta http-equiv="Content-Security-Policy" content="${csp}">`);
  await page.clock.install();
  await page.setContent('<!doctype html><html lang="en"><head><title>Curvi fixture MCP host</title></head><body style="margin:0"></body></html>');
  await page.evaluate(({ html }) => {
    const state: HostState = { messages: [], answered: [], unexpected: [] };
    (window as unknown as FixtureWindow).__curviViewerFixture = state;
    const iframe = document.createElement("iframe");
    iframe.id = "curvi-viewer";
    iframe.title = "Curvi pack viewer";
    iframe.setAttribute("sandbox", "allow-scripts");
    iframe.style.cssText = "display:block;width:100%;height:800px;border:0";
    const send = (message: unknown) => iframe.contentWindow!.postMessage(message, "*");
    window.addEventListener("message", (event: MessageEvent<Rpc>) => {
      if (event.source !== iframe.contentWindow || event.data?.jsonrpc !== "2.0") return;
      const message = event.data;
      state.messages.push(message);
      const answer = (result: unknown) => send({ jsonrpc: "2.0", id: message.id, result });
      switch (message.method) {
        case "ui/initialize":
          answer({ protocolVersion: "2026-01-26", hostInfo: { name: "curvi-browser-fixture", version: "1" },
            hostCapabilities: { serverTools: {}, openLinks: {} },
            hostContext: { theme: "light", displayMode: "inline", availableDisplayModes: ["inline", "fullscreen"] } });
          break;
        case "ui/notifications/initialized": break;
        case "ui/notifications/size-changed":
          iframe.style.height = `${Math.min(10_000, Math.max(200, Number(message.params?.height) || 200))}px`;
          break;
        case "tools/call":
          if (message.params?.name === "get_pack") break;
          state.unexpected.push(`Tool refused: ${String(message.params?.name)}`);
          send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Fixture host permits only get_pack." } });
          break;
        case "ui/open-link": answer({}); break; // Record the handoff, never navigate.
        case "ui/request-display-mode": answer({ mode: "fullscreen" }); break;
        default:
          state.unexpected.push(`Host method refused: ${String(message.method)}`);
          if (message.id !== undefined) send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } });
      }
    });
    document.body.append(iframe);
    iframe.srcdoc = html;
  }, { html });
  await expect.poll(async () => (await messages(page)).some((message) => message.method === "ui/notifications/initialized")).toBe(true);
  const frame = page.frameLocator("#curvi-viewer");
  const checkBoundary = async () => {
    expect(scriptErrors).toEqual([]);
    expect(unexpectedNetwork).toEqual([]);
    const state = await page.evaluate(() => (window as unknown as FixtureWindow).__curviViewerFixture);
    expect(state.unexpected).toEqual([]);
    for (const message of state.messages.filter((value) => value.method === "tools/call")) {
      expect(message.params).toEqual({ name: "get_pack", arguments: { pack_id: PACK_ID } });
    }
  };
  return { frame, origin, network, checkBoundary };
}

const messages = (page: Page) => page.evaluate(() => (window as unknown as FixtureWindow).__curviViewerFixture.messages);
async function notify(page: Page, method: string, params: unknown) {
  await page.evaluate(({ method, params }) => {
    (document.getElementById("curvi-viewer") as HTMLIFrameElement).contentWindow!.postMessage({ jsonrpc: "2.0", method, params }, "*");
  }, { method, params });
}
const ok = (structuredContent: unknown) => ({ content: [{ type: "text", text: JSON.stringify(structuredContent) }], structuredContent, isError: false });
async function answerRead(page: Page, result: unknown) {
  await expect.poll(async () => page.evaluate(() => {
    const state = (window as unknown as FixtureWindow).__curviViewerFixture;
    return state.messages.filter((message) => message.method === "tools/call" && message.id !== undefined && !state.answered.includes(message.id)).length;
  })).toBe(1);
  await page.evaluate(({ result }) => {
    const state = (window as unknown as FixtureWindow).__curviViewerFixture;
    const call = state.messages.find((message) => message.method === "tools/call" && message.id !== undefined && !state.answered.includes(message.id))!;
    state.answered.push(call.id!);
    (document.getElementById("curvi-viewer") as HTMLIFrameElement).contentWindow!.postMessage({ jsonrpc: "2.0", id: call.id, result }, "*");
  }, { result });
}
function pack(origin: string, options: { status?: string; images?: number; tag?: string } = {}) {
  const status = options.status ?? "done", count = options.images ?? 2, tag = options.tag ?? "current";
  return {
    pack_id: PACK_ID, status, finished: status !== "generating", product: "Sample lavender candle", channels: ["amazon.main"],
    credits: { held: 12, charged: status === "generating" ? 0 : count }, progress: { done: count, total: 4 },
    message: status === "canceled" ? "The pack was stopped. Delivered files are still available." : status === "generating" ? "The pack is making images." : "Your delivered files are ready.",
    error: null, links_valid_hours: 24,
    images: status === "generating" ? undefined : [
      ...Array.from({ length: count }, (_, index) => ({
        name: `candle-${index + 1}.jpg`, channel: "amazon.main", kind: "image", passes_channel_rules: true, fill_percent: 86,
        fidelity: index === 0 ? { meanDeltaE: 0.2, maxDeltaE: 0.8, exactByteShare: 0.95, maskArea: 100, threshold: 1, maxDeltaELimit: 2, kind: "composite", exact: false } : null,
        preview_url: `${origin}/api/mcp/preview/fixture-${tag}-${index + 1}`, download_url: `${origin}/api/mcp/files/fixture-${tag}-${index + 1}`,
      })),
      { name: "candle-pack.zip", channel: null, kind: "zip", passes_channel_rules: null, fill_percent: null, preview_url: null, download_url: `${origin}/api/mcp/files/fixture-${tag}-zip` },
      { name: "report.json", channel: null, kind: "report", passes_channel_rules: null, fill_percent: null, preview_url: null, download_url: `${origin}/api/mcp/files/fixture-${tag}-report` },
    ],
  };
}
async function waitForRead(page: Page) { await page.clock.runFor(5_001); }
async function keyboardClick(page: Page, button: ReturnType<FrameLocator["getByRole"]>) {
  await button.focus();
  await expect(button).toBeFocused();
  await page.keyboard.press("Enter");
}

test("create result advances to delivered previews without another generation call", async ({ page, request }) => {
  const host = await mount(page, request);
  await expect(host.frame.getByRole("heading", { name: "Waiting for your go ahead" })).toBeVisible();
  await notify(page, "ui/notifications/tool-input", { arguments: { channels: ["amazon.main"] } });
  await notify(page, "ui/notifications/tool-result", ok(pack(host.origin, { status: "generating", images: 1 })));
  await expect(host.frame.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "1");
  await waitForRead(page);
  await answerRead(page, ok(pack(host.origin)));
  await expect(host.frame.getByRole("heading", { name: "Ready", exact: true })).toBeVisible();
  await expect(host.frame.getByRole("img")).toHaveCount(2);
  await expect(host.frame.getByText("Passed channel checks", { exact: true })).toHaveCount(2);
  await expect(host.frame.getByText("Product color measured. Average difference: 0.2.", { exact: true })).toBeVisible();
  await expect(host.frame.getByText("Product color measurement unavailable.", { exact: true })).toBeVisible();
  await page.clock.runFor(60_000);
  expect((await messages(page)).filter((message) => message.method === "tools/call")).toHaveLength(1);
  await host.checkBoundary();
});

test("showing an existing pack revalidates its card and offers keyboard downloads on mobile", async ({ page, request }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  const host = await mount(page, request);
  await notify(page, "ui/notifications/tool-input", { arguments: { pack_id: PACK_ID } });
  await notify(page, "ui/notifications/tool-result", ok(pack(host.origin, { tag: "old-conversation" })));
  await expect(host.frame.getByRole("button", { name: "Refreshing files", exact: true })).toBeDisabled();
  expect(host.network).toEqual([]);
  await waitForRead(page);
  await answerRead(page, ok(pack(host.origin)));
  await expect(host.frame.getByRole("img")).toHaveCount(2);
  await expect.poll(() => host.network.length).toBe(2);
  expect(host.network.every((path) => path.includes("fixture-current"))).toBe(true);
  await keyboardClick(page, host.frame.getByRole("button", { name: /Download.*candle-1\.jpg/ }));
  await keyboardClick(page, host.frame.getByRole("button", { name: /Download ZIP/ }));
  await keyboardClick(page, host.frame.getByRole("button", { name: /Download report/ }));
  await expect.poll(async () => (await messages(page)).filter((message) => message.method === "ui/open-link").length).toBe(3);
  expect((await messages(page)).filter((message) => message.method === "ui/open-link").map((message) => message.params?.url)).toEqual([
    `${host.origin}/api/mcp/files/fixture-current-1`, `${host.origin}/api/mcp/files/fixture-current-zip`, `${host.origin}/api/mcp/files/fixture-current-report`,
  ]);
  expect(await host.frame.locator("html").evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await host.checkBoundary();
});

test("expired previews refresh through get_pack and a refused refresh never recreates a pack", async ({ page, request }) => {
  const host = await mount(page, request, "fixture-expired-1");
  await notify(page, "ui/notifications/tool-result", ok(pack(host.origin, { images: 1 })));
  await waitForRead(page);
  await answerRead(page, ok(pack(host.origin, { images: 1, tag: "expired" })));
  await expect(host.frame.getByRole("alert")).toContainText("link expired");
  await keyboardClick(page, host.frame.getByRole("button", { name: "Refresh files", exact: true }));
  await waitForRead(page);
  await answerRead(page, ok(pack(host.origin, { images: 1, tag: "refreshed" })));
  await expect(host.frame.getByRole("img")).toHaveAttribute("src", `${host.origin}/api/mcp/preview/fixture-refreshed-1`);
  await keyboardClick(page, host.frame.getByRole("button", { name: "Refresh files", exact: true }));
  // Repeated refusal is bounded. These fixture replies represent a connection
  // that can no longer read the pack; the widget cannot repair it by creating.
  for (const backoff of [5_001, 10_001, 15_001]) {
    await page.clock.runFor(backoff);
    await answerRead(page, { isError: true, content: [{ type: "text", text: "Connect Curvi again to read this pack." }] });
  }
  await expect(host.frame.getByText("Connect Curvi again to read this pack.", { exact: true })).toBeVisible();
  await expect(host.frame.getByRole("img")).toHaveCount(0);
  await page.clock.runFor(60_000);
  expect((await messages(page)).filter((message) => message.method === "tools/call")).toHaveLength(5);
  await host.checkBoundary();
});

test("a canceled pack keeps authorized partial files beside its terminal explanation", async ({ page, request }) => {
  const host = await mount(page, request);
  const partial = pack(host.origin, { status: "canceled", images: 1 });
  await notify(page, "ui/notifications/tool-result", ok(partial));
  await waitForRead(page);
  await answerRead(page, ok(partial));
  await expect(host.frame.getByRole("alert")).toHaveText("The pack was stopped. Delivered files are still available.");
  await expect(host.frame.getByRole("heading", { name: "Delivered files", exact: true })).toBeVisible();
  await expect(host.frame.getByRole("img")).toHaveCount(1);
  await expect(host.frame.getByText("candle-2.jpg", { exact: true })).toHaveCount(0);
  await keyboardClick(page, host.frame.getByRole("button", { name: /Download report/ }));
  await page.clock.runFor(60_000);
  expect((await messages(page)).filter((message) => message.method === "tools/call")).toHaveLength(1);
  await host.checkBoundary();
});
