"use server";

import { revalidatePath } from "next/cache";
import { getServices } from "@/lib/services";
import type { SaveResult } from "@/lib/services";

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
