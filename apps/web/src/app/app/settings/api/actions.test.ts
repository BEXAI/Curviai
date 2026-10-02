import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { demoApiKeyBackend, setApiKeyBackendForTests } from "@/lib/api-keys/backend";
import { API_KEY_COPY } from "@/lib/api-keys/manage";
import { MemoryApiKeyStore } from "@/lib/api-keys/store";
import type { Services, WorkspaceRole } from "@/lib/services/types";
import { TEST_WORKSPACE_ID, createFakeServices, workspaceFor } from "@/lib/testing/fake-services";

// createApiKeyAction and revokeApiKeyAction are server actions, so public
// POST endpoints: they must refuse signed out callers and seats that cannot
// manage keys, and take any argument the browser sends without throwing.

const session = vi.hoisted(() => ({ user: null as { id: string } | null }));
const revalidatePath = vi.hoisted(() => vi.fn());

let services: Services;

vi.mock("next/cache", () => ({ revalidatePath }));
vi.mock("@/lib/services", () => ({
  getServices: () => services,
  isDbMode: () => true,
}));
vi.mock("@/lib/supabase/server", () => ({
  getSessionUser: async () => session.user,
  createSupabaseServerClient: async () => null,
}));

const { createApiKeyAction, revokeApiKeyAction } = await import("./actions");

let store: MemoryApiKeyStore;

function servicesFor(role: WorkspaceRole | null): Services {
  const fake = createFakeServices(role);
  if (role) {
    vi.mocked(fake.ensureWorkspace).mockResolvedValue({ ...workspaceFor(role), plan: "pro" });
  }
  return fake;
}

beforeEach(() => {
  services = servicesFor("owner");
  session.user = { id: "user-1" };
  store = new MemoryApiKeyStore();
  setApiKeyBackendForTests(demoApiKeyBackend(store, () => services));
  revalidatePath.mockClear();
});

afterEach(() => {
  setApiKeyBackendForTests(null);
});

describe("createApiKeyAction", () => {
  it("makes a key for an owner and refreshes the API settings page", async () => {
    const result = await createApiKeyAction("Zapier");
    expect(result).toMatchObject({ ok: true, notice: API_KEY_COPY.created });
    if (!result.ok) throw new Error("expected a key");
    expect(result.key.length).toBeGreaterThan(20);
    expect(result.view.name).toBe("Zapier");
    expect(revalidatePath).toHaveBeenCalledWith("/app/settings/api");
    const [record] = await store.list(TEST_WORKSPACE_ID);
    expect(record?.createdBy).toBe("user-1");
  });

  it("refuses a signed out visitor", async () => {
    services = servicesFor(null);
    expect(await createApiKeyAction("Zapier")).toEqual({
      ok: false,
      reason: "forbidden",
      notice: API_KEY_COPY.signedOut,
    });
    expect(await store.countActive(TEST_WORKSPACE_ID)).toBe(0);
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("refuses a workspace with no session user", async () => {
    session.user = null;
    expect(await createApiKeyAction("Zapier")).toEqual({
      ok: false,
      reason: "forbidden",
      notice: API_KEY_COPY.signedOut,
    });
    expect(await store.countActive(TEST_WORKSPACE_ID)).toBe(0);
  });

  it.each<WorkspaceRole>(["editor", "client"])("refuses a %s seat", async (role) => {
    services = servicesFor(role);
    expect(await createApiKeyAction("Zapier")).toEqual({
      ok: false,
      reason: "forbidden",
      notice: API_KEY_COPY.forbidden,
    });
    expect(await store.countActive(TEST_WORKSPACE_ID)).toBe(0);
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it.each([[42], [null], [{ name: "Zapier" }], [["Zapier"]]])(
    "answers invalid for a name that is not text (%j) without throwing",
    async (name) => {
      expect(await createApiKeyAction(name as unknown as string)).toEqual({
        ok: false,
        reason: "invalid",
        notice: API_KEY_COPY.nameRequired,
      });
      expect(await store.countActive(TEST_WORKSPACE_ID)).toBe(0);
      expect(revalidatePath).not.toHaveBeenCalled();
    },
  );

  it("drops scope entries that are not text", async () => {
    const result = await createApiKeyAction("Reader", ["packs:read", 42, null, { scope: "checks" }] as unknown as string[]);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected a key");
    expect(result.view.scopes).toEqual(["packs:read"]);
  });
});

describe("revokeApiKeyAction", () => {
  async function makeKey(): Promise<string> {
    const made = await createApiKeyAction("Zapier");
    if (!made.ok) throw new Error("expected a key");
    revalidatePath.mockClear();
    return made.view.id;
  }

  it("revokes a key for an owner and refreshes the API settings page", async () => {
    const id = await makeKey();
    expect(await revokeApiKeyAction(id)).toEqual({ ok: true, notice: API_KEY_COPY.revoked });
    expect(await store.countActive(TEST_WORKSPACE_ID)).toBe(0);
    expect(revalidatePath).toHaveBeenCalledWith("/app/settings/api");
  });

  it("refuses an editor seat and leaves the key active", async () => {
    const id = await makeKey();
    services = servicesFor("editor");
    expect(await revokeApiKeyAction(id)).toEqual({
      ok: false,
      reason: "forbidden",
      notice: API_KEY_COPY.forbidden,
    });
    expect(await store.countActive(TEST_WORKSPACE_ID)).toBe(1);
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("refuses a signed out visitor", async () => {
    const id = await makeKey();
    services = servicesFor(null);
    expect(await revokeApiKeyAction(id)).toEqual({
      ok: false,
      reason: "forbidden",
      notice: API_KEY_COPY.signedOut,
    });
    expect(await store.countActive(TEST_WORKSPACE_ID)).toBe(1);
  });

  it.each([[42], [null], [{ id: "x" }], [["x"]]])(
    "answers not found for an id that is not text (%j) without throwing",
    async (id) => {
      await makeKey();
      expect(await revokeApiKeyAction(id as unknown as string)).toEqual({
        ok: false,
        reason: "not_found",
        notice: API_KEY_COPY.notFound,
      });
      expect(await store.countActive(TEST_WORKSPACE_ID)).toBe(1);
      expect(revalidatePath).not.toHaveBeenCalled();
    },
  );
});
