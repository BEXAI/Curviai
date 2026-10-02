import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PACK_VIEWER_COPY } from "./copy";
import { MCP_APPS_PROTOCOL_VERSION, packViewerHtml } from "./html";
import type { OpenAiGlobals } from "./runtime";
import { fakeHost, type FakeElement } from "./test-dom";
import { ORIGIN, PACK_ID, finishedPack, pack, toolOk, toolRefusal } from "./test-fixtures";

// The pack viewer as the browser runs it (PHASE_19 P19-19): the script inside
// the served HTML, run on its own (no module scope, so every embedded
// function must be self contained), against a fake host speaking the MCP
// Apps bridge (2026-01-26).

const START = Date.UTC(2026, 9, 1, 12, 0, 0);
const ALLOWED_TAGS = new Set(["HEADER", "H1", "P", "DIV", "UL", "LI", "IMG", "SPAN", "BUTTON"]);

type Host = ReturnType<typeof fakeHost>;

function scriptOf(html: string): string {
  return html.slice(html.indexOf("<script>") + "<script>".length, html.lastIndexOf("</script>"));
}

async function boot(host: Host): Promise<void> {
  // The page's own script, evaluated with nothing but the window in scope.
  new Function("window", scriptOf(packViewerHtml(ORIGIN)))(host.win);
  await vi.advanceTimersByTimeAsync(0);
}

const CAPS = { serverTools: {}, openLinks: {} };

async function connect(host: Host, hostCapabilities: Record<string, unknown> = CAPS, hostContext: Record<string, unknown> = {}) {
  await boot(host);
  host.answer("ui/initialize", {
    protocolVersion: MCP_APPS_PROTOCOL_VERSION,
    hostInfo: { name: "test-host", version: "1" },
    hostCapabilities,
    hostContext: { theme: "dark", displayMode: "inline", availableDisplayModes: ["inline", "fullscreen"], ...hostContext },
  });
  await vi.advanceTimersByTimeAsync(0);
}

function notify(host: Host, method: string, params: unknown): void {
  host.deliver({ jsonrpc: "2.0", method, params });
}

function text(host: Host, className: string): string[] {
  return host.doc.root.byClass(className).map((element) => element.textContent);
}

function toolCalls(host: Host) {
  return host.requests("tools/call");
}

/** Starts a pack and walks it to finished with n images. */
async function finishWith(host: Host, n: number): Promise<void> {
  notify(host, "ui/notifications/tool-input", { arguments: { channels: ["amazon.main"] } });
  notify(host, "ui/notifications/tool-result", toolOk(pack()));
  await vi.advanceTimersByTimeAsync(5_000);
  host.answer("tools/call", toolOk(finishedPack(n)));
  await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
  vi.useFakeTimers({ now: START });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the MCP Apps bridge", () => {
  it("initializes as the 2026-01-26 spec says, then waits for the go ahead", async () => {
    const host = fakeHost();
    await boot(host);
    expect(host.sent).toHaveLength(1);
    expect(host.sent[0]).toEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "ui/initialize",
      params: {
        appInfo: { name: "curvi-pack-viewer", version: "1" },
        appCapabilities: { availableDisplayModes: ["inline", "fullscreen"] },
        protocolVersion: "2026-01-26",
      },
    });
    expect(text(host, "heading")).toEqual([PACK_VIEWER_COPY.awaiting]);

    host.answer("ui/initialize", {
      protocolVersion: "2026-01-26",
      hostCapabilities: CAPS,
      hostContext: {
        theme: "dark",
        styles: { variables: { "--color-text-primary": "#fafafa", "--color-background-primary": "url(https://evil.example/x)", "--x;y": "red" } },
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(host.sent.filter((message) => message.method === "ui/notifications/initialized")).toEqual([
      { jsonrpc: "2.0", method: "ui/notifications/initialized", params: {} },
    ]);
    expect(host.doc.documentElement.getAttribute("data-theme")).toBe("dark");
    expect([...host.doc.documentElement.styleProps]).toEqual([["--color-text-primary", "#fafafa"]]);
    expect(host.sent.find((message) => message.method === "ui/notifications/size-changed")?.params).toEqual({ height: 240 });
  });

  it("polls get_pack through tools/call every 5 seconds until the pack is finished, and calls no other tool", async () => {
    const host = fakeHost();
    await connect(host);
    notify(host, "ui/notifications/tool-input", { arguments: {} });
    expect(text(host, "heading")).toEqual([PACK_VIEWER_COPY.making]);
    notify(host, "ui/notifications/tool-result", toolOk(pack()));
    await vi.advanceTimersByTimeAsync(4_999);
    expect(toolCalls(host)).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(toolCalls(host).map((call) => call.params)).toEqual([{ name: "get_pack", arguments: { pack_id: PACK_ID } }]);

    host.answer("tools/call", toolOk(pack({ status: "generating", progress: { done: 2, total: 5 } })));
    await vi.advanceTimersByTimeAsync(0);
    expect(text(host, "status")).toEqual(["2 of 5 ready"]);
    expect(host.doc.root.byClass("bar")[0]!.getAttribute("aria-valuenow")).toBe("2");
    expect(host.doc.root.byClass("fill")[0]!.style.width).toBe("40%");

    await vi.advanceTimersByTimeAsync(5_000);
    expect(toolCalls(host)).toHaveLength(2);
    host.answer("tools/call", toolOk(finishedPack(3)));
    await vi.advanceTimersByTimeAsync(0);
    expect(text(host, "heading")).toEqual([PACK_VIEWER_COPY.ready]);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(toolCalls(host)).toHaveLength(2);
    expect(new Set(toolCalls(host).map((call) => call.params.name))).toEqual(new Set(["get_pack"]));
  });

  it("ignores messages that do not come from the host, and stops on ui/resource-teardown", async () => {
    const host = fakeHost();
    await connect(host);
    host.deliver({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: toolOk(finishedPack(2)) }, { other: "window" });
    expect(text(host, "heading")).toEqual([PACK_VIEWER_COPY.awaiting]);

    notify(host, "ui/notifications/tool-result", toolOk(pack()));
    host.deliver({ jsonrpc: "2.0", id: "t1", method: "ui/resource-teardown", params: {} });
    expect(host.sent.at(-1)).toEqual({ jsonrpc: "2.0", id: "t1", result: {} });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(toolCalls(host)).toHaveLength(0);
    expect(host.listenerCount("message")).toBe(0);
  });

  it("answers ping and refuses other host requests", async () => {
    const host = fakeHost();
    await connect(host);
    host.deliver({ jsonrpc: "2.0", id: 7, method: "ping" });
    expect(host.sent.at(-1)).toEqual({ jsonrpc: "2.0", id: 7, result: {} });
    host.deliver({ jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "create_pack" } });
    expect(host.sent.at(-1)).toEqual({ jsonrpc: "2.0", id: 8, error: { code: -32601, message: "Method not found" } });
  });

  it("stops polling and says so when the host cannot call tools", async () => {
    const host = fakeHost();
    await connect(host, { openLinks: {} });
    notify(host, "ui/notifications/tool-result", toolOk(pack()));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(toolCalls(host)).toHaveLength(0);
    expect(text(host, "note")).toEqual([PACK_VIEWER_COPY.askAssistant]);
  });

  it("shows a refused create_pack as text and starts nothing", async () => {
    const host = fakeHost();
    await connect(host);
    notify(host, "ui/notifications/tool-result", toolRefusal("This pack needs 30 credits and the workspace has 4, so it was not started."));
    expect(text(host, "status")).toEqual(["This pack needs 30 credits and the workspace has 4, so it was not started."]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(toolCalls(host)).toHaveLength(0);
  });

  it("falls back to ChatGPT's window.openai helpers when no MCP Apps host answers", async () => {
    const callTool = vi.fn(async () => toolOk(finishedPack(1)));
    const openai: OpenAiGlobals = { toolInput: { channels: ["amazon.main"] }, toolOutput: pack(), callTool };
    const host = fakeHost({ openai });
    await boot(host);
    expect(text(host, "heading")).toEqual([PACK_VIEWER_COPY.making]);
    // ui/initialize goes unanswered for its 30 seconds, then the poll runs.
    await vi.advanceTimersByTimeAsync(30_000 + 5_000);
    expect(callTool).toHaveBeenCalledWith("get_pack", { pack_id: PACK_ID });
    expect(text(host, "heading")).toEqual([PACK_VIEWER_COPY.ready]);
    expect(host.sent.some((message) => message.method === "ui/notifications/initialized")).toBe(false);
  });
});

describe("rendering untrusted results", () => {
  it("shows markup and script in the product, message and error as text, never as elements", async () => {
    const host = fakeHost();
    await connect(host);
    const markup = '<img src="https://evil.example/x" onerror="alert(1)"><script>alert(2)</script>';
    notify(host, "ui/notifications/tool-result", toolOk(pack({ product: markup, message: markup, status: "generating" })));
    expect(text(host, "product")).toEqual([markup]);
    expect(text(host, "status")).toEqual([markup]);
    notify(host, "ui/notifications/tool-result", toolOk(pack({ product: markup, status: "failed", finished: true, error: markup })));
    expect(text(host, "status")).toEqual([markup]);
    for (const element of host.doc.created) {
      expect(ALLOWED_TAGS.has(element.tagName), element.tagName).toBe(true);
      for (const name of element.attributes.keys()) {
        expect(name.startsWith("on"), name).toBe(false);
      }
    }
    expect(host.doc.root.byTag("img")).toHaveLength(0);
  });

  it("loads only curvi.ai previews", async () => {
    const host = fakeHost();
    await connect(host);
    await finishWith(host, 4);
    const sources = host.doc.root.byTag("img").map((element) => element.getAttribute("src"));
    expect(sources).toEqual([1, 2, 3, 4].map((index) => `${ORIGIN}/api/mcp/preview/tok-p${index}`));
    expect(host.doc.root.byTag("img").map((element) => element.getAttribute("alt"))).toEqual(Array(4).fill("amazon.main"));
  });
});

describe("layouts and actions", () => {
  it("draws one or two images as a card and three to eight as a carousel", async () => {
    for (const [n, layout] of [
      [1, "card"],
      [2, "card"],
      [3, "carousel"],
      [8, "carousel"],
    ] as const) {
      const host = fakeHost();
      await connect(host);
      await finishWith(host, n);
      expect(host.doc.root.getAttribute("data-layout"), String(n)).toBe(layout);
      expect(host.doc.root.byTag("li"), String(n)).toHaveLength(n);
      expect(host.doc.root.buttons(PACK_VIEWER_COPY.download), String(n)).toHaveLength(n);
      expect(host.doc.root.buttons(`See all ${n + 2} files`), String(n)).toHaveLength(1);
    }
  });

  it("opens a download with ui/open-link when the host offers it", async () => {
    const openExternal = vi.fn();
    const host = fakeHost({ openai: { openExternal } });
    await connect(host);
    await finishWith(host, 1);
    host.doc.root.buttons(PACK_VIEWER_COPY.download)[0]!.fire("click");
    expect(host.requests("ui/open-link").map((message) => message.params)).toEqual([{ url: `${ORIGIN}/api/mcp/files/tok-f1` }]);
    host.deliver({ jsonrpc: "2.0", id: host.requests("ui/open-link")[0]!.id, error: { code: -32000, message: "Link opening denied by user" } });
    await vi.advanceTimersByTimeAsync(0);
    expect(openExternal).not.toHaveBeenCalled();
  });

  it("opens a download with openExternal and redirectUrl false otherwise, else a plain window", async () => {
    const openExternal = vi.fn();
    const host = fakeHost({ openai: { openExternal } });
    await connect(host, { serverTools: {} });
    await finishWith(host, 1);
    host.doc.root.buttons(PACK_VIEWER_COPY.download)[0]!.fire("click");
    expect(openExternal).toHaveBeenCalledWith({ href: `${ORIGIN}/api/mcp/files/tok-f1`, redirectUrl: false });
    expect(host.requests("ui/open-link")).toHaveLength(0);

    const bare = fakeHost({ withOpen: true });
    await connect(bare, { serverTools: {} });
    await finishWith(bare, 1);
    bare.doc.root.buttons(PACK_VIEWER_COPY.download)[0]!.fire("click");
    expect(bare.opened).toEqual([`${ORIGIN}/api/mcp/files/tok-f1`]);
  });

  it("asks for fullscreen for See all and lists every file there, with Open in Curvi", async () => {
    const host = fakeHost();
    await connect(host);
    await finishWith(host, 3);
    host.doc.root.buttons("See all 5 files")[0]!.fire("click");
    expect(host.requests("ui/request-display-mode").map((message) => message.params)).toEqual([{ mode: "fullscreen" }]);
    host.answer("ui/request-display-mode", { mode: "fullscreen" });
    await vi.advanceTimersByTimeAsync(0);
    expect(host.doc.root.getAttribute("data-layout")).toBe("grid");
    expect(host.doc.root.byTag("li").map((element: FakeElement) => element.byClass("title")[0]!.textContent)).toEqual([
      "amazon.main",
      "amazon.main",
      "amazon.main",
      "pack.zip",
      "report.pdf",
    ]);
    host.doc.root.buttons(PACK_VIEWER_COPY.openInCurvi)[0]!.fire("click");
    expect(host.requests("ui/open-link").at(-1)!.params).toEqual({ url: `${ORIGIN}/app/jobs/${PACK_ID}` });

    // Back inline when the host leaves fullscreen.
    notify(host, "ui/notifications/host-context-changed", { displayMode: "inline" });
    expect(host.doc.root.getAttribute("data-layout")).toBe("carousel");
  });

  it("shows every file inline when the host has no fullscreen, and hands Open in Curvi to setOpenInAppUrl", async () => {
    const setOpenInAppUrl = vi.fn();
    const host = fakeHost({ openai: { setOpenInAppUrl } });
    await connect(host, CAPS, { availableDisplayModes: ["inline"] });
    await finishWith(host, 1);
    expect(setOpenInAppUrl).toHaveBeenCalledWith({ href: `${ORIGIN}/app/jobs/${PACK_ID}` });
    host.doc.root.buttons("See all 3 files")[0]!.fire("click");
    expect(host.requests("ui/request-display-mode")).toHaveLength(0);
    expect(host.doc.root.getAttribute("data-layout")).toBe("grid");
    expect(host.doc.root.buttons(PACK_VIEWER_COPY.openInCurvi)).toHaveLength(0);
  });

  it("draws again only when the view changes, so previews are not fetched again", async () => {
    const host = fakeHost();
    await connect(host);
    await finishWith(host, 3);
    const images = () => host.doc.created.filter((element) => element.tagName === "IMG").length;
    expect(images()).toBe(3);
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    notify(host, "ui/notifications/host-context-changed", { theme: "light" });
    expect(images()).toBe(3);
    expect(host.doc.documentElement.getAttribute("data-theme")).toBe("light");
  });

  it("shows the expired line when a preview no longer loads", async () => {
    const host = fakeHost();
    await connect(host);
    await finishWith(host, 2);
    host.doc.root.byTag("img")[0]!.fire("error");
    expect(text(host, "status")).toEqual([PACK_VIEWER_COPY.linkExpired]);
    expect(host.doc.root.byTag("img")).toHaveLength(0);
  });

  it("says when some images did not pass their checks", async () => {
    const host = fakeHost();
    await connect(host);
    notify(host, "ui/notifications/tool-result", toolOk(finishedPack(2, { images: [...finishedPack(2).images!.slice(0, 1), { ...finishedPack(2).images![1]!, passes_channel_rules: false }] })));
    expect(text(host, "note")).toEqual([PACK_VIEWER_COPY.someFailed]);
  });
});
