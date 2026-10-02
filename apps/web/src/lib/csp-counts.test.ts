import { describe, expect, it } from "vitest";
import { cspCountDeltas } from "./csp-counts";
import { parseCspReports, redactUrl } from "./csp-report";

function report(host: string, directive = "script-src") {
  return parseCspReports(JSON.stringify({ "csp-report": { "blocked-uri": host, "effective-directive": directive } }))[0]!;
}
describe("durable CSP counts", () => {
  it("aggregates by UTC day and bounded directive and host families without paths", () => {
    expect(cspCountDeltas([report("https://curvi.ai/a?token=x"), report("https://curvi.ai/b"), report("https://us.posthog.com/a")], "https://curvi.ai", new Date("2026-10-02"))).toEqual([
      { key: "csp|2026-10-02|script-src|self", delta: 2 },
      { key: "csp|2026-10-02|script-src|posthog.com", delta: 1 },
    ]);
  });
  it("cannot grow database cardinality using arbitrary hosts or directives", () => {
    const reports = Array.from({ length: 100 }, (_, i) => report(`https://${i}.attacker.test/a`, `unknown-${i}`));
    expect(cspCountDeltas(reports, "https://curvi.ai", new Date("2026-10-02"))).toEqual([{ key: "csp|2026-10-02|other|other", delta: 100 }]);
  });
  it("removes bearer path tokens before logging a report", () => {
    expect(redactUrl("https://curvi.ai/api/mcp/files/secret?key=also-secret")).toBe("https://curvi.ai/api/mcp/files/[token]");
  });
});
