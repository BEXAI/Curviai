import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DOWN_CODES, SEVERITY_TABLE } from "./health-status";

// docs/phases/PHASE_20.md P20-17: every down and degraded code in the
// health severity table has an entry in docs/ops/ALERTS.md, so a new
// warning comes with its runbook line.

const ALERTS = readFileSync(new URL("../../../../docs/ops/ALERTS.md", import.meta.url), "utf8");

/** The runbook's table row for a code, written as `code` in its first cell. */
function rowFor(code: string): string | undefined {
  return ALERTS.split("\n").find((line) => line.startsWith(`| \`${code}\` |`));
}

describe("docs/ops/ALERTS.md", () => {
  it.each(SEVERITY_TABLE.filter((rule) => rule.severity !== "info").map((rule) => [rule.code, rule.severity]))(
    "explains %s (%s) with a meaning and a first action",
    (code) => {
      const row = rowFor(code);
      expect(row, `add a row for \`${code}\` to docs/ops/ALERTS.md`).toBeDefined();
      const cells = (row ?? "").split("|").map((cell) => cell.trim());
      // | `code` | means | first action |
      expect(cells.length).toBeGreaterThanOrEqual(5);
      expect(cells[2].length).toBeGreaterThan(10);
      expect(cells[3].length).toBeGreaterThan(10);
    },
  );

  it("lists the down codes under Down", () => {
    const down = ALERTS.slice(ALERTS.indexOf("### Down"), ALERTS.indexOf("### Degraded"));
    for (const code of Object.values(DOWN_CODES)) {
      expect(down).toContain(`| \`${code}\` |`);
    }
  });

  it("names both monitor keywords exactly as the health body writes them", () => {
    expect(ALERTS).toContain('`"ok":true`');
    expect(ALERTS).toContain('`"status":"ok"`');
  });

  it("covers every founder alert kind the notifiers tag", () => {
    for (const kind of ["spend_alert", "hard_stop", "llm_quota", "llm_fallback", "llm_credit_expiry", "provider_quota"]) {
      expect(ALERTS).toContain(`| \`${kind}\` |`);
    }
  });
});
