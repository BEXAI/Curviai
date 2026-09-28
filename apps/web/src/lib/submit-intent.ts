/**
 * One Idempotency-Key per submission intent (Update.md 6.1). A retry of the
 * same form contents, for example after a lost response, must send the same
 * key so the server replays the first job instead of creating a second job
 * and a second credit hold. Any change to what would be submitted is a new
 * intent and gets a new key.
 */

export interface SubmitIntentFields {
  productId: string;
  channels: string[];
  mode: string;
  uploadKey: string | null;
  newProductTitle: string;
  description: string;
  /** Anything else the submit sends (photo roles, SKU, box contents,
   * comparison facts), already serialized by the form. */
  details?: string;
}

/** Stable fingerprint of what a submit would send; channel order does not
 * matter. */
export function intentFingerprint(fields: SubmitIntentFields): string {
  return JSON.stringify([
    fields.productId,
    [...fields.channels].sort(),
    fields.mode,
    fields.uploadKey ?? "",
    fields.productId === "new" ? fields.newProductTitle.trim() : "",
    fields.description.trim(),
    fields.details ?? "",
  ]);
}

export interface SubmitIntent {
  fingerprint: string;
  key: string;
}

/**
 * Returns the intent to submit with: the current one when the fingerprint is
 * unchanged, otherwise a fresh one with a new key. Callers keep the result
 * in a ref and clear it after a successful submit.
 */
export function intentFor(
  current: SubmitIntent | null,
  fields: SubmitIntentFields,
  newKey: () => string,
): SubmitIntent {
  const fingerprint = intentFingerprint(fields);
  if (current && current.fingerprint === fingerprint) {
    return current;
  }
  return { fingerprint, key: newKey() };
}
