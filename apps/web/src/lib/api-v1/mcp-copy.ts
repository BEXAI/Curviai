/**
 * Every refusal and status line the MCP endpoint can return to ChatGPT or
 * another assistant (docs/phases/PHASE_19.md, "Neutral messages"). The web
 * app keeps its own copy, because curvi.ai may sell plans; nothing here may.
 * OpenAI's plugin guidelines (docs/verification.md, "PHASE_19: ChatGPT and
 * Codex plugin", O6) forbid selling credits or plans, promoting an upgrade
 * and collecting API keys or passwords in the chat, so these lines state the
 * facts and never point at pricing, billing or a key. A test runs the rule 9
 * lint and a word list over the table (mcp-copy.test.ts), and another walks
 * every string the endpoint can send (app/api/mcp/mcp-copy-reach.test.ts).
 *
 * Filled from the plan in wave 0 so every PHASE_19 lane reads one table;
 * each lane wires the lines it owns (P19-08 sign in, P19-14 refusals and the
 * pack lines, P19-15 photos, P19-16 credits, P19-17 links, P19-29
 * screening).
 */

/** "1 credit", "12 credits". */
function credits(count: number): string {
  return count === 1 ? "1 credit" : `${count} credits`;
}

export const MCP_COPY = {
  // Credits (P19-14, P19-16)
  insufficientCredits: (needed: number, available: number): string =>
    `This pack needs ${credits(needed)} and the workspace has ${available}, so it was not started. Pick fewer channels or a smaller set.`,
  packStoppedForCredits: "There were not enough credits to start this pack. Nothing was charged.",
  overMaxCredits: (needed: number, max: number): string =>
    `This pack needs ${credits(needed)}, more than the ${max} in the estimate, so it was not started. Ask for a new estimate.`,
  quoteNeeded: "This pack needs a fresh estimate. Call estimate_pack with the same photos and choices.",
  maxCreditsNeeded:
    "Send max_credits with the quote: the credits_needed number estimate_pack returned. Nothing was started.",
  packStarted: (held: number): string =>
    `Started a pack that holds ${credits(held)}. You are charged only for images that pass their checks.`,
  estimateReady: (needed: number, available: number): string =>
    `This pack needs ${credits(needed)} and the workspace has ${available}.`,
  estimateShort: (needed: number, available: number): string =>
    `This pack needs ${credits(needed)} and the workspace has ${available}, so it cannot start. Pick fewer channels or a smaller set.`,
  estimateUnavailable: "Curvi cannot count credits right now, so no pack can start. Try again in a few minutes.",

  // Plan features, never with upgrade wording (P19-03, P19-14, P19-18)
  featureNotInPlan: (feature: string): string =>
    `${feature} is not part of this workspace's current plan. Remove those channels to start this pack.`,
  brandColorsNotInPlan: "Brand colors are not part of this workspace's current plan. Pick another background color.",
  optionsPaused: "Background and scene choices are paused right now. Leave them out to start this pack.",
  assistantAccessOff: "Using Curvi from ChatGPT is not part of this workspace's current plan.",
  apiKeysNotInPlan: "API keys are not part of this workspace's current plan.",
  channelNotInPlan: "Not part of this workspace's current plan",
  channelComingSoon: "Coming soon",
  channelNotMade: "Not made from these photos and choices. A kept photo may be too small for this channel.",

  // Sign in (P19-08). Never asks for an API key or a password.
  connectAccount: "Connect your Curvi account to use this.",
  reconnect: "Connect Curvi again in ChatGPT and choose a workspace.",
  connectionUnavailable: "We could not check your Curvi connection right now. Try again in a minute.",
  insufficientScope: "This connection is not allowed to do this.",
  keyRefused: "This key is not valid or was turned off.",

  // Requests (P19-14, P19-29)
  restrictedProduct: "Curvi cannot make images of this product from ChatGPT. Nothing was charged.",
  screeningUnavailable: "Curvi's product screening is temporarily unavailable, so no images were made. Nothing was charged. Try again later.",
  unknownChannels: (names: readonly string[]): string =>
    `Curvi does not know ${names.join(", ")}. Call list_channels to see the channels it makes.`,
  clientSeat: "Client seats can review assets but cannot start packs or spend credits.",
  idempotencyConflict:
    "A different pack was already started with this idempotency_key. Leave idempotency_key out and ask again.",
  unavailable: "Curvi could not do this right now. Try again in a minute.",
  packsPaused: "New packs are paused right now. Nothing was charged. Try again later.",
  workspaceDayCap: "This workspace has reached its daily limit for making images. Nothing was charged. Try again tomorrow.",
  noImagesPlanned: "No images could be planned from these photos and choices. Nothing was charged. Try another photo or channel.",

  // Photos (P19-15)
  photoUnreadable: (photoNumber: number): string =>
    `Photo ${photoNumber} could not be read. Attach it again as a JPEG or PNG.`,
  noAttachment: "No photo came through. Attach the product photo again and ask once more.",
  heic: "This photo is in HEIC format, which Curvi cannot read yet. Save it as JPEG or PNG and attach it again.",
  photoTooLarge: (photoNumber: number): string =>
    `Photo ${photoNumber} is too large for Curvi. Attach a smaller copy as a JPEG or PNG.`,
  photoTimeout: (photoNumber: number): string =>
    `Photo ${photoNumber} took too long to arrive. Attach it again and ask once more.`,
  photoNotDownloaded: (photoNumber: number): string =>
    `Photo ${photoNumber} could not be downloaded. Attach it again and ask once more.`,
  photoSourcesBoth: "Send attached images or photo links, not both.",

  // Pack progress (P19-14): the one plain sentence each pack view carries.
  packTakesMinutes: "It takes a few minutes.",
  packReplayed: "This pack was already started, so nothing more was held.",
  packQueued: "The pack is waiting to start. It takes a few minutes.",
  packPlanning: "Curvi is reading the photo and planning the images.",
  packWorking: (done: number, total: number): string =>
    `Curvi is making the images: ${done} of ${total} ${total === 1 ? "is" : "are"} ready.`,
  packReady: (passed: number, images: number): string =>
    images === 1
      ? `The pack is ready: ${passed} of 1 image passed its channel check.`
      : `The pack is ready: ${passed} of ${images} images passed their channel checks.`,
  packReadyNoImages: "The pack finished, but no image passed its checks, so nothing was charged for them.",
  packFailed: "The pack stopped. Credits held for images that were not made went back to the workspace.",
  packCanceled: "This pack was stopped. Credits held for images that were not made went back to the workspace.",
  linksValid: (minutes: number): string =>
    minutes >= 60 && minutes % 60 === 0
      ? `The links work for ${minutes === 60 ? "1 hour" : `${minutes / 60} hours`}.`
      : `The links work for ${minutes === 1 ? "1 minute" : `${minutes} minutes`}.`,

  // Links (P19-17)
  linkExpired: "This link expired. Ask ChatGPT for the pack's files again.",
  linkUnavailable: "Downloads are not available right now. Try the link again in a few minutes.",
} as const;

export type McpCopyKey = keyof typeof MCP_COPY;

/** Words no MCP reachable string may use (PHASE_19 R14, R16): they promote
 * a plan, a purchase or a price. */
export const MCP_BANNED_WORDS = [
  "upgrade",
  "top up",
  "billing",
  "see plans",
  "pricing",
  "checkout",
  "subscribe",
  "free trial",
] as const;

/** Wording that asks the user for an API key, a token or a password, which
 * OpenAI forbids collecting in the chat (R27), or calls a call "free"
 * (R16: tool text may say a call uses no credits, never "Free"). */
const MCP_BANNED_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [/\bsend (your|an|a|the)\b[^.]*\b(key|token|password)\b/i, "asks for a key"],
  [/\bmake (a|one|a new)\b[^.]*\bkey\b/i, "asks for a key"],
  [/\bsettings, api keys\b/i, "asks for a key"],
  [/\bpaste\b/i, "asks for a key"],
  [/\bbearer\b/i, "asks for a key"],
  [/\bpassword\b/i, "asks for a password"],
  [/\bfree\b/i, "says free"],
  [/\bprice/i, "names a price"],
];

/**
 * Why a string may not reach an assistant: a banned word, a request for a
 * key or a password, or "free". Empty when it is fine. The rule 9 lint
 * (packages/pipeline copy-lint) runs beside it in the tests; this part is
 * cheap enough to guard every tool result at run time (mcp-tools.ts).
 */
export function mcpCopyProblems(text: string): string[] {
  const lower = text.toLowerCase();
  return [
    ...MCP_BANNED_WORDS.filter((word) => lower.includes(word)).map((word) => `banned word: ${word}`),
    ...MCP_BANNED_PATTERNS.filter(([pattern]) => pattern.test(text)).map(([, problem]) => problem),
  ];
}
