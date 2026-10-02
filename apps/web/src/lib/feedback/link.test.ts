import { describe, expect, it } from "vitest";
import { packFeedback } from "@curvi/pipeline/seed";
import { feedbackLinkPath, feedbackLinksEnabled, feedbackLinkToken, verifyFeedbackToken } from "./link";

// Signed feedback links (P18-05): issued only with a long enough secret,
// bound to one pack and person, refused once expired or changed in any way.

const SECRET = "k".repeat(48);
const JOB = "11111111-2222-4333-8444-555555555555";
const USER = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const NOW = new Date("2026-10-02T09:00:00Z");
const DAY_MS = 24 * 60 * 60 * 1000;

describe("feedback links", () => {
  it("are off without a secret or with a short one", () => {
    expect(feedbackLinksEnabled("")).toBe(false);
    expect(feedbackLinksEnabled("short")).toBe(false);
    expect(feedbackLinkToken({ jobId: JOB, userId: USER }, { now: NOW, secret: "short" })).toBeNull();
    expect(feedbackLinkPath({ jobId: JOB, userId: USER }, { now: NOW, secret: "short" })).toBeNull();
    expect(feedbackLinksEnabled(SECRET)).toBe(true);
  });

  it("round trip to the pack and person they name", () => {
    const token = feedbackLinkToken({ jobId: JOB, userId: USER }, { now: NOW, secret: SECRET });
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(verifyFeedbackToken(token, { now: NOW, secret: SECRET })).toEqual({ jobId: JOB, userId: USER });
    expect(feedbackLinkPath({ jobId: JOB, userId: USER }, { now: NOW, secret: SECRET })).toBe(`/feedback/${token}`);
  });

  it("expire after the seeded number of days", () => {
    const token = feedbackLinkToken({ jobId: JOB, userId: USER }, { now: NOW, secret: SECRET });
    const almost = new Date(NOW.getTime() + packFeedback.linkDays * DAY_MS - 1000);
    const after = new Date(NOW.getTime() + packFeedback.linkDays * DAY_MS + 1000);
    expect(verifyFeedbackToken(token, { now: almost, secret: SECRET })).not.toBeNull();
    expect(verifyFeedbackToken(token, { now: after, secret: SECRET })).toBeNull();
  });

  it("refuse another secret, an edited payload, a swapped signature and junk", () => {
    const token = feedbackLinkToken({ jobId: JOB, userId: USER }, { now: NOW, secret: SECRET })!;
    expect(verifyFeedbackToken(token, { now: NOW, secret: "j".repeat(48) })).toBeNull();
    const [payload, mac] = token.split(".");
    const otherUser = Buffer.from(
      Buffer.from(payload, "base64url").toString("utf8").replace(USER, "ffffffff-bbbb-4ccc-8ddd-eeeeeeeeeeee"),
    ).toString("base64url");
    expect(verifyFeedbackToken(`${otherUser}.${mac}`, { now: NOW, secret: SECRET })).toBeNull();
    const other = feedbackLinkToken({ jobId: JOB, userId: "ffffffff-bbbb-4ccc-8ddd-eeeeeeeeeeee" }, { now: NOW, secret: SECRET })!;
    expect(verifyFeedbackToken(`${payload}.${other.split(".")[1]}`, { now: NOW, secret: SECRET })).toBeNull();
    for (const junk of ["", "abc", "a.b.c", "!!.??", "x".repeat(400), null, undefined]) {
      expect(verifyFeedbackToken(junk, { now: NOW, secret: SECRET })).toBeNull();
    }
  });

  it("are never issued for ids that are not uuids", () => {
    expect(feedbackLinkToken({ jobId: "job", userId: USER }, { now: NOW, secret: SECRET })).toBeNull();
  });
});
