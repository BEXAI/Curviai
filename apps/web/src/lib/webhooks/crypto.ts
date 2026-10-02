import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { webhookPolicy } from "@curvi/pipeline/seed";
import { optionalEnv } from "@/lib/env";
import { openPayload, parseSigningKeys, sealPayload, type SigningKey } from "@/lib/mcp-signing";

export function webhookKeys(): SigningKey[] | null {
  try { return parseSigningKeys(optionalEnv("MCP_LINK_KEYS")); } catch { return null; }
}
export function sealWebhookSecret(keys: readonly SigningKey[], workspaceId: string, endpointId: string, secret: string): string {
  return JSON.stringify(sealPayload(keys, "webhook-secret", JSON.stringify({ workspaceId, endpointId, secret })));
}
export function openWebhookSecret(keys: readonly SigningKey[], workspaceId: string, endpointId: string, encrypted: string): string | null {
  try {
    const seal = JSON.parse(encrypted) as { kid: string; iv: string; sealed: string };
    const raw = openPayload(keys, "webhook-secret", seal.kid, seal.iv, seal.sealed);
    if (!raw) return null;
    const claims = JSON.parse(raw) as { workspaceId: string; endpointId: string; secret: string };
    return claims.workspaceId === workspaceId && claims.endpointId === endpointId && /^[A-Za-z0-9_-]{43}$/.test(claims.secret) ? claims.secret : null;
  } catch { return null; }
}
export function newWebhookKey(): { keyId: string; secret: string } {
  return { keyId: randomUUID(), secret: randomBytes(32).toString("base64url") };
}
function signature(secret: string, timestamp: string, keyId: string, body: string): string {
  return createHmac("sha256", secret).update(`curvi:webhook:v1:${timestamp}:${keyId}:`).update(body, "utf8").digest("hex");
}
export function signWebhook(secret: string, keyId: string, body: string, now: Date): Record<string, string> {
  const timestamp = Math.floor(now.getTime() / 1000).toString();
  return { "curvi-webhook-timestamp": timestamp, "curvi-webhook-key-id": keyId, "curvi-webhook-signature": `v1=${signature(secret, timestamp, keyId, body)}` };
}
/** Receiver fixture/reference: compare exact raw bytes before JSON parsing. */
export function verifyWebhook(secret: string, keyId: string, body: string, headers: Record<string, string>, now: Date): boolean {
  const timestamp = headers["curvi-webhook-timestamp"] ?? "";
  if (!/^\d{1,12}$/.test(timestamp) || headers["curvi-webhook-key-id"] !== keyId) return false;
  if (Math.abs(Math.floor(now.getTime() / 1000) - Number(timestamp)) > webhookPolicy.receiverWindowSeconds) return false;
  const given = headers["curvi-webhook-signature"] ?? "";
  if (!/^v1=[a-f0-9]{64}$/.test(given)) return false;
  const expected = Buffer.from(signature(secret, timestamp, keyId, body), "hex");
  return timingSafeEqual(Buffer.from(given.slice(3), "hex"), expected);
}
export function verificationResponse(secret: string, challenge: string): string {
  return createHmac("sha256", secret).update(`curvi:webhook:verify:v1:${challenge}`).digest("hex");
}
export function acceptsVerification(secret: string, challenge: string, answer: string | undefined): boolean {
  return !!answer && /^[a-f0-9]{64}$/.test(answer) && timingSafeEqual(Buffer.from(answer, "hex"), Buffer.from(verificationResponse(secret, challenge), "hex"));
}
/** Rewrap the same receiver secret under the newest master, with no receiver
 * key rotation. Unknown/removed wrapping keys fail closed. Call under the
 * endpoint lock and persist only after successful authenticated decryption. */
export function rewrapWebhookSecret(keys: readonly SigningKey[], workspaceId: string, endpointId: string, encrypted: string): string | null {
  const secret = openWebhookSecret(keys, workspaceId, endpointId, encrypted);
  if (!secret) return null;
  try {
    return (JSON.parse(encrypted) as { kid?: unknown }).kid === keys[0]?.kid ? encrypted : sealWebhookSecret(keys, workspaceId, endpointId, secret);
  } catch { return null; }
}
