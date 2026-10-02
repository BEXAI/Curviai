import { createHash } from "node:crypto";
import { outputOptionsKey } from "@curvi/pipeline/output-options";
import type { CreateJobInput } from "./types";

/** Stable JSON for request values: object key order is immaterial, while
 * photo and seller-line order affects the generated pack. */
function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`;
}

type RequestFields = Omit<CreateJobInput, "idempotencyKey" | "previousIdempotencyKeys" | "maxCredits">;

/** The immutable request identity, before ingest changes hashes or product
 * details change. API photo bytes have already been verified by readPhoto;
 * their per-attempt storage key is not part of their logical identity.
 * A browser upload keeps its source key, which also binds its preflight.
 * Credit caps authorize a hold and do not change what a pack makes. */
export function jobRequestFingerprint(input: RequestFields): string {
  const seen = new Set<string>();
  // Browser duplicate keys are resolved by createJob's Map (last value,
  // first position); API duplicates were collapsed by photo reader first.
  const source = input.origin === "api" ? (input.uploads ?? []) : [...new Map((input.uploads ?? []).map((upload) => [upload.key, upload])).values()];
  const uploads = source.flatMap((upload) => {
    const identity = input.origin === "api" ? upload.sha256 : upload.key;
    if (seen.has(identity)) return [];
    seen.add(identity);
    return [{
      identity,
      sha256: upload.sha256,
      kind: upload.kind,
      angle: upload.angle ?? null,
      targetBox: upload.targetBox ?? null,
      background: input.mode === "concept" ? "pack" :
        (!upload.background || upload.background === "pack" ? (input.outputOptions?.background ?? "remove") : upload.background),
    }];
  });
  const body = {
    productId: input.productId,
    channels: [...input.channels].sort(),
    mode: input.mode,
    uploads,
    newProductTitle: input.productId === "new" ? (input.newProductTitle?.trim() || "New product") : undefined,
    userDescription: input.userDescription?.trim() || "",
    // Missing seller fields preserve existing product details; empty fields
    // clear them. Keep that distinction in the receipt.
    sku: input.sku?.trim(),
    boxContents: input.boxContents,
    comparisonFacts: input.comparisonFacts,
    endorsements: input.endorsements,
    outputOptions: outputOptionsKey(input.mode === "concept" ? null : (input.outputOptions ?? null)),
    sellerAnswers: input.sellerAnswers,
    answers: input.sellerAnswers ? undefined : input.answers,
    audience: input.audience,
  };
  return createHash("sha256").update(stable(body)).digest("hex");
}
