import { describe, expect, it } from "vitest";
import { isWorkspaceObjectKey, isWorkspaceTmpKey } from "./object-keys";

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

it("temporary keys stay within their workspace and cannot be treated as source keys", () => {
  expect(isWorkspaceTmpKey("w1", "tmp/ws/w1/cache/a")).toBe(true);
  for (const key of ["tmp/ws/w2/cache/a", "tmp/ws/w10/a", "tmp/ws/w1/../a", "tmp/ws/w1/a\\b", "ws/w1/src/a"]) {
    expect(isWorkspaceTmpKey("w1", key)).toBe(false);
  }
  expect(isWorkspaceObjectKey("w1", "tmp/ws/w1/cache/a")).toBe(false);
});
