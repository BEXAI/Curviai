import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/app/app/settings/webhooks/actions", () => ({ webhookAction: vi.fn() }));
import { WebhooksPanel } from "./webhooks-panel";
vi.stubGlobal("React", React);
describe("webhook management privacy and semantics", () => {
  it("places all configuration and one-time-secret state inside the PostHog masking boundary", () => {
    const html = renderToStaticMarkup(createElement(WebhooksPanel, { configured: true, endpoints: [{ id: "endpoint", name: "Fixture", url: "https://fixture.example/private-path", enabled: false, verified: false, keyId: "key" }], deliveries: [] }));
    expect(html).toMatch(/^<div class="ph-no-capture ph-mask /);
    expect(html).toContain('data-testid="webhook-private-panel"');
    expect(html).toContain("Verify and activate");
    expect(html).toContain("sends one signed challenge");
    expect(html).not.toContain("encrypted_secret");
  });
  it("keeps disable available when wrapping-key configuration is missing", () => {
    const html = renderToStaticMarkup(createElement(WebhooksPanel, { configured: false, endpoints: [{ id: "endpoint", name: "Fixture", url: "https://fixture.example/hook", enabled: true, verified: true, keyId: "key" }], deliveries: [] }));
    expect(html).toMatch(/<button[^>]*>Disable<\/button>/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Replace signing key<\/button>/);
  });
});
