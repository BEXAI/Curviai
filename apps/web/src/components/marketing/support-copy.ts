/**
 * The support page (https://curvi.ai/support, PHASE_19 P19-23 and decision
 * 10). OpenAI's plugin review needs a support URL on the publisher's own
 * site (docs/verification.md, PHASE_19, O3 and O6).
 *
 * The email and the reply time come from lib/legal/facts.ts
 * (docs/phases/PHASE_20.md P20-23, founder decision 24), the same facts the
 * terms and privacy pages state. Server side, as LEGAL_FACTS is.
 */

import { supportReplyTime } from "@/lib/legal/copy";
import { LEGAL_FACTS } from "@/lib/legal/facts";

export const SUPPORT_EMAIL = LEGAL_FACTS.support.email;

export const SUPPORT_RESPONSE_TIME = supportReplyTime(LEGAL_FACTS);

export const supportCopy = {
  title: "Support",
  metaDescription:
    "How to reach Curvi for help with your account, your packs and assistants such as ChatGPT that use your workspace.",
  lead: `Need help? Email ${SUPPORT_EMAIL} and we answer within ${SUPPORT_RESPONSE_TIME}. Include your workspace name and, for a pack, the pack id ChatGPT showed you.`,
  helpHeading: "Answers right away",
  helpBody: "The Help center covers photos, credits, compliance reports, the brand kit and channels.",
  helpLink: "Open the Help center",
  connectionsHeading: "Connected apps",
  connectionsBody:
    "To see which assistants can use your workspace, or to stop one, open Settings, Connected apps in Curvi and press Disconnect.",
  connectionsLink: "Open Connected apps",
  policiesHeading: "Privacy and terms",
  policiesBody: `Privacy questions and requests to see or delete your data go to ${SUPPORT_EMAIL} too.`,
} as const;
