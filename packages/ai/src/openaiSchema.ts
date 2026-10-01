/**
 * JSON Schema for OpenAI strict structured outputs
 * (`text.format: { type: "json_schema", strict: true }`), and the reverse
 * step on the answer. Rules from the structured outputs guide, read
 * 2026-09-30 (docs/verification.md):
 *
 * - The root is an object, never anyOf.
 * - Every property is listed in `required`; an optional field is a union
 *   with null, `type: [T, "null"]`.
 * - `additionalProperties: false` on every object.
 * - Supported keywords: pattern, format (a fixed list), minimum, maximum,
 *   the exclusive bounds, multipleOf, minItems, maxItems, enum, anyOf,
 *   $defs and $ref. Not supported: allOf, not, if/then/else, dependent*,
 *   minLength, maxLength.
 * - Limits: 5,000 properties, 10 levels of nesting, 1,000 enum values.
 *
 * Keywords strict mode does not take are dropped, never rejected: the
 * caller's Zod schema still enforces them with safeParse after the call.
 * The conversion works on plain JSON Schema so the OpenAI adapter can apply
 * it to whatever schema a request carries; @curvi/pipeline wraps it for Zod
 * schemas (openaiStrictSchema in schemas.ts).
 */

/** Keywords kept on a schema node. Everything else is dropped. */
const KEPT_KEYWORDS = new Set([
  "type",
  "description",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "enum",
  "const",
  "anyOf",
  "oneOf",
  "$defs",
  "definitions",
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

/** String formats strict mode accepts; any other format is dropped. */
const OPENAI_STRING_FORMATS = new Set([
  "date-time",
  "time",
  "date",
  "duration",
  "email",
  "hostname",
  "ipv4",
  "ipv6",
  "uuid",
]);

/** Size limits of one strict schema. */
export const OPENAI_STRICT_SCHEMA_LIMITS = {
  maxProperties: 5_000,
  maxNestingDepth: 10,
  maxEnumValues: 1_000,
} as const;

/** The property a non object root is wrapped in, since the root must be an
 * object. The adapter unwraps it from the answer. */
export const OPENAI_WRAPPED_ROOT_KEY = "value";

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isObjectSchema(node: JsonObject): boolean {
  return node.type === "object" || isObject(node.properties);
}

/** True when the root is not a plain object schema, so the strict schema
 * wraps it under OPENAI_WRAPPED_ROOT_KEY. */
export function openaiRootNeedsWrap(schema: unknown): boolean {
  if (!isObject(schema)) return true;
  return !(isObjectSchema(schema) && schema.anyOf === undefined && schema.oneOf === undefined && schema.$ref === undefined);
}

/** The same schema accepting null too: a type union for a scalar, an anyOf
 * branch for an object, array, reference or union. */
function nullable(node: JsonObject): JsonObject {
  const branches = node.anyOf;
  if (Array.isArray(branches)) {
    const hasNull = branches.some((b) => isObject(b) && b.type === "null");
    return hasNull ? node : { ...node, anyOf: [...branches, { type: "null" }] };
  }
  const type = node.type;
  const scalar = (t: unknown) => t === "string" || t === "number" || t === "integer" || t === "boolean";
  if (typeof type === "string" && scalar(type)) {
    const out: JsonObject = { ...node, type: [type, "null"] };
    if (Array.isArray(node.enum) && !node.enum.includes(null)) out.enum = [...node.enum, null];
    return out;
  }
  if (Array.isArray(type) && type.every(scalar)) {
    const out: JsonObject = { ...node, type: [...type, "null"] };
    if (Array.isArray(node.enum) && !node.enum.includes(null)) out.enum = [...node.enum, null];
    return out;
  }
  if (Array.isArray(type) && type.includes("null")) {
    return node;
  }
  if (type === "null") {
    return node;
  }
  if (type === undefined && Array.isArray(node.enum) && node.$ref === undefined) {
    return node.enum.includes(null) ? node : { ...node, enum: [...node.enum, null] };
  }
  // An object, array or reference: a union branch keeps its keywords whole.
  const { description, ...rest } = node;
  return {
    ...(description !== undefined ? { description } : {}),
    anyOf: [rest, { type: "null" }],
  };
}

function convertNode(node: unknown, optional: boolean): unknown {
  if (!isObject(node)) {
    return node;
  }
  const out: JsonObject = {};
  const required = new Set(Array.isArray(node.required) ? (node.required as unknown[]) : []);
  for (const [key, value] of Object.entries(node)) {
    if (!KEPT_KEYWORDS.has(key)) continue;
    switch (key) {
      case "properties":
        if (isObject(value)) {
          // Property names are data: a field called "pattern" is kept.
          out.properties = Object.fromEntries(
            Object.entries(value).map(([name, sub]) => [name, convertNode(sub, !required.has(name))]),
          );
        }
        break;
      case "$defs":
      case "definitions":
        if (isObject(value)) {
          out[key] = Object.fromEntries(Object.entries(value).map(([name, sub]) => [name, convertNode(sub, false)]));
        }
        break;
      case "items":
        // A tuple (an items array) has no strict form; the Zod schema
        // checks it after the call.
        if (isObject(value)) out.items = convertNode(value, false);
        break;
      case "anyOf":
      case "oneOf":
        if (Array.isArray(value)) {
          const merged = [...(Array.isArray(out.anyOf) ? out.anyOf : []), ...value.map((b) => convertNode(b, false))];
          out.anyOf = merged;
        }
        break;
      case "const":
        out.enum = [value];
        break;
      case "format":
        if (typeof value === "string" && OPENAI_STRING_FORMATS.has(value)) out.format = value;
        break;
      case "required":
      case "additionalProperties":
        // Rebuilt below for every object.
        break;
      default:
        out[key] = value;
    }
  }
  if (isObjectSchema(out)) {
    const properties = isObject(out.properties) ? out.properties : {};
    out.type = "object";
    out.properties = properties;
    out.required = Object.keys(properties);
    out.additionalProperties = false;
  }
  return optional ? nullable(out) : out;
}

/**
 * The strict OpenAI form of a JSON Schema (see the file comment). A root
 * that is not a plain object is wrapped as the single required property
 * OPENAI_WRAPPED_ROOT_KEY. Converting an already converted schema returns
 * the same schema.
 */
export function openaiStrictJsonSchema(schema: unknown): Record<string, unknown> {
  if (openaiRootNeedsWrap(schema)) {
    const inner = convertNode(isObject(schema) ? stripDefs(schema) : {}, false);
    const defs = isObject(schema) ? collectDefs(schema) : {};
    return {
      type: "object",
      properties: { [OPENAI_WRAPPED_ROOT_KEY]: inner },
      required: [OPENAI_WRAPPED_ROOT_KEY],
      additionalProperties: false,
      ...defs,
    };
  }
  return convertNode(schema, false) as Record<string, unknown>;
}

/** Definitions stay at the root, where $ref pointers expect them. */
function stripDefs(node: JsonObject): JsonObject {
  return Object.fromEntries(Object.entries(node).filter(([key]) => key !== "$defs" && key !== "definitions"));
}

function collectDefs(node: JsonObject): JsonObject {
  const out: JsonObject = {};
  for (const key of ["$defs", "definitions"]) {
    const value = node[key];
    if (isObject(value)) {
      out[key] = Object.fromEntries(Object.entries(value).map(([name, sub]) => [name, convertNode(sub, false)]));
    }
  }
  return out;
}

export interface OpenaiSchemaSize {
  properties: number;
  /** Deepest chain of nested object schemas, the root counting as 1. */
  nestingDepth: number;
  enumValues: number;
}

/** Counts what the strict schema limits are measured on. */
export function openaiSchemaSize(schema: unknown): OpenaiSchemaSize {
  const size: OpenaiSchemaSize = { properties: 0, nestingDepth: 0, enumValues: 0 };
  const visit = (node: unknown, depth: number): void => {
    if (Array.isArray(node)) {
      node.forEach((n) => visit(n, depth));
      return;
    }
    if (!isObject(node)) return;
    const objectLevel = isObjectSchema(node) ? depth + 1 : depth;
    size.nestingDepth = Math.max(size.nestingDepth, objectLevel);
    for (const [key, value] of Object.entries(node)) {
      if (key === "properties" && isObject(value)) {
        size.properties += Object.keys(value).length;
        Object.values(value).forEach((sub) => visit(sub, objectLevel));
      } else if ((key === "$defs" || key === "definitions") && isObject(value)) {
        Object.values(value).forEach((sub) => visit(sub, 0));
      } else if (key === "enum" && Array.isArray(value)) {
        size.enumValues += value.length;
      } else if (key === "items" || key === "anyOf") {
        visit(value, objectLevel);
      }
    }
  };
  visit(schema, 0);
  return size;
}

/** The limits a strict schema breaks, as readable lines; empty when none. */
export function openaiSchemaLimitProblems(schema: unknown): string[] {
  const size = openaiSchemaSize(schema);
  const limits = OPENAI_STRICT_SCHEMA_LIMITS;
  const problems: string[] = [];
  if (size.properties > limits.maxProperties) {
    problems.push(`${size.properties} properties, the limit is ${limits.maxProperties}`);
  }
  if (size.nestingDepth > limits.maxNestingDepth) {
    problems.push(`${size.nestingDepth} levels of nesting, the limit is ${limits.maxNestingDepth}`);
  }
  if (size.enumValues > limits.maxEnumValues) {
    problems.push(`${size.enumValues} enum values, the limit is ${limits.maxEnumValues}`);
  }
  return problems;
}

/** Follows a local $ref (#/$defs/Name or #/definitions/Name). */
function resolveRef(node: JsonObject, root: JsonObject): JsonObject {
  let current = node;
  for (let hops = 0; hops < 32 && typeof current.$ref === "string"; hops++) {
    const match = /^#\/(\$defs|definitions)\/(.+)$/.exec(current.$ref);
    const defs = match ? root[match[1]] : undefined;
    const target = match && isObject(defs) ? defs[decodeURIComponent(match[2])] : undefined;
    if (!isObject(target)) return current;
    current = target;
  }
  return current;
}

function nodeAcceptsKind(node: JsonObject, kind: "object" | "array"): boolean {
  if (kind === "object") return isObjectSchema(node);
  return node.type === "array" || node.items !== undefined;
}

/**
 * The answer with every null on a field the ORIGINAL schema (before
 * openaiStrictJsonSchema) left optional removed, so the caller's Zod schema
 * sees the field as absent, as it would from a provider that omits it. A
 * null on a field the original schema requires (a nullable field) is kept.
 * Walks objects and arrays alongside the schema; anything the schema does
 * not describe is returned unchanged.
 */
export function openaiNullsToUndefined(value: unknown, schema: unknown): unknown {
  const root = isObject(schema) ? schema : {};
  const walk = (val: unknown, node: unknown): unknown => {
    if (!isObject(node) || val === null || typeof val !== "object") return val;
    let current = resolveRef(node, root);
    const kind = Array.isArray(val) ? "array" : "object";
    const branches = [current.anyOf, current.oneOf].find(Array.isArray);
    if (!nodeAcceptsKind(current, kind) && branches) {
      const branch = branches
        .filter(isObject)
        .map((b) => resolveRef(b, root))
        .find((b) => nodeAcceptsKind(b, kind));
      if (!branch) return val;
      current = branch;
    }
    if (Array.isArray(val)) {
      return isObject(current.items) ? val.map((item) => walk(item, current.items)) : val;
    }
    const properties = isObject(current.properties) ? current.properties : {};
    const required = new Set(Array.isArray(current.required) ? (current.required as unknown[]) : []);
    const out: JsonObject = {};
    for (const [key, item] of Object.entries(val as JsonObject)) {
      if (item === null && key in properties && !required.has(key)) continue;
      out[key] = key in properties ? walk(item, properties[key]) : item;
    }
    return out;
  };
  return walk(value, root);
}
