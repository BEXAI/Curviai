import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONSENT_CHANGED_EVENT } from "@/lib/consent";

const state = vi.hoisted(() => ({ effects: [] as Array<() => (() => void) | undefined>, optedOut: false }));
const posthog = vi.hoisted(() => ({
  __loaded: false,
  init: vi.fn(), set_config: vi.fn(), has_opted_out_capturing: vi.fn(),
  opt_in_capturing: vi.fn(), opt_out_capturing: vi.fn(), capture: vi.fn(),
}));
vi.mock("react", () => ({ useEffect: (effect: () => (() => void) | undefined) => state.effects.push(effect) }));
vi.mock("posthog-js", () => ({ default: posthog }));
const { Analytics } = await import("./analytics");
const { trackBillingEvent } = await import("@/lib/billing/analytics");
let browser: EventTarget;
let documentFixture: { cookie: string };
let cleanup: (() => void) | undefined;
async function flush() { await vi.waitFor(() => expect(posthog.init.mock.calls.length + posthog.opt_out_capturing.mock.calls.length + posthog.set_config.mock.calls.length).toBeGreaterThan(0)); }
function consent(choice: "granted" | "denied") {
  documentFixture.cookie = `curvi_consent=${choice}`;
  browser.dispatchEvent(new CustomEvent(CONSENT_CHANGED_EVENT, { detail: choice }));
}
beforeEach(() => {
  vi.clearAllMocks(); state.effects.length = 0; state.optedOut = false; posthog.__loaded = false;
  posthog.init.mockImplementation(() => { posthog.__loaded = true; });
  posthog.has_opted_out_capturing.mockImplementation(() => state.optedOut);
  posthog.opt_out_capturing.mockImplementation(() => { state.optedOut = true; });
  posthog.opt_in_capturing.mockImplementation(() => { state.optedOut = false; });
  browser = new EventTarget(); documentFixture = { cookie: "" };
  vi.stubGlobal("window", browser); vi.stubGlobal("document", documentFixture);
  vi.stubEnv("NEXT_PUBLIC_POSTHOG_KEY", "fixture-public-project-key");
  vi.stubEnv("NEXT_PUBLIC_POSTHOG_HOST", "https://analytics.example.test");
});
afterEach(() => { cleanup?.(); cleanup = undefined; vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("Analytics consent effect", () => {
  it("does not initialize from a queued SDK import when consent was withdrawn before it resolves", async () => {
    Analytics(); cleanup = state.effects[0]();
    consent("granted");
    consent("denied");
    await vi.dynamicImportSettled();
    expect(posthog.init).not.toHaveBeenCalled();
    expect(posthog.capture).not.toHaveBeenCalled();
    expect(posthog.opt_in_capturing).not.toHaveBeenCalled();
  });
  it("does not initialize from an SDK import that resolves after the effect unmounts", async () => {
    documentFixture.cookie = "curvi_consent=granted";
    Analytics(); cleanup = state.effects[0](); cleanup?.(); cleanup = undefined;
    await vi.dynamicImportSettled();
    expect(posthog.init).not.toHaveBeenCalled();
  });
  it("leaves the SDK untouched before consent, then initializes with privacy restrictions", async () => {
    Analytics(); cleanup = state.effects[0]();
    expect(posthog.init).not.toHaveBeenCalled();
    consent("denied");
    expect(posthog.init).not.toHaveBeenCalled();
    expect(posthog.opt_out_capturing).not.toHaveBeenCalled();
    consent("granted"); await flush();
    expect(posthog.init).toHaveBeenCalledExactlyOnceWith("fixture-public-project-key", expect.objectContaining({ autocapture: false, disable_session_recording: true, capture_pageview: "history_change" }));
  });
  it("preserves explicit billing events while consented, then stops them and opts out on withdrawal", async () => {
    documentFixture.cookie = "curvi_consent=granted";
    Analytics(); cleanup = state.effects[0](); await flush();
    trackBillingEvent("portal_opened", { source: "billing" });
    await vi.waitFor(() => expect(posthog.capture).toHaveBeenCalledExactlyOnceWith("portal_opened", { source: "billing" }));
    consent("denied");
    await vi.waitFor(() => expect(posthog.opt_out_capturing).toHaveBeenCalledTimes(1));
    trackBillingEvent("portal_opened", { source: "billing" });
    expect(posthog.capture).toHaveBeenCalledTimes(1);
    consent("granted");
    await vi.waitFor(() => expect(posthog.opt_in_capturing).toHaveBeenCalledExactlyOnceWith({ captureEventName: false }));
    expect(posthog.set_config).toHaveBeenCalledWith({ autocapture: false, disable_session_recording: true });
    expect(posthog.init).toHaveBeenCalledTimes(1);
  });
  it("does not initialize without configuration, and removes the listener on unmount", async () => {
    vi.stubEnv("NEXT_PUBLIC_POSTHOG_KEY", ""); Analytics(); cleanup = state.effects[0]();
    consent("granted"); expect(posthog.init).not.toHaveBeenCalled();
    vi.stubEnv("NEXT_PUBLIC_POSTHOG_KEY", "fixture-public-project-key");
    Analytics(); cleanup = state.effects[1](); await flush();
    cleanup?.(); cleanup = undefined;
    consent("denied");
    expect(posthog.opt_out_capturing).not.toHaveBeenCalled();
  });
});
