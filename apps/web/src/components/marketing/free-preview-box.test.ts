import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Exercise the component's handlers without uploading a photo or enabling
// the server feature. Hooks retain state across our explicit renders.
const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0, effects: [] as (() => unknown)[] }));
const challenge = vi.hoisted(() => ({ enabled: false }));
vi.mock("@/components/marketing/turnstile", () => ({
  get turnstileEnabled() { return challenge.enabled; },
  Turnstile: () => null,
}));
vi.mock("react", async (original) => ({
  ...(await original<object>()),
  useState: (initial: unknown) => {
    const i = hooks.cursor++;
    if (!(i in hooks.values)) hooks.values[i] = initial;
    return [hooks.values[i], (next: unknown) => { hooks.values[i] = typeof next === "function" ? next(hooks.values[i]) : next; }];
  },
  useRef: () => ({ current: null }),
  useEffect: (effect: () => unknown) => { hooks.effects.push(effect); },
}));

const { FreePreviewBox } = await import("./free-preview-box");
type Element = React.ReactElement<Record<string, unknown>>;
function find(node: React.ReactNode, predicate: (element: Element) => boolean): Element | undefined {
  if (!React.isValidElement(node)) return;
  const element = node as Element;
  if (predicate(element)) return element;
  for (const child of React.Children.toArray(element.props.children as React.ReactNode)) {
    const found = find(child, predicate);
    if (found) return found;
  }
}
function render(props: Parameters<typeof FreePreviewBox>[0]) {
  hooks.cursor = 0;
  return FreePreviewBox(props);
}
function handler(element: Element | undefined, name: string) {
  expect(element, name).toBeDefined();
  return element!.props[name] as (event?: unknown) => unknown;
}

beforeEach(() => {
  challenge.enabled = false;
  hooks.values = [];
  hooks.effects = [];
  hooks.cursor = 0;
  (globalThis as { React?: typeof React }).React = React;
  vi.stubEnv("NEXT_PUBLIC_FREE_PREVIEW", "1");
  vi.stubGlobal("window", { location: { assign: vi.fn() } });
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("preview handoff and consent", () => {
  it("requires a challenge token and resets it after an attempted upload", async () => {
    challenge.enabled = true;
    const file = new File(["original"], "photo.png", { type: "image/png" });
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => init
      ? Response.json({ error: "Please try again." }, { status: 403 })
      : Response.json({ available: true }));
    vi.stubGlobal("fetch", fetch);
    render({ file });
    hooks.effects[0]();
    await vi.waitFor(() => expect(hooks.values[0]).toBe(true));
    let tree = render({ file });
    let button = find(tree, (e) => e.props["data-testid"] === "free-preview-use-photo");
    expect(button?.props.disabled).toBe(true);
    await handler(button, "onClick")();
    expect(fetch).toHaveBeenCalledTimes(1);
    handler(find(tree, (e) => e.props.action === "preview"), "onToken")("one-use-token");
    tree = render({ file });
    button = find(tree, (e) => e.props["data-testid"] === "free-preview-use-photo");
    expect(button?.props.disabled).toBe(false);
    await handler(button, "onClick")();
    await vi.waitFor(() => expect(hooks.values[6]).toBe(1));
    expect((fetch.mock.calls[1][1]!.body as FormData).get("captchaToken")).toBe("one-use-token");
    expect(hooks.values[5]).toBe("");
    tree = render({ file });
    expect(find(tree, (e) => e.props.action === "preview")?.props.resetKey).toBe(1);
  });

  it("keeps the signup fallback while the gate is closed and makes no upload", () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const fallback = React.createElement("a", { href: "/signup" }, "Sign up");
    vi.stubEnv("NEXT_PUBLIC_FREE_PREVIEW", "0");
    expect(render({ file: new File(["original"], "photo.jpg"), fallback })).toBe(fallback);
    hooks.effects[0]();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("uploads the original file only on the handoff click and sends unticked consent as false", async () => {
    const file = new File(["original product bytes"], "product.png", { type: "image/png" });
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      if (!init) return Response.json({ available: true });
      if (init.body instanceof FormData) return Response.json({
        status: "done", previewId: "preview", preview: "data:image/jpeg;base64,YQ==",
        checks: [], checksPass: true, fidelity: { meanDeltaE: 0.2 },
      });
      return Response.json({ url: "https://files.example/product.png" });
    });
    vi.stubGlobal("fetch", fetch);
    render({ file });
    hooks.effects[0]();
    await vi.waitFor(() => expect(hooks.values[0]).toBe(true));
    let tree = render({ file });
    expect(fetch).toHaveBeenCalledTimes(1);
    await handler(find(tree, (e) => e.props["data-testid"] === "free-preview-use-photo"), "onClick")();
    await vi.waitFor(() => expect((hooks.values[1] as { kind: string }).kind).toBe("done"));
    const sent = (fetch.mock.calls[1][1]!.body as FormData).get("photo") as File;
    expect(sent.name).toBe(file.name);
    expect(sent.type).toBe(file.type);
    expect(await sent.text()).toBe(await file.text());
    tree = render({ file });
    const consent = find(tree, (e) => e.props.id === "preview-marketing-consent");
    expect(consent?.props.checked).toBe(false);
    handler(find(tree, (e) => e.props.type === "email"), "onChange")({ target: { value: "seller@example.com" } });
    tree = render({ file });
    handler(find(tree, (e) => e.type === "form"), "onSubmit")({ preventDefault() {} });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
    expect(JSON.parse(String(fetch.mock.calls[2][1]!.body))).toMatchObject({ email: "seller@example.com", marketingConsent: false });
    handler(consent, "onChange")(true);
    tree = render({ file });
    handler(find(tree, (e) => e.type === "form"), "onSubmit")({ preventDefault() {} });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(4));
    expect(JSON.parse(String(fetch.mock.calls[3][1]!.body))).toMatchObject({ marketingConsent: true });
  });
});
