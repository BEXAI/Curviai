/**
 * Share buttons for a published pack page (docs/phases/PHASE_18.md P18-14).
 * Each network gets the page link tagged with utm_source=<network>,
 * utm_medium=share and utm_campaign=pack_share (seed growth.ts shareLoop),
 * so a signup that starts on a shared page is counted by network: the share
 * page's Make mine link carries the tags on to /signup (SignupLink).
 *
 * The intent URL formats were checked on 2026-10-01 (docs/verification.md,
 * "Phase 18 concierge"): X documents https://x.com/intent/tweet with text
 * and url; LinkedIn's share plugin opens its share page with url; Pinterest's
 * own widget code builds pin/create/button with url, media and description;
 * Reddit's submit page takes url and title. Client safe and pure.
 */

import { shareLoop } from "@curvi/pipeline/seed";

export const SHARE_NETWORKS = ["x", "linkedin", "pinterest", "reddit"] as const;
export type ShareNetwork = (typeof SHARE_NETWORKS)[number];

/** utm_source for the phone's own share sheet (navigator.share). */
export const DEVICE_SHARE_SOURCE = "device";

/**
 * The page URL with this share's UTM tags. Tags already on the URL are
 * replaced, so a link shared twice never carries two sources.
 */
export function taggedShareUrl(pageUrl: string, source: string): string {
  const url = new URL(pageUrl);
  url.searchParams.set("utm_source", source);
  url.searchParams.set("utm_medium", shareLoop.utmMedium);
  url.searchParams.set("utm_campaign", shareLoop.utmCampaign);
  return url.toString();
}

export interface ShareIntentInput {
  /** The public page, absolute: https://curvi.ai/s/{slug}. */
  pageUrl: string;
  /** The page's share image, absolute (Pinterest pins an image). */
  imageUrl: string;
  /** The words to post with the link. */
  text: string;
}

/** The network's own share page for this pack page, link tagged. */
export function shareIntentUrl(network: ShareNetwork, input: ShareIntentInput): string {
  const link = taggedShareUrl(input.pageUrl, network);
  switch (network) {
    case "x": {
      const params = new URLSearchParams({ text: input.text, url: link });
      return `https://x.com/intent/tweet?${params.toString()}`;
    }
    case "linkedin": {
      const params = new URLSearchParams({ url: link });
      return `https://www.linkedin.com/sharing/share-offsite/?${params.toString()}`;
    }
    case "pinterest": {
      const params = new URLSearchParams({ url: link, media: input.imageUrl, description: input.text });
      return `https://www.pinterest.com/pin/create/button/?${params.toString()}`;
    }
    case "reddit": {
      const params = new URLSearchParams({ url: link, title: input.text });
      return `https://www.reddit.com/submit?${params.toString()}`;
    }
  }
}
