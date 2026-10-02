/**
 * The privacy policy text that covers ChatGPT and other assistants
 * (PHASE_19 P19-23), kept as data so a test can check it against every
 * field the MCP tools return (./assistant-fields.ts). The founder approves
 * this text before it ships (PHASE_19 decision 10).
 *
 * Retention defaults, FOUNDER CONFIRMS before the privacy update ships:
 * - Request logs: up to LEGAL_FACTS.retention.logDays (30) days, the one
 *   number the retention table also states for request logs and error
 *   reports (docs/phases/PHASE_20.md P20-23). Render keeps service logs 7,
 *   14 or 30 days by workspace plan (docs/verification.md, PHASE_19,
 *   p19/site), and Sentry's Developer plan looks back 30 days, so "up to 30
 *   days" holds for both.
 * - Connection records: until the account is closed. The plan's draft said
 *   "until you disconnect or close your account", but a disconnect only marks
 *   the record revoked (PHASE_19 "Revocation": a revoked row is never
 *   recreated silently), so the text says what the code keeps. The retention
 *   table has the same row (lib/legal/retention.ts, assistant_connections).
 * - Original photos: the retention table's row, from SOURCE_RETENTION_DAYS
 *   in lib/trust/purge.ts through lib/legal/facts.ts.
 */

import { LEGAL_FACTS } from "@/lib/legal/facts";

function requestLogDays(): number {
  const days = LEGAL_FACTS.retention.logDays;
  if (days === null) {
    throw new Error("LEGAL_FACTS.retention.logDays must be set while the privacy policy states request log retention.");
  }
  return days;
}

export const REQUEST_LOG_RETENTION_DAYS = requestLogDays();

/** "Using Curvi from ChatGPT and other assistants". */
export const assistantPrivacy = {
  heading: "Using Curvi from ChatGPT and other assistants",
  signIn:
    "When you connect Curvi to ChatGPT or another assistant, the assistant receives a private id for your Curvi account and your email address when you sign in, plus any other sign in details it asks for, which the connect page lists.",
  received:
    "For each request we receive a sign in token for your Curvi account, the photos you attach, the choices the assistant sends, and hints the assistant adds: your language, an approximate location (city, region, country, time zone and rough coordinates), the app or browser in use, and anonymous ids for you, the conversation and your organization. We do not store these hints. We do not receive your conversations. Photos for a pack are kept like any other upload; photos sent only for a credit estimate or a main image check are not stored.",
  sentIntro:
    "We send back what the assistant asks for, and the company that runs the assistant receives it: OpenAI for ChatGPT and Codex. That can be:",
  sent: [
    "your account email and workspace name",
    "product titles, pack ids, pack status and how far a pack has got",
    "the channels each pack is for, file names and types, image previews and download links, and how long the links work",
    "credits held and credits used, the credits a pack would need, your workspace's credit balance, and a signed code for an estimate and how long it is valid",
    "image check results, the size of a checked photo and the rules it was checked against",
    "stored product fidelity measurements for delivered files: average color difference, largest color difference, share of exactly matching pixels, number of pixels compared, measurement limits, type of image measured, and whether the file is the original upload",
    "the channels a pack would leave out and why",
    "the channels Curvi offers, other names it accepts for them, their sizes, the pack sets, backgrounds and scene styles, and which of them your plan includes",
    "a short message about each request, and whether it repeated an earlier one",
  ],
  retention: `Connection records, which say which assistant can use which workspace and when it was last used, stay until you close your account, including after you disconnect, so a disconnected assistant cannot come back without asking you. Request logs, which include IP addresses, are kept for up to ${REQUEST_LOG_RETENTION_DAYS} days. You can disconnect at any time in Settings, Connected apps.`,
} as const;

/** Every sentence of the assistant section, for tests and the copy rules. */
export function assistantPrivacyText(): string {
  return [
    assistantPrivacy.heading,
    assistantPrivacy.signIn,
    assistantPrivacy.received,
    assistantPrivacy.sentIntro,
    ...assistantPrivacy.sent,
    assistantPrivacy.retention,
  ].join("\n");
}

/** Added to "What we collect". */
export const collectAssistants =
  "If you connect Curvi to an assistant such as ChatGPT, we also keep a record of that connection and receive what the section on assistants below describes.";

/** Added to "Sharing": OpenAI as a recipient of the results you ask for. */
export const sharingAssistants =
  "When you use Curvi from ChatGPT or another assistant, we send the results you ask for to that assistant, so OpenAI receives them when you use ChatGPT or Codex.";
