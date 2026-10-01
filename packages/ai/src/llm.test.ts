import { describe, expect, it } from "vitest";
import { isLlmResult, jsonFromText, llmEffortFor, llmProviderFamilyOf, type LlmResult } from "./llm";

const result: LlmResult = {
  json: { a: 1 },
  text: "",
  finish: "complete",
  usage: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, reasoningTokens: 0 },
  raw: null,
};

describe("neutral LLM contract helpers", () => {
  it("tells an adapter's LlmResult from an answer a test provider returns directly", () => {
    expect(isLlmResult(result)).toBe(true);
    expect(isLlmResult({ ...result, json: null })).toBe(true);
    expect(isLlmResult({ a: 1 })).toBe(false);
    expect(isLlmResult({ json: {}, text: "x" })).toBe(false);
    expect(isLlmResult(null)).toBe(false);
    expect(isLlmResult("text")).toBe(false);
  });

  it("finds JSON in a text answer: whole, fenced, or the outer object", () => {
    expect(jsonFromText('{"a":1}')).toEqual({ a: 1 });
    expect(jsonFromText('Result:\n```json\n{"a":2}\n```')).toEqual({ a: 2 });
    expect(jsonFromText('Here it is {"a":{"b":3}} hope that helps')).toEqual({ a: { b: 3 } });
    expect(jsonFromText("no json here")).toBeNull();
    expect(jsonFromText("")).toBeNull();
  });

  it("takes the model's own effort first, then the request effort, else none", () => {
    const request = { effort: "low" as const, modelOptions: { m1: { effort: "high" as const }, m2: {} } };
    expect(llmEffortFor(request, "m1")).toBe("high");
    expect(llmEffortFor(request, "m2")).toBe("low");
    expect(llmEffortFor(request, "m3")).toBe("low");
    expect(llmEffortFor({ modelOptions: { m1: { effort: "none" } } }, "m2")).toBeUndefined();
    expect(llmEffortFor({ modelOptions: { m1: { effort: "none" } } }, "m1")).toBe("none");
  });

  it("reads the provider family from a registered LLM provider name", () => {
    expect(llmProviderFamilyOf("openai:gpt-6-luna")).toBe("openai");
    expect(llmProviderFamilyOf("anthropic:claude-sonnet-5")).toBe("anthropic");
    expect(llmProviderFamilyOf("mock-llm")).toBeNull();
    expect(llmProviderFamilyOf(":odd")).toBeNull();
  });
});
