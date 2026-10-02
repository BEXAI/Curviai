import { Worker } from "node:worker_threads";
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

  it.each([
    ['"a ``` marker"', "a ``` marker"],
    ['```\n[1,2]\n```', [1, 2]],
    ['```json\uFEFF\u00a0\n{"a":2}\n```', { a: 2 }],
    ['```jsontrue```', true],
    ['```python\n{"a":3}\n```', { a: 3 }],
    ['```json\nnot JSON``` then {"a":4}', { a: 4 }],
    ['```json\n{"a":5}', { a: 5 }],
    ['```not JSON``` then ```[1,2]```', null],
  ])("preserves whole-text, first-fence and outer-object precedence for %s", (text, expected) => {
    expect(jsonFromText(text)).toEqual(expected);
  });

  it.each(["```", "```json"])("finishes a large whitespace response after %s with no closing fence", async (fence) => {
    // Isolate the adversarial input so a backtracking regression is killed
    // instead of blocking the test runner's own timeout indefinitely.
    const worker = new Worker(`
      const { parentPort, workerData } = require("node:worker_threads");
      const parse = (${jsonFromText.toString()});
      parentPort.postMessage(parse(workerData));
    `, { eval: true, workerData: fence + " \t\n".repeat(400_000) + "not JSON" });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await new Promise<unknown>((resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("Incomplete fence parsing did not finish")), 5_000);
        worker.once("message", resolve);
        worker.once("error", reject);
      });
      expect(result).toBeNull();
    } finally {
      clearTimeout(timeout);
      await worker.terminate();
    }
  }, 10_000);

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
