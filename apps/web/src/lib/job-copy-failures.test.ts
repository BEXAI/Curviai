import { describe, expect, it, vi } from "vitest";
import {
  AllProvidersFailedError,
  BreakerOpenError,
  CapStoreUnavailableError,
  ProviderError,
  ProviderTimeoutError,
} from "@curvi/ai";
import {
  JobAbandonedError,
  moderationBlockedMessage,
  MULTIPLE_PRODUCTS_MESSAGE,
  noSellableProductMessage,
  PLAN_FAILED_MESSAGE,
  restrictedProductMessage,
  SCREENING_UNAVAILABLE_MESSAGE,
} from "@curvi/trigger/runner";
import { IllegalTransitionError } from "@curvi/trigger/state";
import { SETTLED_JOB_MESSAGES } from "@/lib/jobs/enqueue";
import { RECONCILED_JOB_ERROR } from "@/lib/services/reconcile";
import { MCP_COPY } from "@/lib/api-v1/mcp-copy";
import {
  JOB_ERROR_COPY,
  jobErrorKind,
  jobErrorLineFor,
  needsReviewNote,
  noProductCopy,
  publicJobError,
  type JobErrorKind,
} from "./job-copy";

// enqueue.ts schedules inline packs with next/server's after(); only its
// settled messages are read here.
vi.mock("next/server", () => ({ after: vi.fn() }));

/**
 * A6 (docs/phases/PHASE_12.md "A6 failure copy inventory"): every message the
 * runner and the web app can store as a job error, with realistic provider
 * variants, and the seller copy it must map to. A new stored message belongs
 * here with its own case; none may fall to the generic line by accident.
 */

const JOB = "7d9f2a4e-1b3c-4d5e-8f6a-0b1c2d3e4f5a";
const WS = "11111111-2222-4333-8444-555555555555";

const anthropic401 = new ProviderError(
  'anthropic-claude responded 401: {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"},"request_id":"req_011CSk"}',
  "anthropic-claude",
  "llm.intake",
  false,
);
const openai401 = new ProviderError(
  'openai-image responded 401: {"error":{"message":"Incorrect API key provided: sk-proj-****","type":"invalid_request_error","code":"invalid_api_key"}}',
  "openai-image",
  "image.generate",
  false,
);
const gemini403 = new ProviderError(
  'gemini-image responded 403: {"error":{"code":403,"message":"Permission denied on resource project curvi.","status":"PERMISSION_DENIED"}}',
  "gemini-image",
  "image.generate",
  false,
);
const anthropic400 = new ProviderError(
  'anthropic-claude responded 400: {"type":"error","error":{"type":"invalid_request_error","message":"model: claude-x not found"}}',
  "anthropic-claude",
  "llm.analyze",
  false,
);
const bfl402 = new ProviderError(
  'bfl-flux responded 402: {"detail":"Insufficient credits"}',
  "bfl-flux",
  "image.generate",
  false,
);
const anthropic529 = new ProviderError(
  'anthropic-claude responded 529: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
  "anthropic-claude",
  "llm.intake",
  true,
);
const fal502 = new ProviderError("fal-gateway responded 502: <html>Bad Gateway</html>", "fal-gateway", "image.generate", true);
const photoroom429 = new ProviderError(
  'photoroom-cutout responded 429: {"detail":"Too many requests"}',
  "photoroom-cutout",
  "cutout",
  true,
);
const geminiBlocked = new ProviderError(
  "Gemini blocked the prompt (blockReason SAFETY)",
  "gemini-image",
  "image.generate",
  false,
  undefined,
  { code: "content_blocked" },
);
const anthropicRefusal = new ProviderError(
  "Anthropic declined the request (stop_reason refusal)",
  "anthropic-claude",
  "llm.intake",
  false,
  undefined,
  { code: "content_blocked" },
);
const bflModerated = new ProviderError(
  "BFL declined the generation with status Content Moderated",
  "bfl-flux",
  "image.generate",
  false,
  undefined,
  { code: "content_blocked" },
);
const workspaceCap = new ProviderError(
  `Spend cap blocked call: Reserving 40000 micros would put caps:workspace:${WS}:2026-09-28 at 5040000, over the cap of 5000000`,
  "gemini-image",
  "image.generate",
  false,
  undefined,
  { code: "cap_blocked" },
);
const globalCap = new ProviderError(
  "Spend cap blocked call: Reserving 40000 micros would put caps:global:2026-09-28 at 150040000, over the cap of 150000000",
  "anthropic-claude",
  "llm.intake",
  false,
  undefined,
  { code: "cap_blocked" },
);
const packCap = new ProviderError(
  `Spend cap blocked call: Concurrent reservations put caps:pack:${JOB} over the cap of 2000000`,
  "gemini-image",
  "image.generate",
  false,
  undefined,
  { code: "cap_blocked" },
);

const chain = (task: string, ...errors: ProviderError[]) => new AllProvidersFailedError(task, errors).message;

// OpenAI LLM chains (docs/phases/PHASE_17.md): registry names are
// "openai:<model>", and billing answers are HTTP 429 with an error code.
const openaiCredit429 = new ProviderError(
  'openai:gpt-6-luna responded 429: {"error":{"message":"You have run out of credits.","type":"insufficient_quota","code":"credit_balance_exhausted"}}',
  "openai:gpt-6-luna",
  "intake_normalizer",
  false,
  undefined,
  { code: "provider_quota" },
);
const openaiSpend429 = new ProviderError(
  'openai:gpt-6.1-sol responded 429: {"error":{"message":"Project spend limit reached.","type":"insufficient_quota","code":"project_spend_limit_exceeded"}}',
  "openai:gpt-6.1-sol",
  "product_analyzer",
  false,
  undefined,
  { code: "provider_quota" },
);
const openaiRate429 = new ProviderError(
  'openai:gpt-6-luna responded 429: {"error":{"message":"Rate limit reached for gpt-6-luna","type":"requests","code":"rate_limit_exceeded"}}',
  "openai:gpt-6-luna",
  "copy_generator",
  true,
);
const openaiLlm401 = new ProviderError(
  'openai:gpt-6-luna responded 401: {"error":{"message":"Incorrect API key provided","type":"invalid_request_error","code":"invalid_api_key"}}',
  "openai:gpt-6-luna",
  "intake_normalizer",
  false,
);
const openaiRefusal = new ProviderError(
  "OpenAI declined the request (refusal)",
  "openai:gpt-6-luna",
  "intake_normalizer",
  false,
  undefined,
  { code: "content_blocked" },
);
const openaiContentFilter = new ProviderError(
  "OpenAI stopped the reply (incomplete: content_filter)",
  "openai:gpt-6-luna",
  "copy_generator",
  false,
  undefined,
  { code: "content_blocked" },
);

/** [stored message, expected kind]. */
const CASES: Array<[string, JobErrorKind]> = [
  // Screenshots: the ingest refusal and any runner message that names one.
  [
    "That looks like a screenshot, not a photo of your product. Take a photo of the product with your camera and upload that instead.",
    "screenshot",
  ],
  ["Intake found a screenshot of a phone screen instead of a product photo", "screenshot"],
  ["This upload looks like a screen capture, so the pack stopped", "screenshot"],

  // Intake and analysis gates (trigger/src/pipeline-runner.ts).
  ["Intake found no sellable product in the uploaded images", "noProduct"],
  [MULTIPLE_PRODUCTS_MESSAGE, "multipleProducts"],
  // Moderation (PHASE_14 workstream 2): each category by name, no review queue.
  [moderationBlockedMessage(["nudity"]), "blockedAdult"],
  [moderationBlockedMessage(["adult content"]), "blockedAdult"],
  [moderationBlockedMessage(["weapons"]), "blockedWeapons"],
  [moderationBlockedMessage(["drugs"]), "blockedDrugs"],
  [moderationBlockedMessage(["prohibited goods"]), "blockedProhibited"],
  [moderationBlockedMessage(["a real person as the main subject"]), "blockedPerson"],
  // PHASE_19 P19-29: the category keys are seed keys, never shown; one
  // names "drugs", which must not read as the moderation drugs line.
  [restrictedProductMessage(["tobacco_nicotine"]), "blockedRestricted"],
  [SCREENING_UNAVAILABLE_MESSAGE, "screeningUnavailable"],
  [restrictedProductMessage(["prescription_drugs", "self_defense_weapons"]), "blockedRestricted"],
  // Older jobs stored the "manual review" wording; they read the same lines.
  ["This upload was flagged for weapons, adult content and needs a manual review before a pack can run", "blockedAdult"],
  ["This product was flagged for regulated goods and needs a manual review before a pack can run", "flagged"],
  ["This product was flagged for a possible counterfeit and needs a manual review before a pack can run", "flagged"],
  ["Intake response failed schema validation", "readFailed"],
  ["Product analysis response failed schema validation", "readFailed"],
  [PLAN_FAILED_MESSAGE, "planFailed"],
  ["No shots could be planned for the channels you picked, so nothing was charged.", "noShotsPlanned"],
  [
    "None of the shots in this pack passed its checks, so nothing was charged. Each shot is marked for review.",
    "noShotPassed",
  ],
  ["None of the shots in this pack could be delivered, so nothing was charged.", "notDelivered"],
  ["Pack storage is not configured, so the pack could not be delivered.", "notDelivered"],
  ["Pack storage is not configured, so the files could not be delivered.", "notDelivered"],
  // noShotPassedMessage when every shot threw: the first raw error rides along.
  [
    `None of the shots in this pack could be made, so nothing was charged. The first error was: ${chain("image.generate", openai401, gemini403)}`,
    "setup",
  ],
  [
    `None of the shots in this pack could be made, so nothing was charged. The first error was: ${chain("image.generate", fal502)}`,
    "serviceBusy",
  ],
  [
    "None of the shots in this pack could be made, so nothing was charged. The first error was: Cannot read properties of undefined (reading 'width')",
    "noShotsMade",
  ],
  // Cutout refusals, should one ever reach the job line.
  ["We could not separate the product from its background in this photo, so this shot needs review.", "cutout"],
  ["The cutout found no product in this photo, so this shot needs review.", "noProduct"],

  // Provider chains (packages/ai AllProvidersFailedError and adapters).
  [chain("llm.intake", anthropic401), "setup"],
  [chain("llm.intake", anthropic401, anthropic529), "setup"],
  [chain("llm.analyze", anthropic400), "setup"],
  [chain("image.generate", bfl402), "setup"],
  [chain("image.generate", gemini403), "setup"],
  [chain("llm.intake", anthropic529), "serviceBusy"],
  [chain("cutout", photoroom429), "serviceBusy"],
  [chain("image.generate", fal502), "serviceBusy"],
  [chain("llm.intake", new ProviderTimeoutError("anthropic-claude", "llm.intake", 60000)), "serviceBusy"],
  [chain("image.generate", new ProviderTimeoutError("bfl-flux", "image.generate", 120000, 40000)), "serviceBusy"],
  [chain("llm.intake", new BreakerOpenError("anthropic-claude", "llm.intake")), "serviceBusy"],
  [
    chain(
      "llm.intake",
      new ProviderError("Network error calling anthropic-claude: fetch failed", "anthropic-claude", "llm.intake", true),
    ),
    "serviceBusy",
  ],
  [
    chain(
      "llm.intake",
      new ProviderError(
        "Anthropic response had no text or tool_use block (stop_reason max_tokens)",
        "anthropic-claude",
        "llm.intake",
        false,
      ),
    ),
    "serviceBusy",
  ],
  [chain("image.generate", new ProviderError("fal request ended with status FAILED", "fal-gateway", "image.generate", false)), "serviceBusy"],
  [chain("llm.intake", anthropicRefusal), "contentBlocked"],
  [chain("image.generate", geminiBlocked, bflModerated), "contentBlocked"],
  [
    chain("llm.intake", new ProviderError('Provider "anthropic-claude" is not registered', "anthropic-claude", "llm.intake", false)),
    "setup",
  ],
  [
    chain(
      "llm.intake",
      new ProviderError(
        'Provider "anthropic-claude" does not support task "llm.intake"',
        "anthropic-claude",
        "llm.intake",
        false,
      ),
    ),
    "setup",
  ],
  [
    chain(
      "llm.intake",
      new ProviderError(
        'Model "claude-x" has no price table on this adapter; add it to priceTables',
        "anthropic-claude",
        "llm.intake",
        false,
      ),
    ),
    "setup",
  ],
  [
    chain(
      "llm.intake",
      new ProviderError(
        'Cost estimate failed for "anthropic-claude": Adapter anthropic-claude needs an API key: pass apiKey or set ANTHROPIC_API_KEY',
        "anthropic-claude",
        "llm.intake",
        false,
      ),
    ),
    "setup",
  ],
  ['No providers routed for task "llm.intake"', "setup"],
  // OpenAI chains with Claude last: billing codes are our account, rate
  // limits are busy, a refusal is a content block.
  [chain("intake_normalizer", openaiCredit429), "setup"],
  [chain("product_analyzer", openaiSpend429), "setup"],
  [chain("intake_normalizer", openaiCredit429, anthropic529), "setup"],
  [chain("intake_normalizer", openaiLlm401), "setup"],
  [chain("copy_generator", openaiRate429), "serviceBusy"],
  [chain("intake_normalizer", openaiRate429, anthropic529), "serviceBusy"],
  [chain("intake_normalizer", openaiRefusal), "contentBlocked"],
  [chain("copy_generator", openaiContentFilter), "contentBlocked"],
  ['No active recipe seeded for stage "intake"', "setup"],

  // Spend caps (packages/ai caps.ts and router.ts, the runner's pack cap).
  [chain("image.generate", workspaceCap), "workspaceDayCap"],
  [chain("llm.intake", globalCap), "globalDayCap"],
  [chain("image.generate", packCap), "packCap"],
  [
    chain(
      "llm.intake",
      new CapStoreUnavailableError(
        "anthropic-claude",
        "llm.intake",
        new Error(`Spend cap counter caps:pack:${JOB} could not be updated`),
      ),
    ),
    "setup",
  ],
  ["Cost cap reached: pack cap", "packCap"],
  ["This pack reached its spending limit before this shot could be made, so it needs review.", "packCap"],

  // Runner bookkeeping (trigger/src/state.ts).
  [new IllegalTransitionError("done", "fail").message, "internal"],
  ["Credits were already reserved for this job", "internal"],
  ["Reserve amount must be positive, got 0", "internal"],
  ["Cannot charge before reserving", "internal"],
  ["Cannot release 4 credits: only 2 of the reservation is outstanding", "internal"],

  // Settled, reconciled, abandoned and never queued jobs (apps/web).
  [SETTLED_JOB_MESSAGES.crashed, "internal"],
  [SETTLED_JOB_MESSAGES.not_started, "notStarted"],
  [SETTLED_JOB_MESSAGES.interrupted, "restarted"],
  [SETTLED_JOB_MESSAGES.timed_out, "timedOut"],
  [RECONCILED_JOB_ERROR, "interrupted"],
  ["The pack could not be queued.", "notQueued"],
  [new JobAbandonedError(JOB).message, "stopped"],
  ["credit reservation failed", "credits"],
  [`insufficient credit balance for workspace ${WS}: have 2, need 8`, "credits"],
];

// Rule 9: plain spoken, no emojis, no arrows, no dashes as punctuation.
const FORBIDDEN_STYLE = /[–—→←]| - |->|=>|[\u{1F300}-\u{1FAFF}]/u;
// Nothing from the provider layer: names, HTTP wording, statuses or JSON.
const PROVIDER_NAMES = /anthropic|claude|gemini|google|openai|gpt|photoroom|bfl|flux|fal\b|replicate/i;
const ENGINEERING = /responded|status|schema|micros|provider|circuit|breaker|stop_reason|caps:|\b[1-5]\d\d\b|[{}[\]]/i;

function assertSellerSafe(text: string, source: string): void {
  expect(text, source).not.toMatch(PROVIDER_NAMES);
  expect(text, source).not.toMatch(ENGINEERING);
  expect(text, source).not.toMatch(FORBIDDEN_STYLE);
}

describe("publicJobError inventory (A6)", () => {
  it.each(CASES)("maps %j to %s", (raw, kind) => {
    expect(jobErrorKind(raw)).toBe(kind);
    const text = publicJobError(raw);
    expect(text).toBe(JOB_ERROR_COPY[kind]);
    assertSellerSafe(text ?? "", raw);
  });

  it("gives every inventoried message specific copy, never the generic line", () => {
    for (const [raw] of CASES) {
      expect(jobErrorKind(raw), raw).not.toBe("generic");
    }
  });

  it("uses every copy line for at least one stored message", () => {
    const used = new Set(CASES.map(([, kind]) => kind));
    const unused = (Object.keys(JOB_ERROR_COPY) as JobErrorKind[]).filter((k) => k !== "generic" && !used.has(k));
    expect(unused).toEqual([]);
  });

  it("says a bad API key is our problem, not the seller's photo", () => {
    const text = publicJobError(chain("llm.intake", anthropic401));
    expect(text).toContain("problem on our side, not with your photo");
    expect(text).toContain("Nothing was charged");
  });

  it("tells a seller with a screenshot to take a camera photo", () => {
    expect(publicJobError("Refused: the upload is a screenshot")).toBe(
      "This photo looks like a screenshot, not a photo of your product. Take a photo of the product with your camera and start a new pack. Nothing was charged.",
    );
  });
});

describe("seller copy guard", () => {
  it("never lets a provider name, status, JSON or engineering word through", () => {
    const hostile = [
      ...CASES.map(([raw]) => raw),
      'All providers failed for task image.generate: openai-image: openai-image responded 500: {"error":"boom"}',
      "photoroom responded 418: I'm a teapot",
      '{"type":"error","error":{"type":"api_error"}}',
      "TypeError: Cannot read properties of undefined (reading 'shots') at runGeneratePack (pipeline-runner.ts:2201:17)",
      "fal-gateway: 503",
      "Unexpected token < in JSON at position 0",
      "something nobody has seen before",
      "Intake found no sellable product in the uploaded images. Intake saw: {json} 500 ml; <b>openai</b> status [x]",
      "Intake found no sellable product in the uploaded images. Intake saw: gpt-6-luna said OpenAI blue bottle",
      'All providers failed for task shot_planner: openai:gpt-6.1-sol: openai:gpt-6.1-sol responded 500: {"error":"boom"}',
    ];
    for (const raw of hostile) {
      assertSellerSafe(publicJobError(raw) ?? "", raw);
    }
  });

  it("keeps every copy line within rule 9 and says what was charged", () => {
    for (const [kind, text] of Object.entries(JOB_ERROR_COPY)) {
      assertSellerSafe(text, kind);
      expect(text, kind).toMatch(/Nothing was charged|nothing was charged|went back to your balance/);
    }
  });

  it("falls back to the generic line only for messages it does not know", () => {
    expect(jobErrorKind("something nobody has seen before")).toBe("generic");
    expect(publicJobError("something nobody has seen before")).toBe(JOB_ERROR_COPY.generic);
  });
});

describe("moderation and no product copy (PHASE_14 workstream 2, item 3.3)", () => {
  const flags = { nudity: false, weapons: false, drugs: false, prohibited: false, realPersonMainSubject: false };

  it("never mentions a manual review, and names the category with what to do", () => {
    for (const text of Object.values(JOB_ERROR_COPY)) {
      expect(text).not.toMatch(/manual review|flagged for/i);
    }
    const weapons = publicJobError(moderationBlockedMessage(["weapons"]));
    expect(weapons).toContain("weapons");
    expect(weapons).toContain("Nothing was charged");
    expect(weapons).toContain("use a different photo");
    const adult = publicJobError(moderationBlockedMessage(["nudity"]));
    expect(adult).toContain("nudity or adult content");
    expect(adult).toContain("use a different photo");
  });

  it("tells an assistant its prohibited goods pack stopped with the neutral line, and the page that it can run here (P19-29)", () => {
    const raw = restrictedProductMessage(["self_defense_weapons"]);
    expect(publicJobError(raw, "assistant")).toBe(MCP_COPY.restrictedProduct);
    expect(jobErrorLineFor(publicJobError(raw), "assistant")).toBe(MCP_COPY.restrictedProduct);
    const page = publicJobError(raw);
    expect(page).toBe(JOB_ERROR_COPY.blockedRestricted);
    expect(page).toContain("Nothing was charged");
    expect(page).not.toContain("self_defense_weapons");
  });

  it("keeps missing screening distinct from a prohibited product on both surfaces", () => {
    expect(jobErrorKind(SCREENING_UNAVAILABLE_MESSAGE)).toBe("screeningUnavailable");
    expect(publicJobError(SCREENING_UNAVAILABLE_MESSAGE)).toBe(MCP_COPY.screeningUnavailable);
    expect(publicJobError(SCREENING_UNAVAILABLE_MESSAGE, "assistant")).toBe(MCP_COPY.screeningUnavailable);
    expect(jobErrorLineFor(publicJobError(SCREENING_UNAVAILABLE_MESSAGE), "assistant")).toBe(MCP_COPY.screeningUnavailable);
    expect(MCP_COPY.screeningUnavailable).not.toMatch(/prohibited|this kind of product|different photo/i);
  });

  it("gives the plain photo tips when intake saw nothing to name", () => {
    const raw = noSellableProductMessage([{ sellableProduct: false, distinctProducts: 0, sharpEnough: true, addedOverlays: false, restrictedCategory: null, flags }]);
    const text = publicJobError(raw) ?? "";
    expect(text).toBe(JOB_ERROR_COPY.noProduct);
    expect(text).toContain("one product on a plain background");
    expect(text).toContain("the whole product in the frame");
    expect(text).toContain("A note that names the product");
    expect(text).toContain("Nothing was charged");
  });

  it("says what intake saw and that the photo was blurry, in plain words", () => {
    const raw = noSellableProductMessage([
      {
        sellableProduct: false,
        distinctProducts: 0,
        sharpEnough: false,
        addedOverlays: false,
        restrictedCategory: null,
        flags,
        boundingBoxes: [{ label: "Coffee cup", x: 0, y: 0, width: 1, height: 1 }],
        products: [
          { label: "laptop (closed) #2", box: { x: 0, y: 0, width: 1, height: 1 }, matchesIntent: "unclear" },
        ],
      },
    ]);
    const text = publicJobError(raw) ?? "";
    expect(jobErrorKind(raw)).toBe("noProduct");
    expect(text).toContain("We saw laptop closed and coffee cup");
    expect(text).toContain("The photo also looked blurry.");
    expect(text).toContain("one product on a plain background");
    expect(text).toContain("Nothing was charged");
    assertSellerSafe(text, raw);
    expect(noProductCopy(raw)).toBe(text);
  });

  it("keeps a label that sounds like another failure on the no product line", () => {
    const raw = "Intake found no sellable product in the uploaded images. Intake saw: phone screenshot; more than one product";
    expect(jobErrorKind(raw)).toBe("noProduct");
  });
});

describe("needsReviewNote shot reasons (A6)", () => {
  const SHOT_CASES: Array<[string, RegExp]> = [
    ["We could not separate the product from its background in this photo, so this shot needs review.", /separate the product/],
    ["This image has no product to place for this channel, so it needs review.", /find the product clearly/],
    ["The product would be cut off at this channel's shape, so this image needs review.", /cut off/],
    ["This image could not be prepared for another channel, so it needs review.", /prepare this image/],
    ["This image could not be prepared for this channel, so it needs review.", /prepare this image/],
    ["This photo is a screenshot, so this shot needs review.", /screenshot/],
  ];

  it.each(SHOT_CASES)("gives %j its own reason", (hint, says) => {
    const note = needsReviewNote(hint);
    expect(note).toMatch(says);
    expect(note).not.toContain("quality bar");
    expect(note).toContain("No credits were charged");
    assertSellerSafe(note, hint);
  });

  it("never repeats a raw provider hint", () => {
    const note = needsReviewNote(chain("image.generate", openai401));
    assertSellerSafe(note, "raw hint");
  });
});
