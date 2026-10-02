import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Services } from "@/lib/services/types";
import { TEST_WORKSPACE_ID, createFakeServices } from "@/lib/testing/fake-services";

// Server actions are public POST endpoints: renameWorkspaceAction gets
// whatever the browser sends, and deleteAccountAction must refuse cleanly
// before anything is deleted.

const state = vi.hoisted(() => ({
  dbMode: true,
  user: null as { id: string } | null,
  authRemoval: "deleted" as "deleted" | "not_configured" | "failed",
}));

const revalidatePath = vi.hoisted(() => vi.fn());
const signOut = vi.hoisted(() => vi.fn(async () => ({ error: null })));
const deleteAccountData = vi.hoisted(() => vi.fn());

let services: Services;

vi.mock("next/cache", () => ({ revalidatePath }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`redirect:${to}`);
  },
}));
vi.mock("@/lib/services", () => ({
  getServices: () => services,
  isDbMode: () => state.dbMode,
}));
vi.mock("@/lib/services/db", () => ({ getDb: () => ({}) }));
vi.mock("@/lib/supabase/server", () => ({
  getSessionUser: async () => state.user,
  createSupabaseServerClient: async () => ({ auth: { signOut } }),
}));
vi.mock("@/lib/trust/account", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/trust/account")>()),
  deleteAccountData,
}));
vi.mock("@/lib/trust/auth-admin", () => ({
  deleteAuthUser: async () => state.authRemoval,
}));

const { deleteAccountAction, renameWorkspaceAction } = await import("./actions");
const { DELETE_ACCOUNT_NOTICES } = await import("@/lib/trust/account");

beforeEach(() => {
  services = createFakeServices("owner");
  state.dbMode = true;
  state.user = { id: "user-1" };
  state.authRemoval = "deleted";
  revalidatePath.mockClear();
  signOut.mockClear();
  deleteAccountData.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("renameWorkspaceAction", () => {
  it("renames the workspace and refreshes the settings page", async () => {
    expect(await renameWorkspaceAction("Corner Shop")).toEqual({ ok: true, notice: "ok" });
    expect(services.renameWorkspace).toHaveBeenCalledWith(TEST_WORKSPACE_ID, "Corner Shop");
    expect(revalidatePath).toHaveBeenCalledWith("/app/settings");
  });

  it("asks a signed out visitor to sign in", async () => {
    services = createFakeServices(null);
    expect(await renameWorkspaceAction("Corner Shop")).toEqual({ ok: false, notice: "Sign in to rename the workspace." });
    expect(services.renameWorkspace).not.toHaveBeenCalled();
  });

  it.each([[42], [null], [undefined], [{ trim: "x" }], [["Shop"]]])(
    "refuses a name that is not text (%j) without throwing or reaching the service",
    async (name) => {
      expect(await renameWorkspaceAction(name)).toEqual({ ok: false, notice: "Workspace name cannot be empty." });
      expect(services.renameWorkspace).not.toHaveBeenCalled();
      expect(revalidatePath).not.toHaveBeenCalled();
    },
  );

  it("does not refresh anything when the service refuses", async () => {
    vi.mocked(services.renameWorkspace).mockResolvedValueOnce({
      ok: false,
      notice: "Only owners and admins can rename the workspace.",
    });
    expect(await renameWorkspaceAction("Corner Shop")).toEqual({
      ok: false,
      notice: "Only owners and admins can rename the workspace.",
    });
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

describe("deleteAccountAction", () => {
  it.each([[""], ["delete me"], [42], [null], [{ word: "DELETE" }]])(
    "asks for the typed word when given %j",
    async (typed) => {
      expect(await deleteAccountAction(typed as string)).toEqual({ ok: false, notice: "Type DELETE to confirm." });
      expect(deleteAccountData).not.toHaveBeenCalled();
    },
  );

  it("has no account to delete in demo mode", async () => {
    state.dbMode = false;
    expect(await deleteAccountAction("DELETE")).toEqual({ ok: false, notice: "Demo mode has no account to delete." });
    expect(deleteAccountData).not.toHaveBeenCalled();
  });

  it("asks a signed out visitor to sign in", async () => {
    state.user = null;
    expect(await deleteAccountAction("DELETE")).toEqual({ ok: false, notice: DELETE_ACCOUNT_NOTICES.not_signed_in });
    expect(deleteAccountData).not.toHaveBeenCalled();
  });

  it("says nothing was deleted when the deletion throws, and does not sign out or redirect", async () => {
    deleteAccountData.mockRejectedValueOnce(new Error("database down"));
    expect(await deleteAccountAction("DELETE")).toEqual({
      ok: false,
      notice: "We could not delete your account right now. Nothing was deleted. Try again in a minute.",
    });
    expect(signOut).not.toHaveBeenCalled();
  });

  it("passes a refusal through", async () => {
    deleteAccountData.mockResolvedValueOnce({
      ok: false,
      reason: "pack_running",
      notice: DELETE_ACCOUNT_NOTICES.pack_running,
    });
    expect(await deleteAccountAction("DELETE")).toEqual({ ok: false, notice: DELETE_ACCOUNT_NOTICES.pack_running });
    expect(signOut).not.toHaveBeenCalled();
  });

  it("deletes the data for the session user, signs out and goes to /account-deleted", async () => {
    deleteAccountData.mockResolvedValueOnce({ ok: true, workspacesDeleted: [TEST_WORKSPACE_ID], objectsDeleted: 3, objectsFailed: 0 });
    await expect(deleteAccountAction(" delete ")).rejects.toThrow("redirect:/account-deleted");
    expect(deleteAccountData).toHaveBeenCalledWith(expect.objectContaining({ userId: "user-1" }));
    expect(signOut).toHaveBeenCalledTimes(1);
  });

  it("says the sign in is still pending when removing the auth user fails", async () => {
    state.authRemoval = "failed";
    deleteAccountData.mockResolvedValueOnce({ ok: true, workspacesDeleted: [], objectsDeleted: 0, objectsFailed: 0 });
    await expect(deleteAccountAction("DELETE")).rejects.toThrow("redirect:/account-deleted?signin=pending");
  });
});
