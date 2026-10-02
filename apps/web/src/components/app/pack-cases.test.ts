import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PackCases } from "./pack-cases";
describe("pack case rendering", () => {
  it("escapes seller text and gives the timeline, errors and source expiry accessible copy", () => {
    const html = renderToStaticMarkup(React.createElement(PackCases, { jobId: "10000000-0000-4000-8000-000000000001", shots: [], initial: { sourceUnavailable: true, cases: [{ id: "10000000-0000-4000-8000-000000000002", jobId: "10000000-0000-4000-8000-000000000001", category: "fidelity", status: "received", description: "<script>alert(1)</script>", shotId: null, versionId: null, feedbackLinked: true, supportLinked: false, createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z", resolvedAt: null, canReopen: false, events: [{ id: "event", actor: "seller", status: "received", message: "<script>alert(1)</script>", createdAt: "2026-10-01T00:00:00Z" }] }] } }));
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;"); expect(html).not.toContain("<script>");
    expect(html).toContain('aria-label="Case timeline"'); expect(html).toContain('for="case-description"');
    expect(html).toContain("Upload a new photo"); expect(html).toContain("does not extend photo storage");
    expect(html).toContain("Your existing pack feedback is linked");
    expect(html).not.toContain("Private operator notes");
    expect(html).toContain('class="ph-no-capture ph-mask space-y-6"');
  });
});
