"use server";

import { getServices } from "@/lib/services";
import type { BrandKitView, SaveResult } from "@/lib/services/types";

export async function saveBrandKitAction(kit: BrandKitView): Promise<SaveResult> {
  const services = getServices();
  const workspace = await services.ensureWorkspace();
  if (!workspace) {
    return { ok: false, notice: "Sign in to save the brand kit." };
  }
  return services.saveBrandKit(workspace.id, kit);
}
