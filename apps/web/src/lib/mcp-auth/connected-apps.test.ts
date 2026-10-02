import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { demoApiFixture } from "@/lib/api-v1/test-fixtures";
import { authenticateMcp } from "./authenticate";
import { memoryMcpAuthBackend, type MemoryMembership } from "./backend";
import { disconnectConnectedApp, listConnectedApps, type ConnectedAppsViewer } from "./connected-apps";
import { MemoryMcpConnectionStore, type McpConnectionRecord } from "./connections";
import { MemoryConsentBackend, type MemoryAuthorization, type MemoryConsentBackendOptions, type MemoryConsentSeat } from "./consent-backend";
import { CONNECTED_APPS_COPY } from "./consent-copy";
import { decideConsent, loadConsent, type ConsentScreen } from "./consent";
import { TEST_CLIENT_ID, TEST_CONFIG, TEST_USER_ID, oauthClaims, testKeys, type TestKeys } from "./test-tokens";

// Settings, Connected apps (docs/phases/PHASE_19.md, P19-10 and
// "Revocation"): who sees which connection, who may disconnect it, what a
// disconnect does at Supabase, and that a disconnected ChatGPT stays out
// until the user passes the consent page again.

const OWNER = TEST_USER_ID;
const ADMIN = "00000000-0000-4000-8000-0000000000ad";
const EDITOR = "00000000-0000-4000-8000-0000000000ed";
const WS_A = "00000000-0000-4000-8000-00000000aaaa";
const WS_B = "00000000-0000-4000-8000-00000000bbbb";
const NOW = new Date("2026-10-01T12:00:00.000Z");
const REDIRECT_URI = "https://chatgpt.com/connector/oauth/cb123";

const ROW_OWNER_A = "00000000-0000-4000-8000-0000000c00a1";
const ROW_OWNER_B = "00000000-0000-4000-8000-0000000c00b1";
const ROW_EDITOR_A = "00000000-0000-4000-8000-0000000c00e1";

function seat(userId: string, workspaceId: string, role: MemoryConsentSeat["role"], joined = "2026-01-01T00:00:00.000Z"): MemoryConsentSeat {
  return { userId, workspaceId, workspaceName: workspaceId === WS_A ? "Shop A" : "Shop B", role, joinedAt: new Date(joined) };
}

function row(overrides: Partial<McpConnectionRecord>): McpConnectionRecord {
  return {
    id: ROW_OWNER_A,
    workspaceId: WS_A,
    userId: OWNER,
    oauthClientId: TEST_CLIENT_ID,
    clientName: "ChatGPT",
    profileId: "ProfileIdProfileId0001",
    createdAt: new Date("2026-09-01T00:00:00.000Z"),
    lastUsedAt: null,
    revokedAt: null,
    ...overrides,
  };
}

let store: MemoryMcpConnectionStore;
let seats: MemoryConsentSeat[];
let keys: TestKeys;

function backend(userId: string, overrides: Partial<MemoryConsentBackendOptions> = {}): MemoryConsentBackend {
  return new MemoryConsentBackend({
    user: { id: userId, email: `${userId.slice(-2)}@example.com` },
    seats,
    connections: store,
    clientIds: [TEST_CLIENT_ID],
    ...overrides,
  });
}

function viewer(userId: string, role: ConnectedAppsViewer["role"], workspaceId = WS_A): ConnectedAppsViewer {
  return { userId, workspaceId, role };
}

beforeAll(async () => {
  keys = await testKeys();
});

beforeEach(() => {
  seats = [
    seat(OWNER, WS_A, "owner"),
    seat(OWNER, WS_B, "owner", "2026-02-01T00:00:00.000Z"),
    seat(ADMIN, WS_A, "admin"),
    seat(EDITOR, WS_A, "editor"),
  ];
  store = new MemoryMcpConnectionStore([
    row({ id: ROW_OWNER_A }),
    row({ id: ROW_OWNER_B, workspaceId: WS_B, oauthClientId: "22222222-2222-4333-8444-555555555555", clientName: null, createdAt: new Date("2026-09-02T00:00:00.000Z") }),
    row({ id: ROW_EDITOR_A, userId: EDITOR, profileId: "ProfileIdProfileId0002", lastUsedAt: new Date("2026-09-20T00:00:00.000Z") }),
    row({ id: "00000000-0000-4000-8000-0000000c00e0", userId: EDITOR, revokedAt: new Date("2026-08-01T00:00:00.000Z") }),
  ]);
});

describe("listConnectedApps", () => {
  it("a member sees their own live connections in every workspace, newest first", async () => {
    const apps = await listConnectedApps(backend(OWNER), viewer(OWNER, "editor"));
    expect(apps.map((a) => [a.id, a.workspaceName, a.own, a.clientName])).toEqual([
      [ROW_OWNER_B, "Shop B", true, "ChatGPT"],
      [ROW_OWNER_A, "Shop A", true, "ChatGPT"],
    ]);
  });

  it("owners and admins also see the other members' live connections in this workspace, with who made them", async () => {
    const labels = new Map([[EDITOR, "Member 00000000"]]);
    const apps = await listConnectedApps(backend(ADMIN), viewer(ADMIN, "admin"), labels);
    // Same creation time: the later write first.
    expect(apps.map((a) => [a.id, a.own, a.memberLabel])).toEqual([
      [ROW_EDITOR_A, false, "Member 00000000"],
      [ROW_OWNER_A, false, CONNECTED_APPS_COPY.someone],
    ]);
    expect(apps.find((a) => a.id === ROW_EDITOR_A)?.lastUsedAt).toBe("2026-09-20T00:00:00.000Z");
  });

  it("an editor does not see another member's connection, and nobody sees a revoked one", async () => {
    const apps = await listConnectedApps(backend(EDITOR), viewer(EDITOR, "editor"));
    expect(apps.map((a) => a.id)).toEqual([ROW_EDITOR_A]);
  });
});

describe("disconnectConnectedApp", () => {
  it("your own: sets revoked_at and revokes the grant with your web session", async () => {
    const b = backend(OWNER);
    const result = await disconnectConnectedApp(b, viewer(OWNER, "owner"), ROW_OWNER_A, NOW);
    expect(result).toEqual({ ok: true, notice: CONNECTED_APPS_COPY.disconnected });
    expect((await store.findById(ROW_OWNER_A))?.revokedAt).toEqual(NOW);
    expect(b.calls.revokedGrants).toEqual([{ userId: OWNER, clientId: TEST_CLIENT_ID }]);
    expect(b.calls.endedSessions).toEqual([]);
  });

  it("your own: ends the client's sessions over the owner connection when Supabase cannot revoke the grant", async () => {
    const b = backend(OWNER, { grantRevokeFails: true });
    await disconnectConnectedApp(b, viewer(OWNER, "owner"), ROW_OWNER_A, NOW);
    expect(b.calls.endedSessions).toEqual([{ userId: OWNER, clientId: TEST_CLIENT_ID }]);
    expect((await store.findById(ROW_OWNER_A))?.revokedAt).toEqual(NOW);
  });

  it("an admin can disconnect a member's: the row is revoked and that member's sessions for the client end", async () => {
    const b = backend(ADMIN);
    const result = await disconnectConnectedApp(b, viewer(ADMIN, "admin"), ROW_EDITOR_A, NOW);
    expect(result.ok).toBe(true);
    expect((await store.findById(ROW_EDITOR_A))?.revokedAt).toEqual(NOW);
    expect(b.calls.endedSessions).toEqual([{ userId: EDITOR, clientId: TEST_CLIENT_ID }]);
    expect(b.calls.revokedGrants).toEqual([]);
  });

  it("an editor cannot disconnect another member's, and the row stays live", async () => {
    const b = backend(EDITOR);
    expect(await disconnectConnectedApp(b, viewer(EDITOR, "editor"), ROW_OWNER_A, NOW)).toEqual({
      ok: false,
      notice: CONNECTED_APPS_COPY.notAllowed,
    });
    expect((await store.findById(ROW_OWNER_A))?.revokedAt).toBeNull();
    expect(b.calls.endedSessions).toEqual([]);
  });

  it("the admin check reads the row's workspace, not the page's: an admin of A cannot touch a row in B", async () => {
    seats.push(seat(EDITOR, WS_B, "editor"));
    store.rows.push(row({ id: "00000000-0000-4000-8000-0000000c00e2", userId: EDITOR, workspaceId: WS_B }));
    const result = await disconnectConnectedApp(backend(ADMIN), viewer(ADMIN, "admin"), "00000000-0000-4000-8000-0000000c00e2", NOW);
    expect(result).toEqual({ ok: false, notice: CONNECTED_APPS_COPY.notAllowed });
  });

  it("refuses a malformed or unknown id and answers an already revoked one plainly", async () => {
    expect(await disconnectConnectedApp(backend(OWNER), viewer(OWNER, "owner"), "nope", NOW)).toEqual({
      ok: false,
      notice: CONNECTED_APPS_COPY.alreadyDisconnected,
    });
    expect(await disconnectConnectedApp(backend(OWNER), viewer(OWNER, "owner"), "00000000-0000-4000-8000-000000000000", NOW)).toMatchObject({
      ok: false,
    });
    const b = backend(EDITOR);
    expect(await disconnectConnectedApp(b, viewer(EDITOR, "editor"), "00000000-0000-4000-8000-0000000c00e0", NOW)).toEqual({
      ok: true,
      notice: CONNECTED_APPS_COPY.alreadyDisconnected,
    });
    expect(b.calls.revokedGrants).toEqual([]);
  });
});

describe("after a disconnect", () => {
  async function bearer(userId: string): Promise<Headers> {
    return new Headers({ authorization: `Bearer ${await keys.sign(oauthClaims({ sub: userId }))}` });
  }

  function mcpBackend() {
    const memberships: MemoryMembership[] = seats.map((s) => ({
      userId: s.userId,
      workspaceId: s.workspaceId,
      workspaceName: s.workspaceName,
      plan: "free",
      role: s.role,
    }));
    return memoryMcpAuthBackend({ memberships, connections: store, services: () => demoApiFixture().service });
  }

  it("an admin's revoke stays revoked across calls: the MCP server never makes the row live again", async () => {
    // The editor is in one workspace, the one case where the server may
    // write a first row silently; a revoked row must still block it.
    await disconnectConnectedApp(backend(ADMIN), viewer(ADMIN, "admin"), ROW_EDITOR_A, NOW);
    const auth = mcpBackend();
    for (let i = 0; i < 3; i += 1) {
      const result = await authenticateMcp(await bearer(EDITOR), null, { backend: auth, config: TEST_CONFIG, jwks: keys.jwks, now: NOW });
      expect(result.ok ? "ok" : result.failure.kind).toBe("reconnect");
    }
    expect(await store.findLive(EDITOR, TEST_CLIENT_ID)).toBeNull();
  });

  it("a member can reconnect through the consent page, with the same profile id", async () => {
    await disconnectConnectedApp(backend(EDITOR), viewer(EDITOR, "editor"), ROW_EDITOR_A, NOW);
    // revokeGrant revoked the consent, so ChatGPT's next sign in is a fresh request.
    const request: MemoryAuthorization = {
      id: "FreshRequestAfterDisconnect00000",
      clientId: TEST_CLIENT_ID,
      clientName: "ChatGPT",
      scopes: ["openid", "email"],
      redirectUri: REDIRECT_URI,
      state: "pending",
    };
    const b = backend(EDITOR, { authorizations: [request] });
    const view = (await loadConsent(b, request.id)) as ConsentScreen;
    expect(view.kind).toBe("consent");
    const outcome = await decideConsent(b, { authorizationId: request.id, decision: "connect" }, NOW);
    expect(outcome.kind).toBe("redirect");
    const live = await store.findLive(EDITOR, TEST_CLIENT_ID);
    expect(live?.id).not.toBe(ROW_EDITOR_A);
    expect(live?.profileId).toBe("ProfileIdProfileId0002");
    const result = await authenticateMcp(await bearer(EDITOR), null, { backend: mcpBackend(), config: TEST_CONFIG, jwks: keys.jwks, now: NOW });
    expect(result.ok).toBe(true);
  });

  it("a two workspace member whose connection an admin revoked reconnects and picks", async () => {
    seats.push(seat(EDITOR, WS_B, "owner", "2026-03-01T00:00:00.000Z"));
    await disconnectConnectedApp(backend(ADMIN), viewer(ADMIN, "admin"), ROW_EDITOR_A, NOW);
    // The admin's revoke leaves the member's consent, so Supabase approves at
    // once and answers only redirect_url: the consented path.
    const request: MemoryAuthorization = {
      id: "ConsentedRequestAfterRevoke00000",
      clientId: TEST_CLIENT_ID,
      clientName: "ChatGPT",
      scopes: ["openid", "email"],
      redirectUri: REDIRECT_URI,
      state: "consented",
    };
    const b = backend(EDITOR, { authorizations: [request] });
    const view = (await loadConsent(b, request.id)) as ConsentScreen;
    expect(view.kind).toBe("consent");
    expect(view.path).toBe("consented");
    expect(view.workspaces.map((w) => w.id)).toEqual([WS_A, WS_B]);
    const outcome = await decideConsent(
      b,
      { authorizationId: request.id, decision: "connect", workspaceId: WS_B, redirectUrl: view.redirectUrl },
      NOW,
    );
    expect(outcome).toEqual({ kind: "redirect", url: view.redirectUrl });
    expect((await store.findLive(EDITOR, TEST_CLIENT_ID))?.workspaceId).toBe(WS_B);
  });
});
