"use client";

import { useState, useTransition } from "react";
import { Button, Input, Label } from "@curvi/ui";
import { deleteAccountAction } from "@/app/app/settings/actions";
import { DELETE_CONFIRMATION_WORD } from "@/lib/trust/confirmation";

/**
 * Two step account deletion: a button opens the confirmation, which needs
 * the word DELETE typed out. The server checks the word again, refuses while
 * a pack runs or a paid plan is open, and on success signs out and moves to
 * /account-deleted.
 */
export function DeleteAccountForm({ disabledReason }: { disabledReason?: string | null }) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const confirmed = typed.trim().toUpperCase() === DELETE_CONFIRMATION_WORD;

  if (disabledReason) {
    return (
      <p className="text-sm text-ink-500" data-testid="delete-account-unavailable">
        {disabledReason}
      </p>
    );
  }

  if (!open) {
    return (
      <Button variant="outline" onClick={() => setOpen(true)} data-testid="delete-account-open">
        Delete account
      </Button>
    );
  }

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setNotice(null);
    startTransition(async () => {
      const result = await deleteAccountAction(typed);
      // Success redirects away; only a refusal comes back.
      if (!result.ok) {
        setNotice(result.notice);
      }
    });
  }

  return (
    <form onSubmit={submit} className="max-w-md space-y-3 rounded-lg border border-red-200 bg-red-50 p-4" data-testid="delete-account-form">
      <p className="text-sm text-ink-900">
        This deletes your workspace, products, photos, packs, files and credits for good. It cannot be undone.
        Export your data first if you want a copy.
      </p>
      <div className="space-y-1.5">
        <Label htmlFor="delete-confirm">Type {DELETE_CONFIRMATION_WORD} to confirm</Label>
        <Input
          id="delete-confirm"
          value={typed}
          autoComplete="off"
          onChange={(event) => setTyped(event.target.value)}
        />
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" variant="danger" loading={pending} disabled={pending || !confirmed}>
          Delete my account
        </Button>
        <Button
          variant="ghost"
          disabled={pending}
          onClick={() => {
            setOpen(false);
            setTyped("");
            setNotice(null);
          }}
        >
          Keep my account
        </Button>
      </div>
      {notice ? (
        <p role="alert" className="text-sm text-red-700" data-testid="delete-account-result">
          {notice}
        </p>
      ) : null}
    </form>
  );
}
