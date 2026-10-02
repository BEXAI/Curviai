import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { prepareErrorEnvelope } from "./tunnel";
// Exercise the actual serializer used by the installed browser SDK. The
// package is a dependency of @sentry/nextjs, not a new runtime dependency.
const requireSdk = createRequire(createRequire(import.meta.url).resolve("@sentry/nextjs"));
const sdk = requireSdk("@sentry/core") as {
  makeDsn(value: string): unknown;
  createEventEnvelope(event: Record<string, unknown>, dsn: unknown, metadata: unknown, tunnel: string): unknown;
  serializeEnvelope(envelope: unknown): string;
};
describe("browser SDK error envelope compatibility", () => {
  it("accepts a real SDK error envelope without leaking URL queries or account fields", () => {
    const dsn = "https://abc123@o123.ingest.us.sentry.io/456";
    const event = { event_id: "a".repeat(32), message: "User private@example.com at https://curvi.ai/auth/confirm?token_hash=secret", exception: { values: [{ type: "Error", value: "Test failure", stacktrace: { frames: [{ filename: "https://curvi.ai/app/chunk.js", lineno: 12 }] } }] }, user: { email: "private@example.com" } };
    const raw = sdk.serializeEnvelope(sdk.createEventEnvelope(event, sdk.makeDsn(dsn), { sdk: { name: "sentry.javascript.nextjs", version: "11.2.0" } }, "/monitoring"));
    const output = prepareErrorEnvelope(raw, dsn);
    expect(output).not.toBeNull(); expect(output?.body).toContain("Test failure"); expect(output?.body).toContain("chunk.js");
    expect(output?.body).not.toContain("token_hash"); expect(output?.body).not.toContain("private@example.com");
  });
});
