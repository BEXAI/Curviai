import { describe, expect, it } from "vitest";
import { acceptsVerification, newWebhookKey, openWebhookSecret, rewrapWebhookSecret, sealWebhookSecret, signWebhook, verificationResponse, verifyWebhook } from "./crypto";
import { openPayload } from "@/lib/mcp-signing";
import { completionBody } from "./contract";
const old = { kid: "old", secret: "fixture-old-master-key-32-characters" };
const next = { kid: "next", secret: "fixture-new-master-key-32-characters" };
const now = new Date("2026-10-02T12:00:00Z");
describe("private webhook keys and wire contract", () => {
  it("seals receiver secrets to purpose, workspace and endpoint and supports master rotation", () => {
    const { secret } = newWebhookKey();
    const encrypted = sealWebhookSecret([old], "workspace", "endpoint", secret);
    expect(encrypted).not.toContain(secret);
    expect(openWebhookSecret([old], "workspace", "endpoint", encrypted)).toBe(secret);
    expect(openWebhookSecret([old], "other", "endpoint", encrypted)).toBeNull();
    expect(openWebhookSecret([old], "workspace", "other", encrypted)).toBeNull();
    const seal = JSON.parse(encrypted);
    expect(openPayload([old], "link", seal.kid, seal.iv, seal.sealed)).toBeNull();
    expect(openWebhookSecret([next], "workspace", "endpoint", encrypted)).toBeNull();
    const rewrapped = rewrapWebhookSecret([next, old], "workspace", "endpoint", encrypted)!;
    expect(openWebhookSecret([next], "workspace", "endpoint", rewrapped)).toBe(secret);
    expect(rewrapWebhookSecret([next], "workspace", "endpoint", encrypted)).toBeNull();
  });
  it("authenticates exact bytes, timestamp, key ID and the receiver verification challenge", () => {
    const first = newWebhookKey(); const second = newWebhookKey();
    const body = '{"id":"event"}';
    const headers = signWebhook(first.secret, first.keyId, body, now);
    expect(verifyWebhook(first.secret, first.keyId, body, headers, now)).toBe(true);
    expect(verifyWebhook(first.secret, first.keyId, `${body} `, headers, now)).toBe(false);
    expect(verifyWebhook(first.secret, first.keyId, body, headers, new Date(now.getTime() + 301_000))).toBe(false);
    expect(verifyWebhook(first.secret, first.keyId, body, headers, new Date(now.getTime() - 301_000))).toBe(false);
    expect(verifyWebhook(second.secret, second.keyId, body, headers, now)).toBe(false);
    expect(verifyWebhook(first.secret, first.keyId, body, { ...headers, "curvi-webhook-timestamp": "NaN" }, now)).toBe(false);
    const response = verificationResponse(first.secret, "challenge");
    expect(acceptsVerification(first.secret, "challenge", response)).toBe(true);
    expect(acceptsVerification(first.secret, "different", response)).toBe(false);
    expect(acceptsVerification(first.secret, "challenge", `${response}00`)).toBe(false);
  });
  it("separates failed follow-up execution from the existing available pack and emits only the minimal contract", () => {
    const event = { id: "event", workspaceId: "workspace", jobId: "job", logicalRunId: "run", outcome: "failed" as const, packStatus: "done" as const, occurredAt: now };
    const body = completionBody(event);
    expect(completionBody(event)).toBe(body);
    expect(JSON.parse(body)).toEqual({ id: "event", type: "pack.run.terminal", version: 1, workspace_id: "workspace", job_id: "job", run_id: "run", outcome: "failed", pack_status: "done", occurred_at: now.toISOString(), pack_path: "/api/v1/packs/job" });
  });
});
