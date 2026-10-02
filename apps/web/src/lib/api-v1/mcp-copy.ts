/**
 * Every refusal and status line the MCP endpoint can return to ChatGPT or
 * another assistant (docs/phases/PHASE_19.md, "Neutral messages"). The web
 * app keeps its own copy, because curvi.ai may sell plans; nothing here may.
 * OpenAI's plugin guidelines (docs/verification.md, "PHASE_19: ChatGPT and
 * Codex plugin", O6) forbid selling credits or plans, promoting an upgrade
 * and collecting API keys or passwords in the chat, so these lines state the
 * facts and never point at pricing, billing or a key. A test runs the rule 9
 * lint and a word list over the table (mcp-copy.test.ts).
 *
 * Filled from the plan in wave 0 so every PHASE_19 lane reads one table;
 * each lane wires the lines it owns (P19-08 sign in, P19-14 refusals,
 * P19-15 photos, P19-16 credits, P19-17 links, P19-29 screening).
 */

export const MCP_COPY = {
  // Credits (P19-14, P19-16)
  insufficientCredits: (needed: number, available: number): string =>
    `This pack needs ${needed} credits and the workspace has ${available}, so it was not started. Pick fewer channels or a smaller set.`,
  packStoppedForCredits: "There were not enough credits to start this pack. Nothing was charged.",
  overMaxCredits: (needed: number, max: number): string =>
    `This pack needs ${needed} credits, more than the ${max} in the estimate, so it was not started. Ask for a new estimate.`,
  quoteNeeded: "This pack needs a fresh estimate. Call estimate_pack with the same photos and choices.",
  packStarted: (held: number): string =>
    `Started a pack that holds ${held} credits. You are charged only for images that pass their checks.`,

  // Plan features, never with upgrade wording (P19-03, P19-14, P19-18)
  featureNotInPlan: (feature: string): string =>
    `${feature} is not part of this workspace's current plan. Remove those channels to start this pack.`,
  brandColorsNotInPlan: "Brand colors are not part of this workspace's current plan. Pick another background color.",
  assistantAccessOff: "Using Curvi from ChatGPT is not part of this workspace's current plan.",
  apiKeysNotInPlan: "API keys are not part of this workspace's current plan.",
  channelNotInPlan: "Not part of this workspace's current plan",
  channelComingSoon: "Coming soon",

  // Sign in (P19-08). Never asks for an API key or a password.
  connectAccount: "Connect your Curvi account to use this.",
  reconnect: "Connect Curvi again in ChatGPT and choose a workspace.",

  // Requests (P19-14, P19-29)
  restrictedProduct: "Curvi cannot make images of this product from ChatGPT. Nothing was charged.",
  unknownChannels: (names: readonly string[]): string =>
    `Curvi does not know ${names.join(", ")}. Call list_channels to see the channels it makes.`,
  clientSeat: "Client seats can review assets but cannot start packs or spend credits.",

  // Photos (P19-15)
  photoUnreadable: (photoNumber: number): string =>
    `Photo ${photoNumber} could not be read. Attach it again as a JPEG or PNG.`,
  noAttachment: "No photo came through. Attach the product photo again and ask once more.",
  heic: "This photo is in HEIC format, which Curvi cannot read yet. Save it as JPEG or PNG and attach it again.",

  // Links (P19-17)
  linkExpired: "This link expired. Ask ChatGPT for the pack's files again.",
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
