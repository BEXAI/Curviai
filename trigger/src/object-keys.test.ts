import { describe, expect, it } from "vitest";
import { isWorkspaceObjectKey } from "./object-keys";

describe("isWorkspaceObjectKey (4.1 worker side)", () => {
  it("accepts keys under the workspace's own prefix", () => {
    expect(isWorkspaceObjectKey("ws1", "ws/ws1/src/photo.jpg")).toBe(true);
    expect(isWorkspaceObjectKey("ws1", "ws/ws1/jobs/j1/files/amazon/SKU.MAIN.jpg")).toBe(true);
  });

  it("refuses other tenants, prefix look alikes, traversal and junk", () => {
    expect(isWorkspaceObjectKey("ws1", "ws/ws2/src/photo.jpg")).toBe(false);
    expect(isWorkspaceObjectKey("ws1", "ws/ws10/src/photo.jpg")).toBe(false);
    expect(isWorkspaceObjectKey("ws1", "ws/ws1/../ws2/src/photo.jpg")).toBe(false);
    expect(isWorkspaceObjectKey("ws1", "ws/ws1/src\\photo.jpg")).toBe(false);
    expect(isWorkspaceObjectKey("ws1", "m1")).toBe(false);
    expect(isWorkspaceObjectKey("", "ws//src/photo.jpg")).toBe(false);
    expect(isWorkspaceObjectKey("ws1", null)).toBe(false);
    expect(isWorkspaceObjectKey("ws1", undefined)).toBe(false);
  });
});
