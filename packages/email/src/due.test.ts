import { describe, expect, it } from "vitest";
import { lifecycleSchedule } from "@curvi/pipeline/seed";
import { dueEmails, pausedMsBetween, type AccountFact, type LeadFact, type LifecycleFacts, type PackDoneFact, type SentFact } from "./due";
import { pausesFromEvents } from "./facts";
import { normalizedEmailKey } from "./keys";

// dueEmails, row by row (docs/phases/PHASE_18.md P18-07): every template's
// trigger, timing and stop rule, the holds while waitlisted, suppression,
// paid plans skipping nudges, and no duplicates across cron runs.

const H = 60 * 60 * 1000;
const T0 = new Date("2026-10-05T12:00:00.000Z");
const at = (hours: number) => new Date(T0.getTime() + hours * H);

const PRICING = {
  freeCredits: 15,
  typicalPackCredits: 8,
  starter: { monthlyUsd: 29, credits: 200 },
  topUp: { usd: 15, credits: 100 },
  creditTerms: "Credits you do not use stay in your balance from one month to the next, for as long as your account is open.",
};

function account(overrides: Partial<AccountFact> = {}): AccountFact {
  return {
    workspaceId: "ws-1",
    email: "seller@example.com",
    plan: "free",
    confirmedAt: T0,
    firstPackStartedAt: null,
    lastPackStartedAt: null,
    firstPackDoneAt: null,
    firstPackJobId: null,
    lastPackDoneAt: null,
    lastPackJobId: null,
    lastPaymentAt: null,
    feedbackAt: null,
    balance: 15,
    signupGrant: 15,
    ...overrides,
  };
}

function lead(overrides: Partial<LeadFact> = {}): LeadFact {
  return {
    email: "lead@example.com",
    source: "main-image-checker",
    createdAt: T0,
    lastSource: null,
    lastSeenAt: T0,
    consentAt: null,
    signedUp: false,
    ...overrides,
  };
}

function pack(overrides: Partial<PackDoneFact> = {}): PackDoneFact {
  return {
    jobId: "job-1",
    workspaceId: "ws-1",
    email: "seller@example.com",
    doneAt: T0,
    productTitle: "Amber Candle",
    passed: 6,
    needsReview: 0,
    fidelity: null,
    ...overrides,
  };
}

function sent(dedupeKey: string, hours: number, overrides: Partial<SentFact> = {}): SentFact {
  return {
    dedupeKey,
    template: dedupeKey.split(":")[0],
    status: "sent",
    attempts: 1,
    workspaceId: "ws-1",
    recipientKey: normalizedEmailKey("seller@example.com") as string,
    at: at(hours),
    ...overrides,
  };
}

function facts(overrides: Partial<LifecycleFacts>): LifecycleFacts {
  return {
    now: T0,
    acquisitionOpen: true,
    pricing: PRICING,
    accounts: [],
    packsDone: [],
    leads: [],
    pauses: [],
    sent: [],
    suppressions: new Map(),
    ...overrides,
  };
}

const keys = (f: LifecycleFacts) => dueEmails(f).map((e) => e.dedupeKey);
const templates = (f: LifecycleFacts) => dueEmails(f).map((e) => e.template.key);

describe("a withheld free grant (migration 0012)", () => {
  it("leaves the credits out of the welcome and sends no free pack nudges", () => {
    const withheld = account({ signupGrant: 0, balance: 0 });
    const [welcome] = dueEmails(facts({ accounts: [withheld], now: at(0.2) }));
    expect(welcome.data).toMatchObject({ freeCredits: 0 });
    const welcomed = [sent("welcome:ws-1", 0.1)];
    expect(keys(facts({ accounts: [withheld], now: at(24.1), sent: welcomed }))).toEqual([]);
    expect(keys(facts({ accounts: [account({ signupGrant: null })], now: at(24.1), sent: welcomed }))).toEqual([]);
    // The grant this account got is what the welcome quotes.
    expect(dueEmails(facts({ accounts: [account()], now: at(0.2) }))[0].data).toMatchObject({ freeCredits: 15 });
  });
});

describe("welcome", () => {
  it("is due at confirmation, once, and not after its lateness limit", () => {
    expect(keys(facts({ accounts: [account()], now: at(0.2) }))).toEqual(["welcome:ws-1"]);
    expect(keys(facts({ accounts: [account()], now: at(1), sent: [sent("welcome:ws-1", 0.2)] }))).toEqual([]);
    expect(templates(facts({ accounts: [account()], now: at(49) }))).not.toContain("welcome");
  });

  it("is not held while waitlisted, and says packs are paused", () => {
    const [email] = dueEmails(facts({ accounts: [account()], now: at(0.2), acquisitionOpen: false }));
    expect(email.template.key).toBe("welcome");
    expect(email.data).toMatchObject({ packsPaused: true });
  });

  it("needs a confirmation", () => {
    expect(keys(facts({ accounts: [account({ confirmedAt: null })], now: at(0.2) }))).toEqual([]);
  });
});

describe("first pack nudges", () => {
  const welcomed = [sent("welcome:ws-1", 0.1)];

  it("nudge 1 is due a day after confirmation with no pack started", () => {
    expect(keys(facts({ accounts: [account()], now: at(23), sent: welcomed }))).toEqual([]);
    expect(keys(facts({ accounts: [account()], now: at(24.1), sent: welcomed }))).toEqual(["first_pack_nudge_1:ws-1"]);
  });

  it("stop once a pack starts", () => {
    const started = account({ firstPackStartedAt: at(10), lastPackStartedAt: at(10) });
    expect(templates(facts({ accounts: [started], now: at(24.1), sent: welcomed }))).not.toContain("first_pack_nudge_1");
  });

  it("skip paid plans", () => {
    expect(keys(facts({ accounts: [account({ plan: "starter" })], now: at(24.1), sent: welcomed }))).toEqual([]);
  });

  it("nudge 2 is due three days after confirmation, a day after nudge 1", () => {
    const afterNudge1 = [...welcomed, sent("first_pack_nudge_1:ws-1", 24.1)];
    expect(keys(facts({ accounts: [account()], now: at(72.1), sent: afterNudge1 }))).toEqual(["first_pack_nudge_2:ws-1"]);
    // Never without nudge 1, and never twice.
    expect(keys(facts({ accounts: [account()], now: at(72.1), sent: welcomed }))).not.toContain("first_pack_nudge_2:ws-1");
    expect(
      keys(facts({ accounts: [account()], now: at(80), sent: [...afterNudge1, sent("first_pack_nudge_2:ws-1", 72.1)] })),
    ).toEqual([]);
  });

  it("are held while waitlisted and sent after the pause, the paused hours not counted against the limit", () => {
    const pauses = [{ id: "p1", pausedAt: at(20), resumedAt: at(100) }];
    expect(keys(facts({ accounts: [account()], now: at(30), sent: welcomed, acquisitionOpen: false, pauses: [{ ...pauses[0], resumedAt: null }] }))).toEqual(
      [],
    );
    // 101 hours after confirmation, but only 1 hour late once the 76 paused hours after the due time are left out.
    expect(keys(facts({ accounts: [account()], now: at(101), sent: welcomed, pauses }))).toContain("first_pack_nudge_1:ws-1");
    // Without the pause the same moment is past the 48 hour limit.
    expect(keys(facts({ accounts: [account()], now: at(101), sent: welcomed }))).not.toContain("first_pack_nudge_1:ws-1");
  });
});

describe("pack ready", () => {
  it("is due when a pack is done, once per job, with its numbers", () => {
    const [email] = dueEmails(facts({ packsDone: [pack({ fidelity: { highestMean: 0.8, allWithinLimits: true } })], now: at(0.1) }));
    expect(email.dedupeKey).toBe("pack_ready:job-1");
    expect(email.data).toMatchObject({ jobId: "job-1", passed: 6, fidelity: { highestMean: 0.8 } });
    expect(keys(facts({ packsDone: [pack()], now: at(0.3), sent: [sent("pack_ready:job-1", 0.1)] }))).toEqual([]);
  });

  it("skips a pack with no passed file and one older than its limit", () => {
    expect(keys(facts({ packsDone: [pack({ passed: 0, needsReview: 4 })], now: at(0.1) }))).toEqual([]);
    expect(keys(facts({ packsDone: [pack()], now: at(25) }))).toEqual([]);
  });

  it("is not held while waitlisted", () => {
    expect(keys(facts({ packsDone: [pack()], now: at(0.1), acquisitionOpen: false }))).toEqual(["pack_ready:job-1"]);
  });
});

describe("feedback ask", () => {
  const done = account({ confirmedAt: at(-100), firstPackStartedAt: at(-1), lastPackStartedAt: at(-1), firstPackDoneAt: T0, firstPackJobId: "job-1", feedbackPath: "/feedback/signed-token" });
  const enabled = { ...lifecycleSchedule, templates: { ...lifecycleSchedule.templates, feedback_ask: { ...lifecycleSchedule.templates.feedback_ask, enabled: true } } };

  it("waits for a signed path and carries that path without falling back to login", () => {
    expect(templates(facts({ accounts: [{ ...done, feedbackPath: null }], now: at(49) }))).not.toContain("feedback_ask");
    expect(dueEmails(facts({ accounts: [done], now: at(49) })).find((e) => e.template.key === "feedback_ask")?.data).toEqual({ path: "/feedback/signed-token" });
    expect(keys(facts({ accounts: [done], now: at(49), sent: [sent("feedback_ask:ws-1", 48)] }))).not.toContain("feedback_ask:ws-1");
  });

  it("when on, is due two days after the first pack and stops once answered", () => {
    expect(dueEmails(facts({ accounts: [done], now: at(49) }), enabled).map((e) => e.dedupeKey)).toContain("feedback_ask:ws-1");
    expect(dueEmails(facts({ accounts: [{ ...done, feedbackAt: at(30) }], now: at(49) }), enabled).map((e) => e.template.key)).not.toContain(
      "feedback_ask",
    );
  });
});

describe("referral reward receipt", () => {
  const reward = { referralId: "referral-1", workspaceId: "ws-1", email: "seller@example.com", rewardedAt: T0, credits: 37 };

  it("uses the actual granted amount, once per referral, even while acquisition is paused", () => {
    const input = facts({ now: at(1), acquisitionOpen: false, referralsRewarded: [reward] });
    const [email] = dueEmails(input);
    expect(email.dedupeKey).toBe("referral_rewarded:referral-1");
    expect(email.data).toEqual({ credits: 37 });
    expect(email.template.kind).toBe("transactional");
    expect(keys({ ...input, sent: [sent(email.dedupeKey, 0.5)] })).toEqual([]);
    expect(keys({ ...input, referralsRewarded: [{ ...reward, credits: 0 }] })).toEqual([]);
  });

  it("honors all-mail suppression, the disabled template and its lateness window", () => {
    const input = facts({ now: at(1), referralsRewarded: [reward] });
    expect(keys({ ...input, suppressions: new Map([[normalizedEmailKey(reward.email)!, "all"]]) })).toEqual([]);
    expect(keys({ ...input, now: at(73) })).toEqual([]);
    expect(dueEmails(input, { ...lifecycleSchedule, templates: { ...lifecycleSchedule.templates, referral_rewarded: { ...lifecycleSchedule.templates.referral_rewarded, enabled: false } } })).toEqual([]);
  });
});

describe("out of credits", () => {
  const afterPack = account({
    confirmedAt: at(-200),
    firstPackStartedAt: at(-1),
    lastPackStartedAt: at(-1),
    firstPackDoneAt: T0,
    firstPackJobId: "job-1",
    lastPackDoneAt: T0,
    lastPackJobId: "job-1",
    balance: 7,
  });

  it("is due after a pack leaves the balance below the next pack, on free and Starter", () => {
    expect(keys(facts({ accounts: [afterPack], now: at(0.1) }))).toEqual(["out_of_credits:ws-1:job-1"]);
    expect(keys(facts({ accounts: [{ ...afterPack, plan: "starter" }], now: at(0.1) }))).toEqual(["out_of_credits:ws-1:job-1"]);
    expect(keys(facts({ accounts: [{ ...afterPack, plan: "growth" }], now: at(0.1) }))).toEqual([]);
    expect(keys(facts({ accounts: [{ ...afterPack, balance: 8 }], now: at(0.1) }))).toEqual([]);
  });

  it("stops on a purchase after the pack and goes at most once per 30 days", () => {
    expect(keys(facts({ accounts: [{ ...afterPack, lastPaymentAt: at(0.05) }], now: at(0.1) }))).toEqual([]);
    const later = { ...afterPack, lastPackDoneAt: at(240), lastPackJobId: "job-2", lastPackStartedAt: at(239) };
    expect(keys(facts({ accounts: [later], now: at(240.1), sent: [sent("out_of_credits:ws-1:job-1", 0.1)] }))).toEqual([]);
    expect(keys(facts({ accounts: [later], now: at(240.1), sent: [sent("out_of_credits:ws-1:job-1", -600)] }))).toEqual([
      "out_of_credits:ws-1:job-2",
    ]);
  });

  it("is held while waitlisted", () => {
    expect(keys(facts({ accounts: [afterPack], now: at(0.1), acquisitionOpen: false }))).toEqual([]);
  });
});

describe("win back", () => {
  const lastPack = account({ confirmedAt: at(-1000), firstPackStartedAt: at(-600), lastPackStartedAt: T0, balance: 20 });

  it("is due 21 days after the last pack, never more than once", () => {
    expect(keys(facts({ accounts: [lastPack], now: at(21 * 24 - 1) }))).toEqual([]);
    expect(keys(facts({ accounts: [lastPack], now: at(21 * 24 + 1) }))).toEqual(["win_back:ws-1"]);
    expect(keys(facts({ accounts: [lastPack], now: at(21 * 24 + 2), sent: [sent("win_back:ws-1", -5000)] }))).toEqual([]);
  });

  it("stops with a new pack: the clock follows the last pack", () => {
    expect(keys(facts({ accounts: [{ ...lastPack, lastPackStartedAt: at(20 * 24) }], now: at(21 * 24 + 1) }))).toEqual([]);
  });

  it("is dropped once well past due, so switching email on never mails old accounts", () => {
    expect(keys(facts({ accounts: [lastPack], now: at(29 * 24) }))).toEqual([]);
  });
});

describe("packs back", () => {
  const pause = { id: "41", pausedAt: at(-10), resumedAt: T0 };

  it("goes once per pause to waitlist leads and to signups of the pause with no pack", () => {
    const waiting = lead({ email: "wait@example.com", source: "packs-paused", createdAt: at(-5), lastSeenAt: at(-5) });
    const signup = account({ confirmedAt: at(-3) });
    const due = dueEmails(facts({ leads: [waiting], accounts: [signup], pauses: [pause], now: at(0.1), sent: [sent("welcome:ws-1", -3)] }));
    expect(due.map((e) => e.dedupeKey).sort()).toEqual([
      `packs_back:41:${normalizedEmailKey("seller@example.com")}`,
      `packs_back:41:${normalizedEmailKey("wait@example.com")}`,
    ]);
    // Once per pause: a later run sends neither again.
    const after = due.map((e) => sent(e.dedupeKey, 0.1, { recipientKey: e.recipientKey }));
    expect(templates(facts({ leads: [waiting], accounts: [signup], pauses: [pause], now: at(0.3), sent: after }))).not.toContain("packs_back");
  });

  it("skips signups from before the pause, or who made a pack during it, and a pause still open", () => {
    const before = account({ confirmedAt: at(-20) });
    const made = account({ confirmedAt: at(-3), firstPackStartedAt: at(-2), lastPackStartedAt: at(-2) });
    expect(templates(facts({ accounts: [before], pauses: [pause], now: at(0.1), sent: [sent("welcome:ws-1", -20)] }))).not.toContain("packs_back");
    expect(templates(facts({ accounts: [made], pauses: [pause], now: at(0.1), sent: [sent("welcome:ws-1", -3)] }))).not.toContain("packs_back");
    const waiting = lead({ source: "packs-paused", createdAt: at(-5), lastSeenAt: at(-5) });
    expect(templates(facts({ leads: [waiting], pauses: [{ ...pause, resumedAt: null }], acquisitionOpen: false, now: at(0.1) }))).not.toContain(
      "packs_back",
    );
  });

  it("goes again for a later pause", () => {
    const waiting = lead({ source: "packs-paused", createdAt: at(-5), lastSource: "packs-paused", lastSeenAt: at(50) });
    const pauses = [pause, { id: "77", pausedAt: at(48), resumedAt: at(60) }];
    const firstKey = `packs_back:41:${normalizedEmailKey("lead@example.com")}`;
    expect(keys(facts({ leads: [waiting], pauses, now: at(60.1), sent: [sent(firstKey, 0.1, { recipientKey: "x".repeat(64) })] }))).toEqual([
      `packs_back:77:${normalizedEmailKey("lead@example.com")}`,
    ]);
  });
});

describe("lead emails", () => {
  it("lead_results is marketing: never to a lead without consent, so never to one from before the box", () => {
    expect(keys(facts({ leads: [lead()], now: at(0.1) }))).toEqual([]);
    expect(keys(facts({ leads: [lead({ createdAt: new Date("2026-09-28T10:00:00Z"), lastSource: "white-background-fixer", lastSeenAt: at(0) })], now: at(0.1) }))).toEqual(
      [],
    );
  });

  it("lead_results and packs_back never reach a lead who unsubscribed from marketing", () => {
    const leadKey = normalizedEmailKey("lead@example.com") as string;
    const off = new Map([[leadKey, "marketing" as const]]);
    expect(keys(facts({ leads: [lead({ consentAt: T0 })], now: at(0.1), suppressions: off }))).toEqual([]);
    const waiting = lead({ source: "packs-paused", createdAt: at(-5), lastSeenAt: at(-5) });
    const pause = { id: "41", pausedAt: at(-10), resumedAt: T0 };
    expect(keys(facts({ leads: [waiting], pauses: [pause], now: at(0.1), suppressions: off }))).toEqual([]);
    expect(keys(facts({ leads: [waiting], pauses: [pause], now: at(0.1) }))).toEqual([`packs_back:41:${leadKey}`]);
  });

  it("lead_results goes once per lead and tool to a lead who ticked the box", () => {
    const visitor = lead({ consentAt: T0, lastSource: "white-background-fixer", lastSeenAt: at(1) });
    expect(dueEmails(facts({ leads: [visitor], now: at(0.1) })).map((e) => e.dedupeKey)).toEqual([
      `lead_results:${normalizedEmailKey("lead@example.com")}:main-image-checker`,
    ]);
    const leadKey = normalizedEmailKey("lead@example.com") as string;
    const done = [sent(`lead_results:${leadKey}:main-image-checker`, 0.1, { recipientKey: leadKey, workspaceId: null })];
    // Marketing spacing: the second tool's email waits 20 hours after the first.
    expect(keys(facts({ leads: [visitor], now: at(1.2), sent: done }))).toEqual([]);
    expect(keys(facts({ leads: [visitor], now: at(20.5), sent: done }))).toEqual([`lead_results:${leadKey}:white-background-fixer`]);
  });

  it("lead_results skips sources that are not a tool", () => {
    expect(keys(facts({ leads: [lead({ source: "gallery", consentAt: T0 })], now: at(0.1) }))).toEqual([]);
    expect(keys(facts({ leads: [lead({ source: "packs-paused", consentAt: T0 })], now: at(0.1) }))).toEqual([]);
  });

  it("tips and offers go only to leads who ticked the box, never before it shipped, and stop at signup", () => {
    const leadKey = normalizedEmailKey("lead@example.com") as string;
    const resultsSent = [sent(`lead_results:${leadKey}:main-image-checker`, 0.1, { recipientKey: leadKey, workspaceId: null })];
    // Captured before the consent box: no consent, so no marketing ever.
    expect(templates(facts({ leads: [lead()], now: at(73), sent: resultsSent }))).toEqual([]);
    const consented = lead({ consentAt: T0 });
    expect(templates(facts({ leads: [consented], now: at(73), sent: resultsSent }))).toEqual(["lead_tip"]);
    const tipSent = [...resultsSent, sent(`lead_tip:${leadKey}`, 73, { recipientKey: leadKey, workspaceId: null })];
    expect(templates(facts({ leads: [consented], now: at(241), sent: tipSent }))).toEqual(["lead_offer"]);
    expect(templates(facts({ leads: [{ ...consented, signedUp: true }], now: at(241), sent: tipSent }))).toEqual([]);
  });
});

describe("suppression, spacing and one email per run", () => {
  it("never sends a blocked kind to a suppressed address", () => {
    const key = normalizedEmailKey("seller@example.com") as string;
    const welcomed = [sent("welcome:ws-1", 0.1)];
    const marketingOff = new Map([[key, "marketing" as const]]);
    expect(keys(facts({ accounts: [account()], now: at(24.1), sent: welcomed, suppressions: marketingOff }))).toEqual([]);
    expect(keys(facts({ accounts: [account()], packsDone: [pack({ doneAt: at(24) })], now: at(24.1), sent: welcomed, suppressions: marketingOff }))).toEqual([
      "pack_ready:job-1",
    ]);
    const allOff = new Map([[key, "all" as const]]);
    expect(keys(facts({ accounts: [account()], now: at(0.1), suppressions: allOff }))).toEqual([]);
  });

  it("sends one email per person per run, transactional first", () => {
    const due = dueEmails(facts({ accounts: [account()], packsDone: [pack({ doneAt: at(0.05) })], now: at(0.1) }));
    expect(due.map((e) => e.template.key)).toEqual(["welcome"]);
  });

  it("holds marketing within the spacing after any email to the same person", () => {
    // Email switched on late: welcome went 30 hours after confirmation, so nudge 1 waits a while.
    const lateWelcome = [sent("welcome:ws-1", 30)];
    expect(keys(facts({ accounts: [account()], now: at(31), sent: lateWelcome }))).toEqual([]);
    expect(keys(facts({ accounts: [account()], now: at(50.5), sent: lateWelcome }))).toEqual(["first_pack_nudge_1:ws-1"]);
  });

  it("lets a failed key be tried again until its attempts run out", () => {
    const failed = (attempts: number) => [sent("welcome:ws-1", 0.05, { status: "failed", attempts })];
    expect(keys(facts({ accounts: [account()], now: at(0.1), sent: failed(1) }))).toEqual(["welcome:ws-1"]);
    expect(keys(facts({ accounts: [account()], now: at(0.1), sent: failed(3) }))).toEqual([]);
  });
});

describe("pauses", () => {
  it("pairs pause and resume events and measures paused time", () => {
    const since = at(-1000);
    const pauses = pausesFromEvents(
      [
        { id: "2", name: "funnel.acquisition_resumed", at: at(-50) },
        { id: "3", name: "funnel.acquisition_paused", at: at(-10) },
        { id: "4", name: "funnel.acquisition_paused", at: at(-9) },
        { id: "5", name: "funnel.acquisition_resumed", at: at(-2) },
        { id: "6", name: "funnel.acquisition_paused", at: at(-1) },
      ],
      since,
    );
    expect(pauses).toEqual([
      { id: "r2", pausedAt: since, resumedAt: at(-50) },
      { id: "3", pausedAt: at(-10), resumedAt: at(-2) },
      { id: "6", pausedAt: at(-1), resumedAt: null },
    ]);
    expect(pausedMsBetween(pauses, at(-5), T0) / H).toBe(4);
  });
});
