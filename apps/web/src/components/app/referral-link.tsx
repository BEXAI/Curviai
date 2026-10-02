"use client";

import { useState } from "react";
import { Button, Input, Label } from "@curvi/ui";
import { REFERRAL_COPIED_LABEL, REFERRAL_COPY_LABEL, REFERRAL_LINK_LABEL } from "./referral-copy";

/** The invite link with a copy button (P18-24). */
export function ReferralLink({ link }: { link: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="space-y-1.5" data-testid="referral-link">
      <Label htmlFor="referral-link">{REFERRAL_LINK_LABEL}</Label>
      <div className="flex max-w-xl gap-2">
        <Input id="referral-link" readOnly value={link} onFocus={(event) => event.currentTarget.select()} />
        <Button type="button" variant="outline" onClick={copy}>
          {copied ? REFERRAL_COPIED_LABEL : REFERRAL_COPY_LABEL}
        </Button>
      </div>
    </div>
  );
}
