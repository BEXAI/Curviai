import { describe, expect, it } from "vitest";
import { z } from "zod";
import { IntakeResult, ProductProfile, QCVerdict, ShotList, strictToolSchema } from "./schemas";

const UNSUPPORTED = [
  "$schema",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "pattern",
  "maxItems",
];

function walk(node: unknown, visit: (obj: Record<string, unknown>) => void): void {
  if (Array.isArray(node)) {
    node.forEach((n) => walk(n, visit));
  } else if (node && typeof node === "object") {
    visit(node as Record<string, unknown>);
    Object.values(node as Record<string, unknown>).forEach((n) => walk(n, visit));
  }
}

describe("strictToolSchema", () => {
  for (const [name, schema] of Object.entries({ IntakeResult, ProductProfile, ShotList, QCVerdict })) {
    it(`${name} has only keywords Anthropic strict tool use accepts`, () => {
      const out = strictToolSchema(schema);
      walk(out, (obj) => {
        for (const key of UNSUPPORTED) {
          // A property literally named like a keyword is data, so only check
          // schema nodes (those with a type or a combinator).
          if ("type" in obj || "anyOf" in obj) {
            expect(obj, `${name} keeps ${key}`).not.toHaveProperty(key);
          }
        }
        if (typeof obj.minItems === "number") {
          expect(obj.minItems).toBeLessThanOrEqual(1);
        }
        if (obj.type === "object") {
          expect(obj.additionalProperties).toBe(false);
        }
      });
    });
  }

  it("keeps property names that match keywords and keeps enums", () => {
    const out = strictToolSchema(
      z.object({ pattern: z.string().regex(/^a/), kind: z.enum(["a", "b"]), tags: z.array(z.string()).min(3).max(5) }),
    ) as { properties: Record<string, Record<string, unknown>>; required: string[] };
    expect(Object.keys(out.properties)).toEqual(["pattern", "kind", "tags"]);
    expect(out.properties.pattern).toEqual({ type: "string" });
    expect(out.properties.kind.enum).toEqual(["a", "b"]);
    expect(out.properties.tags.minItems).toBe(1);
    expect(out.required).toEqual(["pattern", "kind", "tags"]);
  });
});
