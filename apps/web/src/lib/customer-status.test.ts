import { describe, expect, it } from "vitest";
import { customerStatus } from "./customer-status";
describe("customer status", () => {
  it("shows normal service only with a successful health read", () => {
    expect(customerStatus({ status: "ok" }, { acquisition: "open" }).every((line) => line.state === "Working normally")).toBe(true);
    expect(customerStatus(null, null).every((line) => line.state === "Slower than usual")).toBe(true);
  });
  it("shows a quota pause without exposing a provider name or internal code", () => {
    const lines = customerStatus({ status: "degraded", degradedBy: ["packs_paused:quota", "provider_quota:fal"] }, { acquisition: "waitlist" });
    expect(lines[0]?.state).toBe("Paused"); expect(lines[1]?.state).toBe("Paused");
    expect(JSON.stringify(lines)).not.toMatch(/fal|quota|provider/i);
  });
  it("separates paused scenes from other service availability", () => {
    const lines = customerStatus({ status: "degraded", degradedBy: ["scenes_paused"] }, { acquisition: "open" });
    expect(lines[1]?.state).toBe("Paused"); expect(lines[0]?.state).toBe("Slower than usual");
  });
});
