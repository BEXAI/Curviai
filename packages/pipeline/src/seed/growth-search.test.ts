import { describe, expect, it } from "vitest";
import { getSpec, hasSpec } from "@curvi/specs";
import { platformSettingSeedRows } from "./credits";
import { STORE_AUDIT_SWITCH_KEY, mainImageCheckerSpecIds, searchSwitches, storeAudit } from "./growth";

// Lane 7 Search (P18-10, P18-18): the seeded checker specs and store audit
// numbers.

describe("main image checker specs", () => {
  it("name main image specs in the registry, one per channel, Amazon first", () => {
    expect(mainImageCheckerSpecIds[0]).toBe("amazon.main");
    const families = mainImageCheckerSpecIds.map((id) => id.split(".")[0]);
    expect(new Set(families).size).toBe(families.length);
    for (const id of mainImageCheckerSpecIds) {
      expect(hasSpec(id), id).toBe(true);
      expect(getSpec(id).textAllowed, id).toBe(false);
    }
  });
});

describe("store audit", () => {
  it("bounds every audit with positive whole numbers", () => {
    for (const [key, value] of Object.entries(storeAudit)) {
      expect(Number.isInteger(value) && value > 0, key).toBe(true);
    }
  });

  it("keeps the plan's caps: 25 products and 3 audits an hour per IP", () => {
    expect(storeAudit.maxProducts).toBe(25);
    expect(storeAudit.auditsPerIpPerHour).toBe(3);
    expect(storeAudit.imageTimeoutMs).toBe(10_000);
    expect(storeAudit.imageConcurrency).toBe(4);
  });

  it("finishes inside a minute even when every image times out", () => {
    expect(storeAudit.auditDeadlineMs + storeAudit.imageTimeoutMs).toBeLessThan(60_000);
    expect(storeAudit.productListTimeoutMs).toBeLessThan(storeAudit.auditDeadlineMs);
  });

  it("ships switched off, seeded into platform_settings", () => {
    expect(searchSwitches).toEqual([{ key: STORE_AUDIT_SWITCH_KEY, value: false }]);
    expect(platformSettingSeedRows).toContainEqual({ key: STORE_AUDIT_SWITCH_KEY, value: false });
  });
});
