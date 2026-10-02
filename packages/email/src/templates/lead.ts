/**
 * Lifecycle emails to a lead, someone who left an email on a free tool
 * without an account (docs/phases/PHASE_18.md P18-07). Every one is
 * marketing under CAN-SPAM, so each carries the ad notice, the postal
 * address and the unsubscribe links, and a marketing unsubscribe stops it:
 * - lead_results links back to the tool (the measured results live only in
 *   the browser, P18-07 deviation 3), so it promotes Curvi rather than
 *   completing anything the visitor asked for. It goes only to leads who
 *   ticked the consent box (founder decision 5).
 * - packs_back goes to a visitor who asked to hear when packs are back
 *   (the P18-03 waitlist); that request is the reason, no box needed.
 * - lead_tip and lead_offer go only to leads who ticked the consent box;
 *   the copy is docs/marketing.md T-LEAD-02 and T-LEAD-03.
 */

import type { EmailTemplate } from "../render";

/** The free tools a lead_results email links back to, by lead source. */
export const LEAD_TOOLS: Readonly<Record<string, { name: string; path: string }>> = {
  "main-image-checker": { name: "main image checker", path: "/tools/main-image-checker" },
  "white-background-fixer": { name: "white background fixer", path: "/tools/white-background-fixer" },
  "marketplace-resizer": { name: "marketplace resizer", path: "/tools/marketplace-resizer" },
  "store-audit": { name: "store image audit", path: "/tools/store-image-audit" },
};

export interface LeadResultsData {
  source: string;
}

export const leadResultsEmail: EmailTemplate<LeadResultsData> = {
  key: "lead_results",
  kind: "marketing",
  audience: "lead",
  render: (data, ctx) => {
    const tool = LEAD_TOOLS[data.source];
    if (!tool) {
      throw new Error(`No free tool for the lead source ${data.source}.`);
    }
    return {
      subject: `Your Curvi ${tool.name} link`,
      paragraphs: [
        `Thanks for trying the free ${tool.name}. Here is the link, so you can use it again on your next photo: ${ctx.link(tool.path)}`,
        "Questions about your results? Reply to this email.",
      ],
    };
  },
};

export interface LeadOfferData {
  freeCredits: number;
}

export const leadTipEmail: EmailTemplate<Record<string, never>> = {
  key: "lead_tip",
  kind: "marketing",
  audience: "lead",
  render: (_data, ctx) => ({
    subject: "One photo, every channel",
    paragraphs: [
      "Curvi turns one product photo into the files each marketplace and social channel asks for, each checked against that channel's rules, and your product is never redrawn.",
      `See packs made from one photo: ${ctx.link("/gallery")}`,
    ],
  }),
};

export const leadOfferEmail: EmailTemplate<LeadOfferData> = {
  key: "lead_offer",
  kind: "marketing",
  audience: "lead",
  render: (data, ctx) => ({
    subject: "Make your first pack free",
    paragraphs: [
      `${data.freeCredits} free ${data.freeCredits === 1 ? "credit" : "credits"}, no card. Upload one photo and get your main image, lifestyle scenes and channel sizes. Your product is never redrawn: ${ctx.link("/signup", { source: "email" })}`,
    ],
  }),
};

export const packsBackLeadEmail: EmailTemplate<Record<string, never>> = {
  key: "packs_back",
  kind: "marketing",
  audience: "lead",
  render: (_data, ctx) => ({
    subject: "Curvi packs are back",
    paragraphs: [`Thanks for waiting. Packs are running again: ${ctx.link("/signup", { source: "email" })}`],
  }),
};
