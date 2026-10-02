/**
 * Every lifecycle email template (docs/phases/PHASE_18.md P18-07). Keys
 * match the seed's lifecycleTemplateKeys; packs_back has one template per
 * audience, since its footer says why the reader gets it.
 */

import type { EmailTemplate } from "../render";
import {
  feedbackAskEmail,
  firstPackNudge1Email,
  firstPackNudge2Email,
  outOfCreditsEmail,
  packReadyEmail,
  packsBackAccountEmail,
  referralRewardedEmail,
  welcomeEmail,
  winBackEmail,
} from "./account";
import { leadOfferEmail, leadResultsEmail, leadTipEmail, packsBackLeadEmail } from "./lead";

export * from "./account";
export * from "./format";
export * from "./lead";

/** Every template object, for the copy lint and the template key check. */
export const lifecycleTemplates: readonly EmailTemplate<never>[] = [
  welcomeEmail,
  firstPackNudge1Email,
  firstPackNudge2Email,
  packReadyEmail,
  feedbackAskEmail,
  outOfCreditsEmail,
  winBackEmail,
  packsBackAccountEmail,
  packsBackLeadEmail,
  leadResultsEmail,
  leadTipEmail,
  leadOfferEmail,
  referralRewardedEmail,
] as readonly EmailTemplate<never>[];
