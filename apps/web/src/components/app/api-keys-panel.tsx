"use client";

import { useState, useTransition } from "react";
import { Badge, Button, Input, Label, cn } from "@curvi/ui";
import { createApiKeyAction, revokeApiKeyAction } from "@/app/app/settings/api/actions";
import type { ApiKeyView } from "@/lib/api-keys/store";
import { shortDate } from "@/lib/dates";

function when(iso: string | null): string {
  return iso ? (shortDate(iso) ?? "Never") : "Never";
}

/** Make, list and revoke workspace API keys. A new key shows once, here. */
export function ApiKeysPanel({ initialKeys }: { initialKeys: ApiKeyView[] }) {
  const [keys, setKeys] = useState(initialKeys);
  const [name, setName] = useState("");
  const [created, setCreated] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, startTransition] = useTransition();

  function create(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    startTransition(async () => {
      const result = await createApiKeyAction(name);
      setNotice({ ok: result.ok, text: result.notice });
      if (result.ok) {
        setCreated(result.key);
        setCopied(false);
        setName("");
        setKeys((current) => [result.view, ...current]);
      }
    });
  }

  function revoke(id: string) {
    startTransition(async () => {
      const result = await revokeApiKeyAction(id);
      setNotice({ ok: result.ok, text: result.notice });
      if (result.ok) {
        const now = new Date().toISOString();
        setKeys((current) => current.map((key) => (key.id === id ? { ...key, revokedAt: key.revokedAt ?? now } : key)));
      }
    });
  }

  async function copy() {
    if (!created) {
      return;
    }
    try {
      await navigator.clipboard.writeText(created);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="space-y-6 ph-no-capture ph-mask">
      <form onSubmit={create} className="max-w-sm space-y-3" data-testid="api-key-create">
        <div className="space-y-1.5">
          <Label htmlFor="api-key-name">Key name</Label>
          <Input
            id="api-key-name"
            value={name}
            maxLength={60}
            required
            placeholder="For example, Claude Code on my laptop"
            onChange={(event) => setName(event.target.value)}
          />
        </div>
        <Button type="submit" loading={pending} disabled={pending || name.trim() === ""}>
          Create key
        </Button>
      </form>

      {created ? (
        <div className="space-y-2 rounded-lg border border-amber-200 bg-amber-50 p-4" data-testid="api-key-secret">
          <p className="text-sm font-medium text-ink-900">Copy this key now. We store only a fingerprint of it, so it will not be shown again.</p>
          <code className="block break-all rounded bg-white px-3 py-2 text-sm text-ink-900">{created}</code>
          <div className="flex gap-3">
            <Button type="button" size="sm" variant="outline" onClick={copy}>
              {copied ? "Copied" : "Copy key"}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setCreated(null)}>
              I saved it
            </Button>
          </div>
        </div>
      ) : null}

      {notice ? (
        <p className={cn("text-sm", notice.ok ? "text-emerald-700" : "text-amber-700")} data-testid="api-key-notice">
          {notice.text}
        </p>
      ) : null}

      {keys.length === 0 ? (
        <p className="text-sm text-ink-500">No keys yet.</p>
      ) : (
        <ul className="divide-y divide-ink-100" data-testid="api-key-list">
          {keys.map((key) => (
            <li key={key.id} className="flex flex-wrap items-center justify-between gap-3 py-3" data-testid="api-key-row">
              <div className="min-w-0">
                <p className="text-sm font-medium text-ink-900">{key.name}</p>
                <p className="mt-0.5 text-xs text-ink-500">
                  <code>{key.prefix}</code> made {when(key.createdAt)}, last used {when(key.lastUsedAt)}
                </p>
              </div>
              {key.revokedAt ? (
                <Badge variant="outline">Revoked</Badge>
              ) : (
                <Button type="button" size="sm" variant="outline" disabled={pending} onClick={() => revoke(key.id)}>
                  Revoke
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
