import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  OPENAI_STRICT_SCHEMA_LIMITS,
  openaiNullsToUndefined,
  openaiRootNeedsWrap,
  openaiSchemaLimitProblems,
  openaiSchemaSize,
  openaiStrictJsonSchema,
} from "./openaiSchema";

describe("openaiStrictJsonSchema", () => {
  const source = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: {
      name: { type: "string", minLength: 1, maxLength: 40, pattern: "^[a-z]+$" },
      count: { type: "integer", minimum: 0, maximum: 9, exclusiveMinimum: -1, multipleOf: 1 },
      site: { type: "string", format: "uri" },
      when: { type: "string", format: "date-time" },
      tags: { type: "array", items: { type: "string", maxLength: 10 }, minItems: 2, maxItems: 5 },
      kind: { type: "string", enum: ["a", "b"] },
      fixed: { const: "x" },
      nested: {
        type: "object",
        properties: { deep: { type: "boolean" } },
        required: [],
        additionalProperties: true,
      },
      maybe: { anyOf: [{ type: "string" }, { type: "null" }] },
      either: { oneOf: [{ type: "string" }, { type: "number" }] },
      blended: { allOf: [{ type: "string" }], not: { type: "number" }, if: {}, then: {}, else: {}, type: "string" },
      described: { type: "object", description: "a box", properties: { x: { type: "number" } }, required: ["x"] },
    },
    required: ["name", "count", "maybe"],
    additionalProperties: false,
  };
  const out = openaiStrictJsonSchema(source) as {
    properties: Record<string, Record<string, unknown>>;
    required: string[];
    additionalProperties: boolean;
  };

  it("lists every property in required and makes the optional ones nullable", () => {
    expect(out.required).toEqual(Object.keys(source.properties));
    expect(out.additionalProperties).toBe(false);
    expect(out.properties.name.type).toBe("string");
    expect(out.properties.count.type).toBe("integer");
    expect(out.properties.when.type).toEqual(["string", "null"]);
    expect(out.properties.kind).toEqual({ type: ["string", "null"], enum: ["a", "b", null] });
    // Objects and arrays become an anyOf with null, keeping their keywords whole.
    expect(out.properties.tags).toEqual({
      anyOf: [{ type: "array", items: { type: "string" }, minItems: 2, maxItems: 5 }, { type: "null" }],
    });
    expect(out.properties.nested).toEqual({
      anyOf: [
        {
          type: "object",
          properties: { deep: { type: ["boolean", "null"] } },
          required: ["deep"],
          additionalProperties: false,
        },
        { type: "null" },
      ],
    });
    expect(out.properties.described).toEqual({
      description: "a box",
      anyOf: [
        { type: "object", properties: { x: { type: "number" } }, required: ["x"], additionalProperties: false },
        { type: "null" },
      ],
    });
    // A required nullable field stays as it was.
    expect(out.properties.maybe).toEqual({ anyOf: [{ type: "string" }, { type: "null" }] });
    expect(out.properties.either).toEqual({ anyOf: [{ type: "string" }, { type: "number" }, { type: "null" }] });
  });

  it("keeps the supported keywords and strips the rest", () => {
    expect(out).not.toHaveProperty("$schema");
    expect(out.properties.name).toEqual({ type: "string", pattern: "^[a-z]+$" });
    expect(out.properties.count).toEqual({ type: "integer", minimum: 0, maximum: 9, exclusiveMinimum: -1, multipleOf: 1 });
    expect(out.properties.site).toEqual({ type: ["string", "null"] });
    expect(out.properties.when).toMatchObject({ format: "date-time" });
    expect(out.properties.fixed).toEqual({ enum: ["x", null] });
    expect(out.properties.blended).toEqual({ type: ["string", "null"] });
  });

  it("is stable when applied twice", () => {
    expect(openaiStrictJsonSchema(out)).toEqual(out);
  });

  it("wraps a root that is not an object, keeping definitions at the root", () => {
    expect(openaiRootNeedsWrap({ type: "object", properties: {} })).toBe(false);
    expect(openaiRootNeedsWrap({ type: "array" })).toBe(true);
    expect(openaiRootNeedsWrap({ anyOf: [{ type: "object", properties: {} }] })).toBe(true);
    const wrapped = openaiStrictJsonSchema({ $ref: "#/$defs/Item", $defs: { Item: { type: "object", properties: { a: { type: "string" } } } } });
    expect(wrapped).toEqual({
      type: "object",
      properties: { value: { $ref: "#/$defs/Item" } },
      required: ["value"],
      additionalProperties: false,
      $defs: {
        Item: { type: "object", properties: { a: { type: ["string", "null"] } }, required: ["a"], additionalProperties: false },
      },
    });
  });

  it("makes an optional reference nullable through anyOf", () => {
    const converted = openaiStrictJsonSchema({
      type: "object",
      properties: { item: { $ref: "#/$defs/Item" } },
      $defs: { Item: { type: "string" } },
    }) as { properties: Record<string, unknown> };
    expect(converted.properties.item).toEqual({ anyOf: [{ $ref: "#/$defs/Item" }, { type: "null" }] });
  });
});

describe("openai schema limits", () => {
  it("counts properties, object nesting and enum values", () => {
    const schema = {
      type: "object",
      properties: {
        a: { type: "string", enum: ["x", "y", "z"] },
        b: { type: "array", items: { type: "object", properties: { c: { type: "object", properties: { d: { type: "number" } } } } } },
      },
    };
    expect(openaiSchemaSize(schema)).toEqual({ properties: 4, nestingDepth: 3, enumValues: 3 });
    expect(openaiSchemaLimitProblems(schema)).toEqual([]);
  });

  it("reports each broken limit", () => {
    let deep: Record<string, unknown> = { type: "string" };
    for (let i = 0; i < OPENAI_STRICT_SCHEMA_LIMITS.maxNestingDepth + 1; i++) {
      deep = { type: "object", properties: { n: deep } };
    }
    expect(openaiSchemaLimitProblems(deep)).toEqual(["11 levels of nesting, the limit is 10"]);
    const wide = {
      type: "object",
      properties: Object.fromEntries(Array.from({ length: 5001 }, (_, i) => [`p${i}`, { type: "string" }])),
    };
    expect(openaiSchemaLimitProblems(wide)).toEqual(["5001 properties, the limit is 5000"]);
    const enums = { type: "object", properties: { e: { type: "string", enum: Array.from({ length: 1001 }, (_, i) => `v${i}`) } } };
    expect(openaiSchemaLimitProblems(enums)).toEqual(["1001 enum values, the limit is 1000"]);
  });
});

describe("openaiNullsToUndefined", () => {
  const schema = {
    type: "object",
    properties: {
      label: { type: "string" },
      note: { type: "string" },
      styleNotes: { anyOf: [{ type: "string" }, { type: "null" }] },
      items: {
        type: "array",
        items: { type: "object", properties: { a: { type: "string" }, b: { type: "string" } }, required: ["a"] },
      },
      pick: { anyOf: [{ $ref: "#/$defs/Pick" }, { type: "null" }] },
    },
    required: ["label", "styleNotes"],
    $defs: { Pick: { type: "object", properties: { id: { type: "string" }, why: { type: "string" } }, required: ["id"] } },
  };

  it("removes nulls on optional fields only, at every depth", () => {
    const answer = {
      label: "mug",
      note: null,
      styleNotes: null,
      items: [{ a: "x", b: null }, { a: "y", b: "z" }],
      pick: { id: "1", why: null },
      extra: null,
    };
    expect(openaiNullsToUndefined(answer, schema)).toEqual({
      label: "mug",
      styleNotes: null,
      items: [{ a: "x" }, { a: "y", b: "z" }],
      pick: { id: "1" },
      extra: null,
    });
  });

  it("leaves values the schema does not describe alone", () => {
    expect(openaiNullsToUndefined("text", schema)).toBe("text");
    expect(openaiNullsToUndefined(null, schema)).toBeNull();
    expect(openaiNullsToUndefined({ a: null }, undefined)).toEqual({ a: null });
  });
});

describe("openaiSchema module", () => {
  it("imports nothing, so client safe modules can read it", () => {
    const source = readFileSync(new URL("./openaiSchema.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/^\s*import\b/m);
  });
});
