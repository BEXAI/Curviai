/**
 * The consent page's decisions (docs/phases/PHASE_19.md, P19-09, "Consent
 * page" and "Workspace scoping"), over a ConsentBackend so the same logic
 * runs on Supabase and in the demo.
 *
 * Both answer the unavailable line, and touch nothing, while the kill switch
 * MCP_OAUTH_ENABLED is off (ConsentBackend.signInEnabled).
 *
 * Page (loadConsent):
 * 1. Signed out: the sign in and sign up form, coming back to this page.
 * 2. Signed in: Supabase's authorization details. On the fresh path the
 *    client id comes from them. On the consented path Supabase answers only
 *    redirect_url (the user consented before), and the client id is read
 *    from auth.oauth_authorizations; the link is not followed yet.
 * 3. A client that is not allowlisted: the fresh request is denied, the
 *    consented link is never followed, and the page says nothing was shared.
 *    This runs before any redirect.
 * 4. Consented path with a live connection for (user, client) in a
 *    workspace the user still belongs to: follow redirect_url. Otherwise
 *    the page: the requested scopes in plain words and, with more than one
 *    workspace, the picker (default: the live row's workspace, else the one
 *    used most recently through an assistant, else the oldest membership).
 *
 * Action (decideConsent):
 * 5. Connect: the membership for the posted workspace is read again and a
 *    workspace that is not the user's is refused; the row is written
 *    (connections.connect, which keeps the user's profile_id); then the
 *    fresh request is approved, or the consented link (checked against the
 *    client's registered redirect URI, so a posted URL can never send the
 *    browser anywhere else) is followed.
 * 6. Cancel: the fresh request is denied and the browser goes back to the
 *    client; on the consented path nothing is followed and the page says
 *    nothing was shared.
 */

import { CONSENT_PATH } from "@/lib/verification";
import type { McpConnectionRecord } from "./connections";
import {
  parseAuthorizationId,
  type ConsentBackend,
  type ConsentMembership,
  type ConsentUser,
  type StoredAuthorization,
} from "./consent-backend";
import { CONSENT_COPY, SCOPE_LINES, SCOPES_CURVI_USES } from "./consent-copy";

/** The consent page's path for an authorization request. switched marks a
 * visit after "Use another account" (see loadConsent). */
export function consentPath(authorizationId: string, options: { switched?: boolean } = {}): string {
  return `${CONSENT_PATH}?authorization_id=${encodeURIComponent(authorizationId)}${options.switched ? "&switched=1" : ""}`;
}

export interface ScopeLine {
  scope: string;
  text: string;
}

/** Every requested scope in plain words, known scopes in a fixed order,
 * then any other scope by name, and whether any goes beyond what Curvi
 * uses (openid and email). */
export function scopeLines(scopes: readonly string[]): { lines: ScopeLine[]; extra: boolean } {
  const unique = [...new Set(scopes)];
  const known = Object.keys(SCOPE_LINES).filter((scope) => unique.includes(scope));
  const other = unique.filter((scope) => !Object.hasOwn(SCOPE_LINES, scope));
  const lines = [
    ...known.map((scope) => ({ scope, text: SCOPE_LINES[scope] as string })),
    ...other.map((scope) => ({ scope, text: CONSENT_COPY.unknownScope(scope) })),
  ];
  return { lines, extra: unique.some((scope) => !SCOPES_CURVI_USES.includes(scope)) };
}

function usedAt(row: McpConnectionRecord): number {
  return Math.max(row.createdAt.getTime(), row.lastUsedAt?.getTime() ?? 0);
}

/** The picker's default: the live row's workspace, else the workspace used
 * most recently through any assistant connection, else the oldest
 * membership. Only a workspace the user belongs to today qualifies. */
export function defaultWorkspaceId(
  memberships: readonly ConsentMembership[],
  liveWorkspaceId: string | null,
  history: readonly McpConnectionRecord[],
): string | null {
  const ids = new Set(memberships.map((m) => m.workspaceId));
  if (liveWorkspaceId && ids.has(liveWorkspaceId)) {
    return liveWorkspaceId;
  }
  const recent = [...history].filter((row) => ids.has(row.workspaceId)).sort((a, b) => usedAt(b) - usedAt(a))[0];
  if (recent) {
    return recent.workspaceId;
  }
  const oldest = [...memberships].sort((a, b) => a.joinedAt.getTime() - b.joinedAt.getTime())[0];
  return oldest?.workspaceId ?? null;
}

/** True when the link goes to the client's registered redirect URI: same
 * origin and path, https (or http on a loopback host), no fragment. */
export function redirectMatches(redirectUrl: string, redirectUri: string): boolean {
  let target: URL;
  let registered: URL;
  try {
    target = new URL(redirectUrl);
    registered = new URL(redirectUri);
  } catch {
    return false;
  }
  const loopback = target.hostname === "localhost" || target.hostname === "127.0.0.1";
  if (target.protocol !== "https:" && !(target.protocol === "http:" && loopback)) {
    return false;
  }
  return (
    target.hash === "" &&
    target.username === "" &&
    target.password === "" &&
    target.origin === registered.origin &&
    target.pathname === registered.pathname
  );
}

function allowed(backend: ConsentBackend, clientId: string): boolean {
  return backend.allowedClientIds().includes(clientId);
}

export type ConsentMessage =
  | "expired"
  | "switchedAccount"
  | "unavailable"
  | "unknownClient"
  | "noWorkspace"
  | "nothingShared";

export interface ConsentScreen {
  kind: "consent";
  authorizationId: string;
  /** fresh: approve or deny through Supabase; consented: follow the link. */
  path: "fresh" | "consented";
  /** The consented path's link, posted back with the form and checked. */
  redirectUrl: string | null;
  email: string | null;
  scopes: ScopeLine[];
  extraScopes: boolean;
  workspaces: Array<{ id: string; name: string }>;
  defaultWorkspaceId: string;
  /** With a live row and a picker: the workspace ChatGPT uses now. */
  currentWorkspaceName: string | null;
}

export type ConsentView =
  | { kind: "signed_out"; authorizationId: string; switched?: true }
  | { kind: "message"; message: ConsentMessage }
  | { kind: "redirect"; url: string }
  | ConsentScreen;

async function screen(
  backend: ConsentBackend,
  user: ConsentUser,
  authorizationId: string,
  clientId: string,
  scopes: readonly string[],
  consented: { redirectUrl: string } | null,
): Promise<ConsentView> {
  const [memberships, live, history] = await Promise.all([
    backend.listMemberships(user.id),
    backend.connections.findLive(user.id, clientId),
    backend.connections.listForUser(user.id),
  ]);
  const liveWorkspace = live ? (memberships.find((m) => m.workspaceId === live.workspaceId) ?? null) : null;
  const chosen = defaultWorkspaceId(memberships, liveWorkspace?.workspaceId ?? null, history);
  if (!chosen) {
    return { kind: "message", message: "noWorkspace" };
  }
  const { lines, extra } = scopeLines(scopes);
  return {
    kind: "consent",
    authorizationId,
    path: consented ? "consented" : "fresh",
    redirectUrl: consented?.redirectUrl ?? null,
    email: user.email,
    scopes: lines,
    extraScopes: extra,
    workspaces: memberships.map((m) => ({ id: m.workspaceId, name: m.workspaceName })),
    defaultWorkspaceId: chosen,
    currentWorkspaceName: memberships.length > 1 && liveWorkspace ? liveWorkspace.workspaceName : null,
  };
}

/**
 * What the consent page shows for this request. switched: the visit comes
 * after "Use another account". Supabase binds a request to the first user
 * who opens it (docs/verification.md, p19/consent, authorize.go), so the
 * next account always finds it gone; the page then says to press Connect in
 * ChatGPT again rather than that the request expired.
 */
export async function loadConsent(
  backend: ConsentBackend,
  rawAuthorizationId: unknown,
  options: { headers?: Headers; switched?: boolean } = {},
): Promise<ConsentView> {
  // The kill switch (MCP_OAUTH_ENABLED off): no new connection is made, and
  // Supabase is not asked about the request.
  if (!backend.signInEnabled()) {
    return { kind: "message", message: "unavailable" };
  }
  const authorizationId = parseAuthorizationId(rawAuthorizationId);
  if (!authorizationId) {
    return { kind: "message", message: "expired" };
  }
  const signedOut: ConsentView = { kind: "signed_out", authorizationId, ...(options.switched ? { switched: true as const } : {}) };
  const user = await backend.currentUser();
  if (!user) {
    return signedOut;
  }
  await backend.prepareUser(user, options.headers ?? new Headers());

  const lookup = await backend.getAuthorization(authorizationId);
  switch (lookup.kind) {
    case "signed_out":
      return signedOut;
    case "expired":
      return { kind: "message", message: options.switched ? "switchedAccount" : "expired" };
    case "unavailable":
      return { kind: "message", message: lookup.kind };
    case "details": {
      if (!allowed(backend, lookup.clientId)) {
        // Tell the client no, but never send the browser to it.
        await backend.deny(authorizationId);
        return { kind: "message", message: "unknownClient" };
      }
      return screen(backend, user, authorizationId, lookup.clientId, lookup.scopes, null);
    }
    case "consented": {
      const stored = await backend.storedAuthorization(authorizationId, user.id);
      if (stored === "unavailable" || (stored && !redirectMatches(lookup.redirectUrl, stored.redirectUri))) {
        return { kind: "message", message: "unavailable" };
      }
      if (!stored) {
        return { kind: "message", message: "expired" };
      }
      if (!allowed(backend, stored.clientId)) {
        return { kind: "message", message: "unknownClient" };
      }
      const live = await backend.connections.findLive(user.id, stored.clientId);
      if (live && (await backend.role(user.id, live.workspaceId))) {
        return { kind: "redirect", url: lookup.redirectUrl };
      }
      return screen(backend, user, authorizationId, stored.clientId, stored.scopes, { redirectUrl: lookup.redirectUrl });
    }
  }
}

export interface ConsentInput {
  authorizationId: unknown;
  decision: unknown;
  workspaceId?: unknown;
  /** Only on the consented path. */
  redirectUrl?: unknown;
}

export type ConsentOutcome =
  | { kind: "redirect"; url: string }
  /** done: the request is over and the form gives way to the text. */
  | { kind: "notice"; text: string; done: boolean };

/** The consent form's state between submissions (app/oauth/consent). */
export interface ConsentActionState {
  notice: string | null;
  done: boolean;
}

function done(message: ConsentMessage): ConsentOutcome {
  return { kind: "notice", text: CONSENT_COPY[message], done: true };
}

/** The workspace to bind, read again from the memberships, or a refusal. */
async function workspaceFor(
  backend: ConsentBackend,
  user: ConsentUser,
  posted: unknown,
): Promise<{ ok: true; workspaceId: string } | { ok: false; outcome: ConsentOutcome }> {
  const memberships = await backend.listMemberships(user.id);
  if (memberships.length === 0) {
    return { ok: false, outcome: done("noWorkspace") };
  }
  if (typeof posted !== "string" || posted === "") {
    return memberships.length === 1 && memberships[0]
      ? { ok: true, workspaceId: memberships[0].workspaceId }
      : { ok: false, outcome: { kind: "notice", text: CONSENT_COPY.pickWorkspace, done: false } };
  }
  const seat = memberships.find((m) => m.workspaceId === posted);
  return seat
    ? { ok: true, workspaceId: seat.workspaceId }
    : { ok: false, outcome: { kind: "notice", text: CONSENT_COPY.notYourWorkspace, done: false } };
}

async function connectRow(
  backend: ConsentBackend,
  user: ConsentUser,
  clientId: string,
  clientName: string | null,
  workspaceId: string,
  now: Date,
): Promise<void> {
  await backend.connections.connect({ userId: user.id, oauthClientId: clientId, clientName, workspaceId }, now);
}

/** The consented path: the link Supabase gave the page, checked against the
 * stored authorization before anything is written or followed. */
async function decideConsented(
  backend: ConsentBackend,
  user: ConsentUser,
  authorizationId: string,
  input: ConsentInput,
  redirectUrl: string,
  now: Date,
): Promise<ConsentOutcome> {
  const stored: StoredAuthorization | null | "unavailable" = await backend.storedAuthorization(authorizationId, user.id);
  if (stored === "unavailable") {
    return done("unavailable");
  }
  if (!stored || !redirectMatches(redirectUrl, stored.redirectUri)) {
    return done("expired");
  }
  if (!allowed(backend, stored.clientId)) {
    return done("unknownClient");
  }
  if (input.decision !== "connect") {
    return done("nothingShared");
  }
  const workspace = await workspaceFor(backend, user, input.workspaceId);
  if (!workspace.ok) {
    return workspace.outcome;
  }
  await connectRow(backend, user, stored.clientId, stored.clientName, workspace.workspaceId, now);
  return { kind: "redirect", url: redirectUrl };
}

/** Connect or Cancel on the consent page. */
export async function decideConsent(backend: ConsentBackend, input: ConsentInput, now: Date = new Date()): Promise<ConsentOutcome> {
  // The kill switch: nothing is approved, followed or written while it is off.
  if (!backend.signInEnabled()) {
    return done("unavailable");
  }
  const authorizationId = parseAuthorizationId(input.authorizationId);
  if (!authorizationId) {
    return done("expired");
  }
  const user = await backend.currentUser();
  if (!user) {
    return { kind: "redirect", url: consentPath(authorizationId) };
  }
  if (typeof input.redirectUrl === "string" && input.redirectUrl !== "") {
    return decideConsented(backend, user, authorizationId, input, input.redirectUrl, now);
  }

  const lookup = await backend.getAuthorization(authorizationId);
  switch (lookup.kind) {
    case "signed_out":
      return { kind: "redirect", url: consentPath(authorizationId) };
    case "expired":
    case "unavailable":
      return done(lookup.kind);
    case "consented":
      // Consent landed elsewhere since the page loaded, so Supabase approved
      // at once: the consented path with the link it just gave.
      return decideConsented(backend, user, authorizationId, input, lookup.redirectUrl, now);
    case "details": {
      if (!allowed(backend, lookup.clientId)) {
        await backend.deny(authorizationId);
        return done("unknownClient");
      }
      if (input.decision !== "connect") {
        const denied = await backend.deny(authorizationId);
        return denied.ok ? { kind: "redirect", url: denied.redirectUrl } : done("nothingShared");
      }
      const workspace = await workspaceFor(backend, user, input.workspaceId);
      if (!workspace.ok) {
        return workspace.outcome;
      }
      // The row first: a token Supabase issues after approval must find it.
      await connectRow(backend, user, lookup.clientId, lookup.clientName, workspace.workspaceId, now);
      const approved = await backend.approve(authorizationId);
      if (approved.ok) {
        return { kind: "redirect", url: approved.redirectUrl };
      }
      return approved.reason === "signed_out"
        ? { kind: "redirect", url: consentPath(authorizationId) }
        : done(approved.reason);
    }
  }
}
