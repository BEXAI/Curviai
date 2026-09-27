import { describe, expect, it } from "vitest";
import { ProviderRegistry } from "./registry";
import { MockProvider } from "./testing";

describe("ProviderRegistry", () => {
  it("registers and gets providers by name", () => {
    const registry = new ProviderRegistry();
    const provider = new MockProvider({ name: "mock-llm", kind: "llm" });
    registry.register(provider);
    expect(registry.get("mock-llm")).toBe(provider);
    expect(registry.get("missing")).toBeUndefined();
  });

  it("throws on duplicate registration", () => {
    const registry = new ProviderRegistry();
    registry.register(new MockProvider({ name: "dup" }));
    expect(() => registry.register(new MockProvider({ name: "dup" }))).toThrow(/already registered/);
  });

  it("lists providers by kind", () => {
    const registry = new ProviderRegistry();
    const llm = new MockProvider({ name: "a", kind: "llm" });
    const image1 = new MockProvider({ name: "b", kind: "image" });
    const image2 = new MockProvider({ name: "c", kind: "image" });
    registry.register(llm);
    registry.register(image1);
    registry.register(image2);
    expect(registry.listByKind("image")).toEqual([image1, image2]);
    expect(registry.listByKind("llm")).toEqual([llm]);
    expect(registry.listByKind("video")).toEqual([]);
    expect(registry.list()).toHaveLength(3);
  });
});
