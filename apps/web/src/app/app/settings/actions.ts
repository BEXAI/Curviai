"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { isR2Configured } from "@/lib/env";
import { getServices, isDbMode } from "@/lib/services";
import type { SaveResult } from "@/lib/services";
import { getDb } from "@/lib/services/db";
import { createSupabaseServerClient, getSessionUser } from "@/lib/supabase/server";
import { DELETE_ACCOUNT_NOTICES, deleteAccountData } from "@/lib/trust/account";
import { deleteAuthUser } from "@/lib/trust/auth-admin";
import { DELETE_CONFIRMATION_WORD, isDeleteConfirmed } from "@/lib/trust/confirmation";
import { r2TrustStorage } from "@/lib/trust/storage";

export async function renameWorkspaceAction(name: string): Promise<SaveResult> {
  const services = getServices();
  const workspace = await services.ensureWorkspace();
  if (!workspace) {
    return { ok: false, notice: "Sign in to rename the workspace." };
  }
  const result = await services.renameWorkspace(workspace.id, name);
  if (result.ok) {
    revalidatePath("/app");
    revalidatePath("/app/settings");
  }
  return result;
}

/**
 * Deletes the signed in user's account: workspace data and stored files
 * (lib/trust/account.ts), then the session, then the Supabase auth user.
 * Refusals come back as a notice; success redirects to /account-deleted.
 */
export async function deleteAccountAction(confirmation: string): Promise<SaveResult> {
  if (!isDeleteConfirmed(confirmation)) {
    return { ok: false, notice: `Type ${DELETE_CONFIRMATION_WORD} to confirm.` };
  }
  if (!isDbMode()) {
    return { ok: false, notice: "Demo mode has no account to delete." };
  }
  const user = await getSessionUser();
  if (!user) {
    return { ok: false, notice: DELETE_ACCOUNT_NOTICES.not_signed_in };
  }
  let result: Awaited<ReturnType<typeof deleteAccountData>>;
  try {
    result = await deleteAccountData({
      db: getDb(),
      userId: user.id,
      storage: isR2Configured() ? r2TrustStorage() : null,
    });
  } catch (err) {
    console.error(`[account] deleting the account of user ${user.id} failed`, err);
    return { ok: false, notice: "We could not delete your account right now. Nothing was deleted. Try again in a minute." };
  }
  if (!result.ok) {
    return { ok: false, notice: result.notice };
  }
  console.info(`[account] deleted the data of user ${user.id}`, {
    workspaces: result.workspacesDeleted,
    objectsDeleted: result.objectsDeleted,
    objectsFailed: result.objectsFailed,
  });
  try {
    await (await createSupabaseServerClient())?.auth.signOut();
  } catch (err) {
    console.warn(`[account] sign out after deletion failed for user ${user.id}`, err);
  }
  const removal = await deleteAuthUser(user.id);
  redirect(removal === "deleted" ? "/account-deleted" : "/account-deleted?signin=pending");
}
