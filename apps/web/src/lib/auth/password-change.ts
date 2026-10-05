import { AUTH_NETWORK_ERROR, isNetworkAuthError, runAuthCall } from "@/lib/auth-call";
import { authFailureMessage } from "@/lib/auth-errors";

interface AuthError {
  code?: string;
  name?: string;
  status?: number;
}

/** The browser SDK verifies getClaims; no URL flag or decoded cookie is trusted. */
export interface PasswordAuth {
  getUser(): Promise<{ data: { user: { id: string } | null }; error: AuthError | null }>;
  getClaims(): Promise<{ data: { claims: { sub: string; session_id?: unknown; amr?: unknown } } | null; error: AuthError | null }>;
  updateUser(attributes: { password: string; current_password?: string; nonce?: string }): Promise<{ error: AuthError | null }>;
  reauthenticate(): Promise<{ error: AuthError | null }>;
}

export interface PasswordSession {
  userId: string;
  sessionId: string;
  recovery: boolean;
}

type Failure = { kind: "error"; message: string; errorKind: "network" | "rejected" };
export type PasswordSessionResult = { kind: "ready"; session: PasswordSession } | { kind: "signedout" } | Failure;
export type PasswordChangeResult =
  | { kind: "success" }
  | { kind: "cancelled" }
  | { kind: "changed"; session: PasswordSession }
  | { kind: "signedout" }
  | (Failure & { required?: "current_password" | "nonce" });

function sessionFailure(error: AuthError): Failure | { kind: "signedout" } {
  if (isNetworkAuthError(error)) return { kind: "error", message: AUTH_NETWORK_ERROR, errorKind: "network" };
  if (error.name === "AuthSessionMissingError" || error.code === "session_not_found" || error.code === "session_expired") {
    return { kind: "signedout" };
  }
  return { kind: "error", message: authFailureMessage(error.code), errorKind: "rejected" };
}

export async function loadPasswordSession(auth: PasswordAuth): Promise<PasswordSessionResult> {
  try {
    const user = await auth.getUser();
    if (user.error) return sessionFailure(user.error);
    if (!user.data.user) return { kind: "signedout" };
    const verified = await auth.getClaims();
    if (verified.error) return sessionFailure(verified.error);
    const claims = verified.data?.claims;
    if (!claims || claims.sub !== user.data.user.id || typeof claims.session_id !== "string" || !claims.session_id) {
      return { kind: "signedout" };
    }
    const recovery = Array.isArray(claims.amr) && claims.amr.some((entry: unknown) =>
      entry === "recovery" || (typeof entry === "object" && entry !== null && "method" in entry && entry.method === "recovery"),
    );
    return { kind: "ready", session: { userId: claims.sub, sessionId: claims.session_id, recovery } };
  } catch {
    return { kind: "error", message: AUTH_NETWORK_ERROR, errorKind: "network" };
  }
}

async function checkSession(auth: PasswordAuth, expected: PasswordSession) {
  const current = await loadPasswordSession(auth);
  if (current.kind !== "ready") return current;
  const latest = current.session;
  return latest.userId === expected.userId && latest.sessionId === expected.sessionId && latest.recovery === expected.recovery
    ? current
    : { kind: "changed" as const, session: latest };
}

/** Check again before sending credentials; the provider remains the authority. */
export async function changePassword(
  auth: PasswordAuth,
  expected: PasswordSession,
  input: { password: string; currentPassword: string; nonce: string },
  isCurrent: () => boolean = () => true,
): Promise<PasswordChangeResult> {
  const session = await checkSession(auth, expected);
  if (!isCurrent()) return { kind: "cancelled" };
  if (session.kind !== "ready") return session;
  let required: "current_password" | "nonce" | undefined;
  const result = await runAuthCall(async () => {
    const response = await auth.updateUser({
      password: input.password,
      ...(input.currentPassword ? { current_password: input.currentPassword } : {}),
      ...(input.nonce.trim() ? { nonce: input.nonce.trim() } : {}),
    });
    if (response.error?.code === "current_password_required" || response.error?.code === "current_password_mismatch") required = "current_password";
    if (response.error?.code === "reauthentication_needed" || response.error?.code === "reauthentication_not_valid") required = "nonce";
    return response;
  });
  return result.ok ? { kind: "success" } : { kind: "error", message: result.message, errorKind: result.kind, required };
}

export async function sendPasswordCode(auth: PasswordAuth, expected: PasswordSession, isCurrent: () => boolean = () => true): Promise<PasswordChangeResult> {
  const session = await checkSession(auth, expected);
  if (!isCurrent()) return { kind: "cancelled" };
  if (session.kind !== "ready") return session;
  const result = await runAuthCall(() => auth.reauthenticate());
  return result.ok ? { kind: "success" } : { kind: "error", message: result.message, errorKind: result.kind };
}
