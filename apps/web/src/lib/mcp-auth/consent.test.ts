import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rule9Problems } from "@curvi/pipeline";
import { MCP_BANNED_WORDS } from "@/lib/api-v1/mcp-copy";
import { DEMO_OWNER_ID } from "@/lib/api-keys/backend";
import { DEMO_WORKSPACE_ID } from "@/lib/services/demo";
import { DemoModeRefusedError } from "@/lib/services/demo-mode";
import { demoMcpConnectionStore } from "./backend";
import { MemoryMcpConnectionStore, type McpConnectionRecord } from "./connections";
import {
  DEMO_AUTHORIZATION_IDS,
  DEMO_CONSENT_CLIENT_ID,
  DEMO_CONSENT_REDIRECT_URI,
  DEMO_SECOND_WORKSPACE_ID,
  DEMO_TEAMMATE_ID,
  MemoryConsentBackend,
  demoConsentBackend,
  demoConsentPerson,
  getConsentBackend,
  parseAuthorizationId,
  type MemoryAuthorization,
  type MemoryConsentBackendOptions,
  type MemoryConsentSeat,
} from "./consent-backend";
import { CONNECTED_APPS_COPY, CONSENT_COPY, SCOPE_LINES } from "./consent-copy";
import { consentPath, decideConsent, defaultWorkspaceId, loadConsent, redirectMatches, scopeLines, type ConsentScreen } from "./consent";

// The consent page (docs/phases/PHASE_19.md, P19-09, "Consent page"): the
// fresh and consented paths, the client allowlist before any redirect, the
// row written before the approval, the picker and its default, and the
// membership read again on Connect.

const USER = { id: "00000000-0000-4000-8000-0000000000a1", email: "seller@example.com" };
const OTHER_USER = "00000000-0000-4000-8000-0000000000a2";
const CLIENT = "11111111-2222-4333-8444-555555555555";
const OTHER_CLIENT = "99999999-2222-4333-8444-555555555555";
const WS_A = "00000000-0000-4000-8000-00000000aaaa";
const WS_B = "00000000-0000-4000-8000-00000000bbbb";
const WS_FOREIGN = "00000000-0000-4000-8000-00000000ffff";
const REDIRECT_URI = "https://chatgpt.com/connector/oauth/cb123";
const AUTH_ID = "AbCdEfGhIjKlMnOpQrStUvWxYz012345";
const NOW = new Date("2026-10-01T12:00:00.000Z");

function seat(workspaceId: string, joined: string, overrides: Partial<MemoryConsentSeat> = {}): MemoryConsentSeat {
  return {
    userId: USER.id,
    workspaceId,
    workspaceName: workspaceId === WS_A ? "Shop A" : workspaceId === WS_B ? "Shop B" : "Elsewhere",
    role: "owner",
    joinedAt: new Date(joined),
    ...overrides,
  };
}

function request(overrides: Partial<MemoryAuthorization> = {}): MemoryAuthorization {
  return {
    id: AUTH_ID,
    clientId: CLIENT,
    clientName: "ChatGPT",
    scopes: ["openid", "email"],
    redirectUri: REDIRECT_URI,
    state: "pending",
    ...overrides,
  };
}

function row(overrides: Partial<McpConnectionRecord> = {}): McpConnectionRecord {
  return {
    id: "00000000-0000-4000-8000-0000000c0001",
    workspaceId: WS_A,
    userId: USER.id,
    oauthClientId: CLIENT,
    clientName: "ChatGPT",
    profileId: "ProfileIdProfileId0001",
    createdAt: new Date("2026-09-01T00:00:00.000Z"),
    lastUsedAt: null,
    revokedAt: null,
    ...overrides,
  };
}

let store: MemoryMcpConnectionStore;

function backend(overrides: Partial<MemoryConsentBackendOptions> = {}): MemoryConsentBackend {
  return new MemoryConsentBackend({
    user: USER,
    seats: [seat(WS_A, "2026-01-01T00:00:00.000Z")],
    authorizations: [request()],
    connections: store,
    clientIds: [CLIENT],
    ...overrides,
  });
}

function asScreen(view: Awaited<ReturnType<typeof loadConsent>>): ConsentScreen {
  expect(view.kind).toBe("consent");
  return view as ConsentScreen;
}

beforeEach(() => {
  store = new MemoryMcpConnectionStore();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("loadConsent: who and which request", () => {
  it("shows the sign in form to a signed out visitor, coming back to the same request", async () => {
    const b = backend({ user: null });
    expect(await loadConsent(b, AUTH_ID)).toEqual({ kind: "signed_out", authorizationId: AUTH_ID });
    expect(consentPath(AUTH_ID)).toBe(`/oauth/consent?authorization_id=${AUTH_ID}`);
    expect(b.calls.prepared).toEqual([]);
  });

  it("refuses an id that is not a Supabase authorization id before calling anyone", async () => {
    for (const raw of ["../../admin/users", "a/b", "a?b=c", "", undefined, ["x"], "x".repeat(129), "a b"]) {
      const b = backend();
      const spy = vi.spyOn(b, "getAuthorization");
      expect(await loadConsent(b, raw), String(raw)).toEqual({ kind: "message", message: "expired" });
      expect(spy).not.toHaveBeenCalled();
    }
    expect(parseAuthorizationId(AUTH_ID)).toBe(AUTH_ID);
  });

  it("shows the expiry copy for an unknown or used request", async () => {
    expect(await loadConsent(backend(), "UnknownRequest0000000000000000000")).toEqual({ kind: "message", message: "expired" });
    const used = backend({ authorizations: [request({ state: "approved" })] });
    expect(await loadConsent(used, AUTH_ID)).toEqual({ kind: "message", message: "expired" });
    expect(CONSENT_COPY.expired).toBe("This connection request expired. Go back to ChatGPT and press Connect again.");
  });

  it("prepares a signed in user first (first workspace, signup grant, terms record)", async () => {
    const b = backend();
    await loadConsent(b, AUTH_ID);
    expect(b.calls.prepared).toEqual([USER.id]);
  });

  it("a request another user opened first reads as expired", async () => {
    const b = backend({ authorizations: [request({ userId: OTHER_USER })] });
    expect(await loadConsent(b, AUTH_ID)).toEqual({ kind: "message", message: "expired" });
  });

  it("after Use another account, says to press Connect again instead of that the request expired", async () => {
    // Supabase bound the request to the first account when the page opened.
    const b = backend({ authorizations: [request({ userId: OTHER_USER })] });
    expect(await loadConsent(b, AUTH_ID, { switched: true })).toEqual({ kind: "message", message: "switchedAccount" });
    expect(CONSENT_COPY.switchedAccount).toBe(
      "You switched accounts, so this connection request ended. Go back to ChatGPT and press Connect again to connect this account.",
    );
    // Signed out after the switch, the sign in form keeps the mark.
    expect(await loadConsent(backend({ user: null }), AUTH_ID, { switched: true })).toEqual({
      kind: "signed_out",
      authorizationId: AUTH_ID,
      switched: true,
    });
    expect(consentPath(AUTH_ID, { switched: true })).toBe(`/oauth/consent?authorization_id=${AUTH_ID}&switched=1`);
    // A request that is still the user's is shown as usual.
    expect((await loadConsent(backend(), AUTH_ID, { switched: true })).kind).toBe("consent");
  });
});

describe("loadConsent: the fresh path", () => {
  it("shows the page with the signed in email, the scopes and no picker for one workspace", async () => {
    const view = asScreen(await loadConsent(backend(), AUTH_ID));
    expect(view).toMatchObject({
      path: "fresh",
      redirectUrl: null,
      email: USER.email,
      extraScopes: false,
      workspaces: [{ id: WS_A, name: "Shop A" }],
      defaultWorkspaceId: WS_A,
      currentWorkspaceName: null,
    });
    expect(view.scopes).toEqual([
      { scope: "openid", text: "A private id for your Curvi account" },
      { scope: "email", text: "Your email address" },
    ]);
  });

  it("renders every requested scope in plain words and notes the ones Curvi does not use", async () => {
    const b = backend({ authorizations: [request({ scopes: ["openid", "email", "profile", "phone", "offline_access"] })] });
    const view = asScreen(await loadConsent(b, AUTH_ID));
    expect(view.scopes.map((line) => line.text)).toEqual([
      "A private id for your Curvi account",
      "Your email address",
      "Your name and picture, if your account has them",
      "Your phone number, if your account has one",
      "Access that stays on until you disconnect",
    ]);
    expect(view.extraScopes).toBe(true);
  });

  it("denies a client that is not allowlisted, follows nothing and says nothing was shared", async () => {
    const b = backend({ authorizations: [request({ clientId: OTHER_CLIENT })] });
    expect(await loadConsent(b, AUTH_ID)).toEqual({ kind: "message", message: "unknownClient" });
    expect(b.calls.denied).toEqual([AUTH_ID]);
    expect(b.calls.approved).toEqual([]);
    expect(store.rows).toEqual([]);
    expect(CONSENT_COPY.unknownClient).toBe("Curvi does not work with this app yet, so nothing was shared.");
  });

  it("says so when the account has no workspace", async () => {
    expect(await loadConsent(backend({ seats: [] }), AUTH_ID)).toEqual({ kind: "message", message: "noWorkspace" });
  });
});

describe("the workspace picker", () => {
  const twoSeats = [seat(WS_A, "2026-01-01T00:00:00.000Z"), seat(WS_B, "2026-02-01T00:00:00.000Z")];

  it("defaults to the oldest membership when nothing was used", async () => {
    const view = asScreen(await loadConsent(backend({ seats: twoSeats }), AUTH_ID));
    expect(view.workspaces.map((w) => w.id)).toEqual([WS_A, WS_B]);
    expect(view.defaultWorkspaceId).toBe(WS_A);
    expect(view.currentWorkspaceName).toBeNull();
  });

  it("defaults to the workspace used most recently through an assistant", async () => {
    store = new MemoryMcpConnectionStore([
      row({ id: "00000000-0000-4000-8000-0000000c0001", workspaceId: WS_A, revokedAt: new Date("2026-09-10T00:00:00.000Z"), lastUsedAt: new Date("2026-09-05T00:00:00.000Z") }),
      row({ id: "00000000-0000-4000-8000-0000000c0002", workspaceId: WS_B, oauthClientId: OTHER_CLIENT, lastUsedAt: new Date("2026-09-20T00:00:00.000Z") }),
    ]);
    const view = asScreen(await loadConsent(backend({ seats: twoSeats }), AUTH_ID));
    expect(view.defaultWorkspaceId).toBe(WS_B);
  });

  it("defaults to the live row's workspace and says ChatGPT uses it now", async () => {
    store = new MemoryMcpConnectionStore([row({ workspaceId: WS_B })]);
    const view = asScreen(await loadConsent(backend({ seats: twoSeats }), AUTH_ID));
    expect(view.defaultWorkspaceId).toBe(WS_B);
    expect(view.currentWorkspaceName).toBe("Shop B");
    expect(CONSENT_COPY.currentWorkspace("Shop B")).toBe(
      "ChatGPT now uses Shop B. Picking another moves every ChatGPT and Codex connection on your account to it.",
    );
  });

  it("never defaults to a workspace the user left", () => {
    const seats = [seat(WS_A, "2026-02-01T00:00:00.000Z"), seat(WS_B, "2026-01-01T00:00:00.000Z")];
    const history = [row({ workspaceId: WS_FOREIGN, lastUsedAt: new Date("2026-09-30T00:00:00.000Z") })];
    expect(defaultWorkspaceId(seats, WS_FOREIGN, history)).toBe(WS_B);
    expect(defaultWorkspaceId([], null, [])).toBeNull();
  });
});

describe("the kill switch (MCP_OAUTH_ENABLED off)", () => {
  it("the page shows the unavailable line and asks Supabase nothing", async () => {
    const b = backend({ signInEnabled: false });
    const lookup = vi.spyOn(b, "getAuthorization");
    expect(await loadConsent(b, AUTH_ID)).toEqual({ kind: "message", message: "unavailable" });
    expect(lookup).not.toHaveBeenCalled();
    expect(b.calls.prepared).toEqual([]);
  });

  it("Connect approves nothing, follows nothing and writes no row, on both paths", async () => {
    const b = backend({ signInEnabled: false });
    const fresh = await decideConsent(b, { authorizationId: AUTH_ID, decision: "connect", workspaceId: WS_A }, NOW);
    expect(fresh).toEqual({ kind: "notice", text: CONSENT_COPY.unavailable, done: true });
    const consented = await decideConsent(
      b,
      { authorizationId: AUTH_ID, decision: "connect", workspaceId: WS_A, redirectUrl: `${REDIRECT_URI}?code=x` },
      NOW,
    );
    expect(consented).toEqual({ kind: "notice", text: CONSENT_COPY.unavailable, done: true });
    expect(b.calls.approved).toEqual([]);
    expect(b.calls.denied).toEqual([]);
    expect(await store.findLive(USER.id, CLIENT)).toBeNull();
  });

  it("the demo stays on whatever the switch says (it never runs in production)", () => {
    vi.stubEnv("MCP_OAUTH_ENABLED", "0");
    expect(demoConsentBackend("owner").signInEnabled()).toBe(true);
  });
});

describe("decideConsent: the fresh path", () => {
  it("writes the row before approving, then leaves for the client with the code", async () => {
    const b = backend();
    const approve = b.approve.bind(b);
    let liveAtApproval: McpConnectionRecord | null = null;
    vi.spyOn(b, "approve").mockImplementation(async (id) => {
      liveAtApproval = await store.findLive(USER.id, CLIENT);
      return approve(id);
    });
    const outcome = await decideConsent(b, { authorizationId: AUTH_ID, decision: "connect", workspaceId: WS_A }, NOW);
    expect(outcome.kind).toBe("redirect");
    const target = new URL((outcome as { url: string }).url);
    expect(`${target.origin}${target.pathname}`).toBe(REDIRECT_URI);
    expect(target.searchParams.get("code")).toBeTruthy();
    expect(liveAtApproval).toMatchObject({ workspaceId: WS_A, userId: USER.id, oauthClientId: CLIENT, clientName: "ChatGPT" });
    expect(b.calls.approved).toEqual([AUTH_ID]);
  });

  it("binds the only workspace when none is posted", async () => {
    const outcome = await decideConsent(backend(), { authorizationId: AUTH_ID, decision: "connect" }, NOW);
    expect(outcome.kind).toBe("redirect");
    expect((await store.findLive(USER.id, CLIENT))?.workspaceId).toBe(WS_A);
  });

  it("refuses a posted workspace that is not the user's, and writes and approves nothing", async () => {
    const b = backend({ seats: [seat(WS_A, "2026-01-01T00:00:00.000Z"), seat(WS_B, "2026-02-01T00:00:00.000Z")] });
    const outcome = await decideConsent(b, { authorizationId: AUTH_ID, decision: "connect", workspaceId: WS_FOREIGN }, NOW);
    expect(outcome).toEqual({ kind: "notice", text: CONSENT_COPY.notYourWorkspace, done: false });
    expect(store.rows).toEqual([]);
    expect(b.calls.approved).toEqual([]);
  });

  it("asks for a workspace when there are several and none is posted", async () => {
    const b = backend({ seats: [seat(WS_A, "2026-01-01T00:00:00.000Z"), seat(WS_B, "2026-02-01T00:00:00.000Z")] });
    expect(await decideConsent(b, { authorizationId: AUTH_ID, decision: "connect" }, NOW)).toEqual({
      kind: "notice",
      text: CONSENT_COPY.pickWorkspace,
      done: false,
    });
  });

  it("re-reads the membership: a seat removed after the page loaded is refused", async () => {
    const seats = [seat(WS_A, "2026-01-01T00:00:00.000Z"), seat(WS_B, "2026-02-01T00:00:00.000Z")];
    const b = backend({ seats });
    asScreen(await loadConsent(b, AUTH_ID));
    seats.pop();
    const outcome = await decideConsent(b, { authorizationId: AUTH_ID, decision: "connect", workspaceId: WS_B }, NOW);
    expect(outcome).toMatchObject({ kind: "notice", text: CONSENT_COPY.notYourWorkspace });
    expect(store.rows).toEqual([]);
  });

  it("moves a live row in another workspace and keeps the profile id", async () => {
    store = new MemoryMcpConnectionStore([row({ workspaceId: WS_A })]);
    const b = backend({ seats: [seat(WS_A, "2026-01-01T00:00:00.000Z"), seat(WS_B, "2026-02-01T00:00:00.000Z")] });
    await decideConsent(b, { authorizationId: AUTH_ID, decision: "connect", workspaceId: WS_B }, NOW);
    const live = await store.findLive(USER.id, CLIENT);
    expect(live?.workspaceId).toBe(WS_B);
    expect(live?.profileId).toBe("ProfileIdProfileId0001");
    expect(store.rows.find((r) => r.workspaceId === WS_A)?.revokedAt).toEqual(NOW);
  });

  it("Cancel denies the request and sends the browser back with access_denied", async () => {
    const b = backend();
    const outcome = await decideConsent(b, { authorizationId: AUTH_ID, decision: "cancel" }, NOW);
    expect(outcome.kind).toBe("redirect");
    expect(new URL((outcome as { url: string }).url).searchParams.get("error")).toBe("access_denied");
    expect(b.calls.denied).toEqual([AUTH_ID]);
    expect(store.rows).toEqual([]);
  });

  it("checks the allowlist again on Connect, before any redirect", async () => {
    const b = backend({ authorizations: [request({ clientId: OTHER_CLIENT })] });
    const outcome = await decideConsent(b, { authorizationId: AUTH_ID, decision: "connect", workspaceId: WS_A }, NOW);
    expect(outcome).toEqual({ kind: "notice", text: CONSENT_COPY.unknownClient, done: true });
    expect(store.rows).toEqual([]);
    expect(b.calls.approved).toEqual([]);
  });

  it("answers an expired id with the expiry copy and a signed out session with the page", async () => {
    expect(await decideConsent(backend(), { authorizationId: "Gone0000000000000000000000000000", decision: "connect" }, NOW)).toEqual({
      kind: "notice",
      text: CONSENT_COPY.expired,
      done: true,
    });
    expect(await decideConsent(backend(), { authorizationId: "../x", decision: "connect" }, NOW)).toMatchObject({
      text: CONSENT_COPY.expired,
    });
    expect(await decideConsent(backend({ user: null }), { authorizationId: AUTH_ID, decision: "connect" }, NOW)).toEqual({
      kind: "redirect",
      url: consentPath(AUTH_ID),
    });
  });
});

describe("the consented path (Supabase answers only redirect_url)", () => {
  function consented(overrides: Partial<MemoryConsentBackendOptions> = {}): MemoryConsentBackend {
    return backend({ authorizations: [request({ state: "consented" })], ...overrides });
  }

  it("follows the link at once when a live row exists in a workspace the user still belongs to", async () => {
    store = new MemoryMcpConnectionStore([row()]);
    const view = await loadConsent(consented(), AUTH_ID);
    expect(view.kind).toBe("redirect");
    expect((view as { url: string }).url.startsWith(`${REDIRECT_URI}?`)).toBe(true);
  });

  it("with no live row shows the page and the picker, without following the link", async () => {
    store = new MemoryMcpConnectionStore([row({ revokedAt: new Date("2026-09-30T00:00:00.000Z") })]);
    const b = consented({ seats: [seat(WS_A, "2026-01-01T00:00:00.000Z"), seat(WS_B, "2026-02-01T00:00:00.000Z")] });
    const view = asScreen(await loadConsent(b, AUTH_ID));
    expect(view.path).toBe("consented");
    expect(view.redirectUrl?.startsWith(`${REDIRECT_URI}?`)).toBe(true);
    expect(view.workspaces).toHaveLength(2);
    expect(view.scopes.map((s) => s.scope)).toEqual(["openid", "email"]);
  });

  it("with a live row whose member left shows the page instead of following the link", async () => {
    store = new MemoryMcpConnectionStore([row({ workspaceId: WS_FOREIGN })]);
    const view = asScreen(await loadConsent(consented(), AUTH_ID));
    expect(view.defaultWorkspaceId).toBe(WS_A);
  });

  it("Connect writes the row, then follows the checked link; a revoked row is not reused", async () => {
    store = new MemoryMcpConnectionStore([row({ revokedAt: new Date("2026-09-30T00:00:00.000Z") })]);
    const b = consented({ seats: [seat(WS_A, "2026-01-01T00:00:00.000Z"), seat(WS_B, "2026-02-01T00:00:00.000Z")] });
    const view = asScreen(await loadConsent(b, AUTH_ID));
    const outcome = await decideConsent(
      b,
      { authorizationId: AUTH_ID, decision: "connect", workspaceId: WS_B, redirectUrl: view.redirectUrl },
      NOW,
    );
    expect(outcome).toEqual({ kind: "redirect", url: view.redirectUrl });
    const live = await store.findLive(USER.id, CLIENT);
    expect(live?.workspaceId).toBe(WS_B);
    expect(live?.id).not.toBe("00000000-0000-4000-8000-0000000c0001");
    expect(live?.profileId).toBe("ProfileIdProfileId0001");
    expect(b.calls.approved).toEqual([]);
  });

  it("never follows a posted link to anywhere but the client's registered redirect URI", async () => {
    const b = consented();
    const view = asScreen(await loadConsent(b, AUTH_ID));
    for (const forged of [
      "https://evil.example/connector/oauth/cb123?code=x",
      "https://chatgpt.com/other?code=x",
      "http://chatgpt.com/connector/oauth/cb123?code=x",
      "https://chatgpt.com/connector/oauth/cb123#code=x",
      "javascript:alert(1)",
      "/relative",
    ]) {
      const outcome = await decideConsent(b, { authorizationId: AUTH_ID, decision: "connect", workspaceId: WS_A, redirectUrl: forged }, NOW);
      expect(outcome, forged).toEqual({ kind: "notice", text: CONSENT_COPY.expired, done: true });
    }
    expect(view.redirectUrl).not.toBeNull();
    expect(store.rows).toEqual([]);
  });

  it("checks the allowlist on the consented path, on the page and on Connect", async () => {
    const b = backend({ authorizations: [request({ state: "consented", clientId: OTHER_CLIENT })] });
    expect(await loadConsent(b, AUTH_ID)).toEqual({ kind: "message", message: "unknownClient" });
    const outcome = await decideConsent(
      b,
      { authorizationId: AUTH_ID, decision: "connect", workspaceId: WS_A, redirectUrl: `${REDIRECT_URI}?code=x&state=y` },
      NOW,
    );
    expect(outcome).toEqual({ kind: "notice", text: CONSENT_COPY.unknownClient, done: true });
    expect(store.rows).toEqual([]);
  });

  it("Cancel follows nothing and says nothing was shared", async () => {
    const b = consented();
    const view = asScreen(await loadConsent(b, AUTH_ID));
    const outcome = await decideConsent(b, { authorizationId: AUTH_ID, decision: "cancel", redirectUrl: view.redirectUrl }, NOW);
    expect(outcome).toEqual({ kind: "notice", text: "Nothing was shared. You can close this page.", done: true });
    expect(store.rows).toEqual([]);
  });

  it("fails closed when auth.oauth_authorizations cannot be read", async () => {
    const b = consented({ storedUnavailable: true });
    expect(await loadConsent(b, AUTH_ID)).toEqual({ kind: "message", message: "unavailable" });
    const outcome = await decideConsent(
      b,
      { authorizationId: AUTH_ID, decision: "connect", workspaceId: WS_A, redirectUrl: `${REDIRECT_URI}?code=x` },
      NOW,
    );
    expect(outcome).toEqual({ kind: "notice", text: CONSENT_COPY.unavailable, done: true });
    expect(store.rows).toEqual([]);
  });

  it("takes the consented path when consent landed elsewhere after the page loaded", async () => {
    const b = backend();
    asScreen(await loadConsent(b, AUTH_ID));
    const auth = b.authorization(AUTH_ID);
    if (auth) {
      auth.state = "consented";
    }
    const outcome = await decideConsent(b, { authorizationId: AUTH_ID, decision: "connect", workspaceId: WS_A }, NOW);
    expect(outcome.kind).toBe("redirect");
    expect((await store.findLive(USER.id, CLIENT))?.workspaceId).toBe(WS_A);
  });
});

describe("helpers", () => {
  it("redirectMatches accepts the registered URI with a query only", () => {
    expect(redirectMatches(`${REDIRECT_URI}?code=a&state=b`, REDIRECT_URI)).toBe(true);
    expect(redirectMatches(REDIRECT_URI, REDIRECT_URI)).toBe(true);
    expect(redirectMatches("http://127.0.0.1:1455/cb?code=a", "http://127.0.0.1:1455/cb")).toBe(true);
    expect(redirectMatches("https://user:pw@chatgpt.com/connector/oauth/cb123", REDIRECT_URI)).toBe(false);
    expect(redirectMatches("not a url", REDIRECT_URI)).toBe(false);
    expect(redirectMatches(`${REDIRECT_URI}?code=a`, "not a url")).toBe(false);
  });

  it("scopeLines orders known scopes, names unknown ones and flags extras", () => {
    expect(scopeLines(["email", "openid", "email"])).toEqual({
      lines: [
        { scope: "openid", text: SCOPE_LINES.openid },
        { scope: "email", text: SCOPE_LINES.email },
      ],
      extra: false,
    });
    expect(scopeLines(["openid", "custom"])).toEqual({
      lines: [
        { scope: "openid", text: SCOPE_LINES.openid },
        { scope: "custom", text: "A permission named custom" },
      ],
      extra: true,
    });
    expect(scopeLines(["constructor"]).lines[0]?.text).toBe("A permission named constructor");
  });
});

describe("the demo backend", () => {
  it("refuses production (DemoModeRefusedError), as getApiKeyBackend relies on getServices()", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ALLOW_DEMO_MODE", "");
    vi.stubEnv("DATABASE_URL", "");
    expect(() => getConsentBackend()).toThrow(DemoModeRefusedError);
  });

  it("serves the fixed requests and picks the demo person from the cookie", async () => {
    expect(demoConsentPerson(undefined)).toBe("owner");
    expect(demoConsentPerson("teammate")).toBe("teammate");
    expect(demoConsentPerson("signed_out")).toBe("signed_out");
    expect(demoConsentPerson("admin")).toBe("owner");

    expect(await loadConsent(demoConsentBackend("signed_out"), DEMO_AUTHORIZATION_IDS.fresh)).toMatchObject({ kind: "signed_out" });
    const teammate = asScreen(await loadConsent(demoConsentBackend("teammate"), DEMO_AUTHORIZATION_IDS.fresh));
    expect(teammate.workspaces.map((w) => w.id)).toContain(DEMO_SECOND_WORKSPACE_ID);
    expect(teammate.extraScopes).toBe(true);
    expect(await loadConsent(demoConsentBackend("owner"), DEMO_AUTHORIZATION_IDS.unknownClient)).toEqual({
      kind: "message",
      message: "unknownClient",
    });
    expect(await loadConsent(demoConsentBackend("owner"), "demo-anything-else")).toEqual({ kind: "message", message: "expired" });
  });

  it("leaves for the demo redirect and writes the shared demo row", async () => {
    const owner = demoConsentBackend("owner");
    const outcome = await decideConsent(owner, { authorizationId: DEMO_AUTHORIZATION_IDS.fresh, decision: "connect" }, NOW);
    expect(outcome.kind).toBe("redirect");
    expect((outcome as { url: string }).url.startsWith(DEMO_CONSENT_REDIRECT_URI)).toBe(true);
    // One process wide store: the MCP server's demo backend sees the row.
    expect(demoMcpConnectionStore()).toBe(owner.connections);
    expect((await owner.connections.findLive(DEMO_OWNER_ID, DEMO_CONSENT_CLIENT_ID))?.workspaceId).toBe(DEMO_WORKSPACE_ID);
    const teammate = demoConsentBackend("teammate");
    await decideConsent(teammate, { authorizationId: DEMO_AUTHORIZATION_IDS.fresh, decision: "connect", workspaceId: DEMO_SECOND_WORKSPACE_ID }, NOW);
    expect((await teammate.connections.findLive(DEMO_TEAMMATE_ID, DEMO_CONSENT_CLIENT_ID))?.workspaceId).toBe(DEMO_SECOND_WORKSPACE_ID);
  });
});

describe("copy (rule 9 and no selling in the connect flow)", () => {
  function strings(): string[] {
    const out: string[] = [];
    for (const table of [CONSENT_COPY, CONNECTED_APPS_COPY, SCOPE_LINES]) {
      for (const value of Object.values(table)) {
        if (typeof value === "string") {
          out.push(value);
        } else if (Array.isArray(value)) {
          out.push(...(value as string[]));
        } else if (typeof value === "function") {
          out.push((value as (arg: string) => string)("Shop A"));
        }
      }
    }
    return out;
  }

  it("passes the rule 9 lint and names no plan, price or upgrade", () => {
    for (const text of strings()) {
      expect(rule9Problems(text), text).toEqual([]);
      const lower = text.toLowerCase();
      for (const word of MCP_BANNED_WORDS) {
        expect(lower.includes(word), `${word} in ${text}`).toBe(false);
      }
      expect(/\bfree\b|\bprice|\bplan\b/i.test(text), text).toBe(false);
    }
  });

  it("keeps the plan's lines", () => {
    expect(CONSENT_COPY.title).toBe("Connect ChatGPT to Curvi");
    expect(CONSENT_COPY.signedInAs("a@example.com")).toBe("Signed in as a@example.com.");
    expect(CONSENT_COPY.pickerLabel).toBe("Which workspace should ChatGPT use?");
    expect(CONSENT_COPY.footer).toBe("You can disconnect at any time in Settings, Connected apps.");
    expect(CONSENT_COPY.extraScopesNote).toBe("ChatGPT asks for these by default. Curvi does not use them.");
    expect(CONNECTED_APPS_COPY.row("Shop A")).toBe("ChatGPT can make packs in Shop A using its credits.");
    expect(CONNECTED_APPS_COPY.disconnected).toBe(
      "Disconnected. ChatGPT can no longer use this workspace, and links it already shared stop working.",
    );
  });
});
