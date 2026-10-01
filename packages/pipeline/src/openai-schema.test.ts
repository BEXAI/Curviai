/**
 * openaiStrictSchema against the 9 tool schemas the recipes send, and the
 * null round trip: an OpenAI strict answer that leaves every optional field
 * null, run through the OpenAI adapter (mock fetch), still passes the
 * lenient answer schemas the runner parses with.
 */

import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { OpenaiLLMProvider, openaiSchemaSize, type LlmRequest, type LlmResult } from "@curvi/ai";
import { PackCopyResult } from "./ad-copy";
import { AplusCopyResult } from "./aplus-copy";
import { PaletteNaming } from "./brand/palette";
import { QuestionPlanAnswer, QuestionPlanTool } from "./questions";
import {
  IntakeAnswer,
  IntakeResult,
  IntakeToolResult,
  LlmShotList,
  openaiStrictSchema,
  ProductProfile,
  ProductProfileAnswer,
  QCVerdict,
  strictToolSchema,
  TargetPick,
  TargetPickAnswer,
} from "./schemas";

/** Each tool schema with the schema its answer is parsed with. */
const TOOL_SCHEMAS: Record<string, { tool: z.ZodType; answer: z.ZodType }> = {
  IntakeToolResult: { tool: IntakeToolResult, answer: IntakeAnswer },
  ProductProfile: { tool: ProductProfile, answer: ProductProfileAnswer },
  LlmShotList: { tool: LlmShotList, answer: LlmShotList },
  QCVerdict: { tool: QCVerdict, answer: QCVerdict },
  TargetPick: { tool: TargetPick, answer: TargetPickAnswer },
  PackCopyResult: { tool: PackCopyResult, answer: PackCopyResult },
  AplusCopyResult: { tool: AplusCopyResult, answer: AplusCopyResult },
  PaletteNaming: { tool: PaletteNaming, answer: PaletteNaming },
  QuestionPlanTool: { tool: QuestionPlanTool, answer: QuestionPlanAnswer },
};

const SUPPORTED_KEYWORDS = new Set([
  "type",
  "description",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "enum",
  "anyOf",
  "$defs",
  "$ref",
  "pattern",
  "format",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minItems",
  "maxItems",
]);

type Node = Record<string, unknown>;

/** Visits every schema node (property maps are names, not nodes). */
function walkSchema(node: unknown, visit: (n: Node) => void): void {
  if (Array.isArray(node)) {
    node.forEach((n) => walkSchema(n, visit));
    return;
  }
  if (!node || typeof node !== "object") return;
  const n = node as Node;
  visit(n);
  for (const [key, value] of Object.entries(n)) {
    if ((key === "properties" || key === "$defs") && value && typeof value === "object") {
      Object.values(value).forEach((sub) => walkSchema(sub, visit));
    } else if (key === "items" || key === "anyOf") {
      walkSchema(value, visit);
    }
  }
}

/**
 * The answer a strict model gives when it leaves every optional field
 * empty: null wherever null is allowed, the smallest valid value elsewhere.
 */
function sparseAnswer(node: Node): unknown {
  const types = Array.isArray(node.type) ? (node.type as string[]) : node.type ? [node.type as string] : [];
  if (types.includes("null")) return null;
  if (Array.isArray(node.anyOf)) {
    const branches = node.anyOf as Node[];
    if (branches.some((b) => b.type === "null")) return null;
    return sparseAnswer(branches[0]);
  }
  if (Array.isArray(node.enum)) return node.enum[0];
  switch (types[0]) {
    case "object": {
      const props = (node.properties ?? {}) as Record<string, Node>;
      return Object.fromEntries(Object.entries(props).map(([k, v]) => [k, sparseAnswer(v)]));
    }
    case "array": {
      const count = typeof node.minItems === "number" ? node.minItems : 0;
      return Array.from({ length: count }, () => sparseAnswer(node.items as Node));
    }
    case "string":
      if (typeof node.pattern === "string") {
        const sample = "#336699";
        expect(new RegExp(node.pattern).test(sample), `no sample for pattern ${node.pattern}`).toBe(true);
        return sample;
      }
      return "x";
    case "integer":
    case "number": {
      const min = typeof node.minimum === "number" ? node.minimum : undefined;
      const exclusive = typeof node.exclusiveMinimum === "number" ? node.exclusiveMinimum : undefined;
      const max = typeof node.maximum === "number" ? node.maximum : undefined;
      if (exclusive !== undefined) {
        const step = types[0] === "integer" ? 1 : Math.min(0.5, max !== undefined ? (max - exclusive) / 2 : 0.5);
        return exclusive + step;
      }
      return min ?? 0;
    }
    case "boolean":
      return false;
    default:
      return null;
  }
}

describe("openaiStrictSchema on the 9 tool schemas", () => {
  for (const [name, { tool }] of Object.entries(TOOL_SCHEMAS)) {
    it(`${name} follows the strict rules and the size limits`, () => {
      const out = openaiStrictSchema(tool);
      expect(out.type).toBe("object");
      expect(out).not.toHaveProperty("anyOf");
      walkSchema(out, (node) => {
        for (const key of Object.keys(node)) {
          expect(SUPPORTED_KEYWORDS.has(key), `${name} keeps ${key}`).toBe(true);
        }
        if (node.type === "object") {
          expect(node.additionalProperties).toBe(false);
          expect(node.required).toEqual(Object.keys(node.properties as Node));
        }
      });
      const size = openaiSchemaSize(out);
      expect(size.properties).toBeLessThanOrEqual(5000);
      expect(size.nestingDepth).toBeLessThanOrEqual(10);
      expect(size.enumValues).toBeLessThanOrEqual(1000);
    });
  }

  it("keeps the bounds strict mode supports and drops string lengths", () => {
    const out = JSON.stringify(openaiStrictSchema(LlmShotList));
    expect(out).toContain('"maxItems":40');
    expect(out).not.toContain("maxLength");
    expect(out).not.toContain("minLength");
    const qc = openaiStrictSchema(QCVerdict) as { properties: { fidelity: Node } };
    expect(qc.properties.fidelity).toMatchObject({ minimum: 0, maximum: 1 });
  });

  it("makes an optional field a union with null and keeps a nullable one as it was", () => {
    const pick = openaiStrictSchema(TargetPick) as { properties: { choice: Node } };
    expect(pick.properties.choice.anyOf).toEqual(expect.arrayContaining([{ type: "null" }]));
    const optional = openaiStrictSchema(z.object({ a: z.string(), b: z.number().optional() })) as {
      properties: Node;
      required: string[];
    };
    expect(optional.required).toEqual(["a", "b"]);
    expect(optional.properties.b).toEqual({ type: ["number", "null"] });
  });

  it("throws when a schema breaks a size limit", () => {
    const wide = z.object(Object.fromEntries(Array.from({ length: 5001 }, (_, i) => [`p${i}`, z.string()])));
    expect(() => openaiStrictSchema(wide)).toThrow(/5001 properties/);
  });
});

describe("null round trip through the OpenAI adapter", () => {
  function adapterFor(answer: (sentSchema: Node) => unknown) {
    const fetchFn = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { text: { format: { schema: Node } } };
      const text = JSON.stringify(answer(body.text.format.schema));
      return new Response(
        JSON.stringify({
          status: "completed",
          output: [{ type: "message", content: [{ type: "output_text", text }] }],
          usage: { input_tokens: 10, output_tokens: 10 },
        }),
      );
    }) as unknown as typeof fetch;
    return new OpenaiLLMProvider({
      name: "openai:test",
      tasks: ["t"],
      apiKey: "test-key",
      model: "test",
      priceTable: { inputMicrosPerMTok: 1, cachedInputMicrosPerMTok: 1, outputMicrosPerMTok: 1 },
      imageTokenMultiplier: 1.72,
      fetchFn,
    });
  }

  // The runner sends strictToolSchema today; the plain Zod JSON Schema is
  // checked too, so the adapter is right whichever one a request carries.
  const sources: Record<string, (s: z.ZodType) => unknown> = {
    strictToolSchema: (s) => strictToolSchema(s),
    "z.toJSONSchema": (s) => z.toJSONSchema(s),
  };

  for (const [name, { tool, answer }] of Object.entries(TOOL_SCHEMAS)) {
    for (const [source, toSchema] of Object.entries(sources)) {
      it(`${name} (${source}): nulls on optional fields pass the answer schema`, async () => {
        const sent: Node[] = [];
        const provider = adapterFor((schema) => {
          sent.push(schema);
          return sparseAnswer(schema);
        });
        const input: LlmRequest = {
          system: "s",
          messages: [{ role: "user", content: [{ type: "text", text: "{}" }] }],
          output: { name: "emit_result", schema: toSchema(tool), strict: true },
        };
        const res = await provider.invoke<LlmRequest, LlmResult>({ task: "t", input });
        const parsed = answer.safeParse(res.output.json);
        expect(parsed.success, JSON.stringify(parsed.error?.issues ?? [])).toBe(true);
        // The adapter sent the strict form: every object lists all its
        // properties as required.
        walkSchema(sent[0], (node) => {
          if (node.type === "object") expect(node.required).toEqual(Object.keys(node.properties as Node));
        });
      });
    }
  }

  it("removes an optional null the lenient schema would refuse, and keeps a required null", async () => {
    const provider = adapterFor(() => ({
      images: [
        {
          sellableProduct: true,
          distinctProducts: 1,
          boundingBoxes: null,
          sharpEnough: true,
          screenshot: null,
          products: null,
          addedOverlays: null,
          flags: { nudity: false, weapons: false, drugs: false, prohibited: false, realPersonMainSubject: false },
        },
      ],
      sellerIntent: { featureOnly: null, exclude: [], mustKeep: [], styleNotes: null },
    }));
    const res = await provider.invoke<LlmRequest, LlmResult>({
      task: "t",
      input: {
        system: "s",
        messages: [{ role: "user", content: [{ type: "text", text: "{}" }] }],
        // The input side schema: addedOverlays has a default, so it is optional.
        output: { name: "emit_result", schema: z.toJSONSchema(IntakeResult, { io: "input" }), strict: true },
      },
    });
    const json = res.output.json as { images: Node[]; sellerIntent: Node };
    expect(json.images[0]).not.toHaveProperty("boundingBoxes");
    expect(json.images[0]).not.toHaveProperty("screenshot");
    expect(json.images[0]).not.toHaveProperty("addedOverlays");
    expect(json.sellerIntent.featureOnly).toBeNull();
    const parsed = IntakeAnswer.parse(json);
    expect(parsed.images[0].addedOverlays).toBe(false);
  });
});
