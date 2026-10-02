"use client";

import { useActionState } from "react";
import { Button } from "@curvi/ui";
import { consentAction } from "@/app/oauth/consent/actions";
import type { ConsentActionState } from "@/lib/mcp-auth/consent";
import { CONSENT_COPY } from "@/lib/mcp-auth/consent-copy";

export interface ConsentFormProps {
  authorizationId: string;
  /** The consented path's link back to the client; the server checks it. */
  redirectUrl: string | null;
  workspaces: Array<{ id: string; name: string }>;
  defaultWorkspaceId: string;
  currentWorkspaceName: string | null;
}

const INITIAL: ConsentActionState = { notice: null, done: false };

/** The workspace picker (when there is more than one) and Connect and
 * Cancel. The server decides; a finished request leaves only its notice. */
export function ConsentForm({ authorizationId, redirectUrl, workspaces, defaultWorkspaceId, currentWorkspaceName }: ConsentFormProps) {
  const [state, action, pending] = useActionState(consentAction, INITIAL);

  if (state.done && state.notice) {
    return (
      <p role="status" className="text-sm text-ink-900" data-testid="consent-notice">
        {state.notice}
      </p>
    );
  }

  return (
    <form action={action} className="space-y-5" data-testid="consent-form">
      <input type="hidden" name="authorization_id" value={authorizationId} />
      {redirectUrl ? <input type="hidden" name="redirect_url" value={redirectUrl} /> : null}
      {workspaces.length > 1 ? (
        <fieldset className="space-y-2" data-testid="consent-picker">
          <legend className="text-sm font-medium text-ink-900">{CONSENT_COPY.pickerLabel}</legend>
          {currentWorkspaceName ? (
            <p className="text-xs text-ink-500" data-testid="consent-current-workspace">
              {CONSENT_COPY.currentWorkspace(currentWorkspaceName)}
            </p>
          ) : null}
          {workspaces.map((workspace) => (
            <label
              key={workspace.id}
              className="flex cursor-pointer items-center gap-3 rounded-lg border border-ink-100 px-3 py-2 text-sm text-ink-900 hover:bg-ink-50"
            >
              <input type="radio" name="workspace_id" value={workspace.id} defaultChecked={workspace.id === defaultWorkspaceId} />
              <span>{workspace.name}</span>
            </label>
          ))}
        </fieldset>
      ) : (
        <input type="hidden" name="workspace_id" value={defaultWorkspaceId} />
      )}
      {state.notice ? (
        <p role="alert" className="text-sm text-amber-700" data-testid="consent-notice">
          {state.notice}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-3">
        <Button type="submit" name="decision" value="connect" variant="secondary" disabled={pending} data-testid="consent-connect">
          {pending ? CONSENT_COPY.connecting : CONSENT_COPY.connect}
        </Button>
        <Button type="submit" name="decision" value="cancel" variant="ghost" disabled={pending} data-testid="consent-cancel">
          {CONSENT_COPY.cancel}
        </Button>
      </div>
    </form>
  );
}
