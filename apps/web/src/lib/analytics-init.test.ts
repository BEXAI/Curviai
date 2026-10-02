import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PostHog, PostHogConfig } from "posthog-js";
import { initializeAnalytics } from "./analytics-init";

const order: string[] = [];
const sdk = {
  __loaded: false,
  init: vi.fn((_key: string, _config: Partial<PostHogConfig>) => { sdk.__loaded = true; order.push("init"); }),
  set_config: vi.fn((_config: Partial<PostHogConfig>) => { order.push("configure"); }),
  has_opted_out_capturing: vi.fn(() => false),
  opt_in_capturing: vi.fn((_options: { captureEventName: false }) => { order.push("opt-in"); }),
};
beforeEach(() => { sdk.__loaded = false; order.length = 0; vi.clearAllMocks(); sdk.has_opted_out_capturing.mockReturnValue(false); });

describe("analytics initialization privacy", () => {
  it("initializes the real SDK boundary with DOM capture and replay disabled while keeping pageviews", () => {
    initializeAnalytics(sdk as unknown as PostHog, "fixture-public-project-key", "https://analytics.example.test");
    expect(sdk.init).toHaveBeenCalledExactlyOnceWith("fixture-public-project-key", expect.objectContaining({
      api_host: "https://analytics.example.test", autocapture: false, disable_session_recording: true,
      capture_pageview: "history_change", capture_pageleave: true,
    }));
    expect(sdk.opt_in_capturing).not.toHaveBeenCalled();
  });
  it("restores local privacy restrictions before reconsent can resume capture on an existing instance", () => {
    sdk.__loaded = true; sdk.has_opted_out_capturing.mockReturnValue(true);
    initializeAnalytics(sdk as unknown as PostHog, "fixture-public-project-key", "https://analytics.example.test");
    expect(sdk.init).not.toHaveBeenCalled();
    expect(sdk.set_config).toHaveBeenCalledExactlyOnceWith({ autocapture: false, disable_session_recording: true });
    expect(order).toEqual(["configure", "opt-in"]);
    expect(sdk.opt_in_capturing).toHaveBeenCalledExactlyOnceWith({ captureEventName: false });
  });
  it("hardens an already-consented instance without starting a new session or synthetic opt-in event", () => {
    sdk.__loaded = true;
    initializeAnalytics(sdk as unknown as PostHog, "fixture-public-project-key", "https://analytics.example.test");
    expect(order).toEqual(["configure"]);
    expect(sdk.init).not.toHaveBeenCalled();
    expect(sdk.opt_in_capturing).not.toHaveBeenCalled();
  });
});
