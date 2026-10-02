"use client";

import { useState, useTransition } from "react";
import { Button, cn } from "@curvi/ui";
import { disconnectConnectionAction } from "@/app/app/settings/connections/actions";
import type { ConnectedAppView } from "@/lib/mcp-auth/connected-apps";
import { CONNECTED_APPS_COPY } from "@/lib/mcp-auth/consent-copy";

function day(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
}

/** The live assistant connections and their Disconnect buttons. */
export function ConnectedAppsPanel({ initialApps }: { initialApps: ConnectedAppView[] }) {
  const [apps, setApps] = useState(initialApps);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, startTransition] = useTransition();

  function disconnect(id: string) {
    startTransition(async () => {
      const result = await disconnectConnectionAction(id);
      setNotice({ ok: result.ok, text: result.notice });
      if (result.ok) {
        setApps((current) => current.filter((app) => app.id !== id));
      }
    });
  }

  return (
    <div className="space-y-4">
      {notice ? (
        <p role="status" className={cn("text-sm", notice.ok ? "text-emerald-700" : "text-amber-700")} data-testid="connections-notice">
          {notice.text}
        </p>
      ) : null}
      {apps.length === 0 ? (
        <p className="text-sm text-ink-500" data-testid="connections-empty">
          {CONNECTED_APPS_COPY.empty}
        </p>
      ) : (
        <ul className="divide-y divide-ink-100" data-testid="connections-list">
          {apps.map((app) => (
            <li
              key={app.id}
              className="flex flex-wrap items-center justify-between gap-3 py-3"
              data-testid="connection-row"
              data-own={app.own ? "true" : "false"}
            >
              <div className="min-w-0 space-y-0.5">
                <p className="text-sm font-medium text-ink-900">{app.clientName}</p>
                <p className="text-sm text-ink-700">{CONNECTED_APPS_COPY.row(app.workspaceName)}</p>
                <p className="text-xs text-ink-500">
                  {app.memberLabel ? `${CONNECTED_APPS_COPY.connectedBy(app.memberLabel)} ` : ""}
                  {CONNECTED_APPS_COPY.connectedOn(day(app.connectedAt))}{" "}
                  {app.lastUsedAt ? CONNECTED_APPS_COPY.lastUsed(day(app.lastUsedAt)) : CONNECTED_APPS_COPY.notUsed}
                </p>
              </div>
              <Button type="button" size="sm" variant="outline" disabled={pending} onClick={() => disconnect(app.id)}>
                {CONNECTED_APPS_COPY.disconnect}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
