import { describe, expect, it } from "vitest";
import { isWorkspaceObjectKey } from "./object-keys";

const WS = "0b7a4d1e-5c3f-4a2b-9e8d-7c6b5a4f3e2d";
const OTHER = "9c1d2e3f-4a5b-4c6d-8e7f-0a1b2c3d4e5f";

describe("isWorkspaceObjectKey (Update.md 4.1 read side)", () => {
  it("accepts source, output and pack keys under the workspace prefix", () => {
    expect(isWorkspaceObjectKey(WS, `ws/${WS}/src/photo.jpg`)).toBe(true);
    expect(isWorkspaceObjectKey(WS, `ws/${WS}/jobs/j1/files/amazon/main.jpg`)).toBe(true);
    expect(isWorkspaceObjectKey(WS, `ws/${WS}/jobs/j1/pack/amazon.zip`)).toBe(true);
  });

  it("rejects another workspace's keys, lookalikes, traversal and empty values", () => {
    expect(isWorkspaceObjectKey(WS, `ws/${OTHER}/src/photo.jpg`)).toBe(false);
    expect(isWorkspaceObjectKey(WS, `ws/${WS}x/src/photo.jpg`)).toBe(false);
    expect(isWorkspaceObjectKey(WS, `ws/${WS}/../${OTHER}/src/photo.jpg`)).toBe(false);
    expect(isWorkspaceObjectKey(WS, `ws/${WS}/src\\..\\x`)).toBe(false);
    expect(isWorkspaceObjectKey(WS, "uploads/legacy.jpg")).toBe(false);
    expect(isWorkspaceObjectKey(WS, null)).toBe(false);
    expect(isWorkspaceObjectKey("", "ws//src/a.jpg")).toBe(false);
  });
});
