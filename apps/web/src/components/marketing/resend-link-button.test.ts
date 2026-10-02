import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authUi } from "@curvi/pipeline/seed";
const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0, effects: [] as Array<() => unknown> }));
const state = vi.hoisted(() => ({ resend: vi.fn(), enabled: true }));
vi.mock("react", async (original) => ({ ...(await original<object>()), useState: (initial: unknown) => { const index = hooks.cursor++; if (!(index in hooks.values)) hooks.values[index] = initial; return [hooks.values[index], (next: unknown) => { hooks.values[index] = typeof next === "function" ? next(hooks.values[index]) : next; }]; }, useEffect: (effect: () => unknown) => hooks.effects.push(effect) }));
vi.mock("./turnstile", () => ({ get turnstileEnabled() { return state.enabled; }, Turnstile: () => null }));
vi.mock("@/lib/supabase/client", () => ({ createSupabaseBrowserClient: () => ({ auth: { resend: state.resend } }) }));
import { ResendLinkButton } from "./resend-link-button";
type Element = React.ReactElement<Record<string, unknown>>;
function find(node: React.ReactNode, predicate: (element: Element) => boolean): Element | undefined {
  if (!React.isValidElement(node)) return;
  const element = node as Element;
  if (predicate(element)) return element;
  for (const child of React.Children.toArray(element.props.children as React.ReactNode)) { const found = find(child, predicate); if (found) return found; }
}
function render() { hooks.cursor = 0; hooks.effects = []; return ResendLinkButton({ email: "seller@example.com", next: "/oauth/consent?authorization_id=request" }); }
beforeEach(() => { hooks.values = []; hooks.effects = []; hooks.cursor = 0; vi.clearAllMocks(); vi.useFakeTimers(); (globalThis as { React?: typeof React }).React = React; vi.stubGlobal("window", { location: { origin: "https://curvi.ai" }, setTimeout, clearTimeout }); state.resend.mockResolvedValue({ error: null }); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
describe("resend confirmation", () => {
  it("passes CAPTCHA, preserves consent and disables the control for the seeded cooldown", async () => {
    let tree = render();
    expect(find(tree, (element) => element.props.type === "button")?.props.disabled).toBe(true);
    (find(tree, (element) => element.props.action === "resend")!.props.onToken as (token: string) => void)("single-use-token");
    tree = render();
    await (find(tree, (element) => element.props.type === "button")!.props.onClick as () => Promise<void>)();
    expect(state.resend).toHaveBeenCalledWith({ type: "signup", email: "seller@example.com", options: { captchaToken: "single-use-token", emailRedirectTo: "https://curvi.ai/auth/callback?next=%2Foauth%2Fconsent%3Fauthorization_id%3Drequest" } });
    tree = render(); expect(find(tree, (element) => element.props.type === "button")?.props.disabled).toBe(true);
    expect(find(tree, (element) => element.props.action === "resend")?.props.resetKey).toBe(1);
    expect(hooks.values[0]).toBe(authUi.resendCooldownSeconds);
    for (let i = 0; i < authUi.resendCooldownSeconds; i++) { render(); hooks.effects.forEach((effect) => effect()); await vi.advanceTimersByTimeAsync(1000); }
    tree = render();
    // A fresh token is still needed after the cooldown.
    expect(find(tree, (element) => element.props.type === "button")?.props.disabled).toBe(true);
    (find(tree, (element) => element.props.action === "resend")!.props.onToken as (token: string) => void)("new-token");
    expect(find(render(), (element) => element.props.type === "button")?.props.disabled).toBe(false);
  });
});
