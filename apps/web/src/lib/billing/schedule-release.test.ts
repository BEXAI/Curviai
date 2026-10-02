import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { rule9Problems } from "@curvi/pipeline";
import { createTestDb, type TestDb } from "@curvi/db/testing";
import { events } from "@curvi/db/schema";
import { eq, type Db } from "@curvi/db";
import {
  cancelFlowReleaseNotice,
  liveScheduleReleaseNotifier,
  releasedThenFailedNotice,
  releaseEmail,
  releaseEventName,
  scheduledChangeText,
  upgradeReleaseNotice,
  type ScheduledChange,
} from "./schedule-release";

// A released schedule is never silent (security review 2, law and copy
// review major 7): the subscriber hears first, the founder gets an email and
// the release is recorded.

const CHANGE: ScheduledChange = {
  scheduleId: "sub_sched_1",
  tier: "starter",
  cadence: "monthly",
  startsAt: new Date("2026-11-03T00:00:00Z"),
};

describe("what the subscriber is told", () => {
  it("names the plan and the date, or falls back when the schedule could not be read", () => {
    expect(scheduledChangeText(CHANGE, "growth")).toBe("your move to Starter on November 3, 2026");
    expect(scheduledChangeText({ ...CHANGE, tier: "growth", cadence: "monthly" }, "growth")).toBe(
      "your move to monthly billing on November 3, 2026",
    );
    expect(scheduledChangeText({ scheduleId: "s", tier: null, cadence: null, startsAt: null })).toBe(
      "your move to a smaller plan at your next renewal",
    );
  });

  it("asks before an upgrade, warns in the cancel flow and owns up after a failure, in plain words", () => {
    const texts = [
      upgradeReleaseNotice(CHANGE, "growth"),
      cancelFlowReleaseNotice(CHANGE, "growth"),
      releasedThenFailedNotice(CHANGE, "growth"),
    ];
    expect(texts[0]).toBe("This cancels your move to Starter on November 3, 2026. Choose Continue to upgrade anyway.");
    for (const text of texts) {
      expect(rule9Problems(text), text).toEqual([]);
    }
  });
});

describe("liveScheduleReleaseNotifier", () => {
  let client: Awaited<ReturnType<typeof createTestDb>>["client"];
  let db: TestDb;

  beforeAll(async () => {
    const created = await createTestDb();
    client = created.client;
    db = created.db;
  });

  afterAll(async () => {
    await client.close();
  });

  it("records the release once and emails the founder each time", async () => {
    const [workspace] = await client
      .query<{ id: string }>("insert into workspaces (name) values ('Released') returning id")
      .then((result) => result.rows);
    const sendEmail = vi.fn(async (_email: { subject: string; text: string }) => ({ ok: true }));
    const notify = liveScheduleReleaseNotifier({ db: db as unknown as Db, sendEmail });
    const event = { workspaceId: workspace!.id, subscriptionId: "sub_1", change: CHANGE, path: "upgrade" as const };
    await notify(event);
    await notify(event);
    const rows = await db.select().from(events).where(eq(events.name, releaseEventName("sub_sched_1")));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ workspaceId: workspace!.id, props: expect.objectContaining({ path: "upgrade", tier: "starter" }) });
    expect(sendEmail).toHaveBeenCalledTimes(2);
    const email = sendEmail.mock.calls[0]![0];
    expect(email.subject).toBe("Curvi billing: a scheduled plan change was canceled");
    expect(email.text).toContain("Schedule: sub_sched_1");
    expect(email.text).toContain("It would have moved to: Starter, billed monthly on November 3, 2026");
  });

  it("never throws, even when the record and the email both fail", async () => {
    const broken = {
      insert: () => {
        throw new Error("database down");
      },
    } as unknown as Db;
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const notify = liveScheduleReleaseNotifier({
      db: broken,
      sendEmail: async () => {
        throw new Error("network down");
      },
    });
    await expect(notify({ workspaceId: "ws", subscriptionId: "sub", change: CHANGE, path: "cancel" })).resolves.toBeUndefined();
    quiet.mockRestore();
    expect(releaseEmail({ workspaceId: "ws", subscriptionId: "sub", change: CHANGE, path: "pause" }).text).toContain(
      "when the subscriber chose to pause billing",
    );
  });
});
