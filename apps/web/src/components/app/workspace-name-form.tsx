"use client";

import { useState, useTransition } from "react";
import { Button, Input, Label, cn } from "@curvi/ui";
import { renameWorkspaceAction } from "@/app/app/settings/actions";

export function WorkspaceNameForm({ initialName }: { initialName: string }) {
  const [name, setName] = useState(initialName);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, startTransition] = useTransition();

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    startTransition(async () => {
      const result = await renameWorkspaceAction(name);
      setNotice({ ok: result.ok, text: result.notice });
    });
  }

  return (
    <form onSubmit={submit} className="max-w-sm space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor="workspace-name">Name</Label>
        <Input
          id="workspace-name"
          value={name}
          maxLength={80}
          required
          onChange={(event) => setName(event.target.value)}
        />
      </div>
      <Button type="submit" loading={pending} disabled={pending || name.trim() === initialName.trim()}>
        Save name
      </Button>
      {notice ? (
        <p className={cn("text-sm", notice.ok ? "text-emerald-700" : "text-amber-700")} data-testid="workspace-rename-result">
          {notice.text}
        </p>
      ) : null}
    </form>
  );
}
