"use client";

import { useEffect, useState } from "react";
import { Button, buttonVariants } from "@curvi/ui";
import { SHARE_BUTTONS_COPY, SHARE_NETWORK_LABELS, SHARE_TEXT } from "@/lib/shares/loop-copy";
import { DEVICE_SHARE_SOURCE, SHARE_NETWORKS, shareIntentUrl, taggedShareUrl } from "@/lib/shares/share-links";
import { track } from "@/lib/track";

/**
 * The share buttons of a published pack page (docs/phases/PHASE_18.md
 * P18-14): X, LinkedIn, Pinterest (with the page's share image) and Reddit,
 * each opening the network's own share page with the link tagged by
 * network, plus the phone's share sheet where the browser has one. path is
 * the page's same origin path, "/s/{slug}".
 */
export function ShareButtons({ path }: { path: string }) {
  const [origin, setOrigin] = useState<string | null>(null);
  const [canShare, setCanShare] = useState(false);

  useEffect(() => {
    setOrigin(window.location.origin);
    setCanShare(typeof navigator.share === "function");
  }, []);

  if (!origin) {
    return null;
  }
  const pageUrl = `${origin}${path}`;
  const imageUrl = `${pageUrl}/og`;

  async function shareFromDevice() {
    track("share_clicked", { network: DEVICE_SHARE_SOURCE });
    try {
      await navigator.share({ title: SHARE_TEXT, text: SHARE_TEXT, url: taggedShareUrl(pageUrl, DEVICE_SHARE_SOURCE) });
    } catch {
      // Closing the share sheet rejects; nothing to tell the seller.
    }
  }

  return (
    <div data-testid="share-buttons" className="space-y-2">
      <p className="text-sm font-semibold text-ink-900">{SHARE_BUTTONS_COPY.heading}</p>
      <div className="flex flex-wrap gap-2">
        {canShare ? (
          <Button size="sm" variant="secondary" onClick={() => void shareFromDevice()} data-testid="share-device">
            {SHARE_BUTTONS_COPY.device}
          </Button>
        ) : null}
        {SHARE_NETWORKS.map((network) => (
          <a
            key={network}
            href={shareIntentUrl(network, { pageUrl, imageUrl, text: SHARE_TEXT })}
            target="_blank"
            rel="noopener noreferrer"
            className={buttonVariants({ size: "sm", variant: "outline" })}
            data-testid={`share-${network}`}
            onClick={() => track("share_clicked", { network })}
          >
            {SHARE_NETWORK_LABELS[network]}
          </a>
        ))}
      </div>
      <p className="text-xs text-ink-500">{SHARE_BUTTONS_COPY.hint}</p>
    </div>
  );
}
