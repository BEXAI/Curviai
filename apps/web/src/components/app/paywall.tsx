"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";
import { Button, buttonVariants, cn } from "@curvi/ui";
import { headerBalanceLabel, isLowBalance, type PaywallCopy } from "@/lib/billing/paywall";
import { track } from "@/lib/track";

/** Title, paragraphs and links shared by the dialog and the nudge. */
function PaywallBody({ copy, titleId, moment }: { copy: PaywallCopy; titleId: string; moment: string }) {
  return (
    <>
      <p id={titleId} className="text-base font-semibold text-ink-950">
        {copy.title}
      </p>
      {copy.paragraphs.map((paragraph) => (
        <p key={paragraph} className="mt-2 text-sm text-ink-700">
          {paragraph}
        </p>
      ))}
      {copy.actions.length > 0 ? (
        <div className="mt-4 flex flex-wrap gap-2">
          {copy.actions.map((action) => (
            <Link
              key={action.href}
              href={action.href}
              className={buttonVariants({ variant: action.primary ? "secondary" : "outline", size: "sm" })}
              data-testid="paywall-action"
              onClick={() => track("paywall_clicked", { moment, label: action.label })}
            >
              {action.label}
            </Link>
          ))}
        </div>
      ) : null}
    </>
  );
}

/**
 * The out of credits dialog the new pack form opens when the server refuses
 * a pack for its balance. A native modal dialog, so focus, Escape and the
 * backdrop behave like any other dialog; closing it keeps the form as it was
 * so the seller can pick fewer channels.
 */
export function OutOfCreditsDialog({ copy, onClose }: { copy: PaywallCopy | null; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const open = copy !== null;

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog || !open) {
      return;
    }
    if (!dialog.open) {
      if (typeof dialog.showModal === "function") {
        dialog.showModal();
      } else {
        dialog.setAttribute("open", "");
      }
    }
    track("paywall_shown", { moment: "create_pack" });
    return () => {
      if (dialog.open) {
        dialog.close();
      }
    };
  }, [open]);

  if (!copy) {
    return null;
  }
  return (
    <dialog
      ref={ref}
      aria-labelledby="out-of-credits-title"
      onClose={onClose}
      onClick={(event) => {
        // A click on the backdrop lands on the dialog element itself.
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
      className="m-auto w-[min(28rem,calc(100vw-2rem))] rounded-xl border border-ink-100 bg-white p-0 shadow-xl backdrop:bg-ink-950/40"
      data-testid="out-of-credits-dialog"
    >
      <div className="p-6">
        <PaywallBody copy={copy} titleId="out-of-credits-title" moment="create_pack" />
        <div className="mt-4 border-t border-ink-100 pt-4">
          <Button variant="ghost" size="sm" onClick={onClose} data-testid="paywall-close">
            Pick fewer channels
          </Button>
        </div>
      </div>
    </dialog>
  );
}

/** The low balance nudge on the dashboard and the new pack page. */
export function LowBalanceNudge({ copy, moment }: { copy: PaywallCopy | null; moment: "dashboard" | "new_pack" }) {
  if (!copy) {
    return null;
  }
  return (
    <div
      className="rounded-xl border border-amber-200 bg-amber-50 p-4"
      role="status"
      data-testid="low-balance-nudge"
    >
      <PaywallBody copy={copy} titleId={`low-balance-${moment}`} moment={moment} />
    </div>
  );
}

/** The workspace balance in the app header, linking to billing. */
export function HeaderCreditBalance({ creditBalance, lowThreshold }: { creditBalance: number; lowThreshold: number }) {
  const warn = creditBalance < 0 || isLowBalance(creditBalance, lowThreshold);
  return (
    <Link
      href="/app/billing"
      className={cn(
        "rounded-lg px-2.5 py-1.5 text-sm font-medium transition-colors",
        warn ? "bg-amber-50 text-amber-900 hover:bg-amber-100" : "text-ink-700 hover:bg-ink-50 hover:text-ink-950",
      )}
      title="Credit balance. Open Billing to add credits."
      data-testid="header-credit-balance"
    >
      {headerBalanceLabel(creditBalance)}
    </Link>
  );
}
