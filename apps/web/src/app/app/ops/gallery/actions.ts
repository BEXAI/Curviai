"use server";

import { revalidatePath } from "next/cache";
import { requireOperator } from "@/lib/ops/access";
import { reviewGalleryItem } from "@/lib/ops/gallery";
import { getDb } from "@/lib/services/db";

export async function reviewGallery(form: FormData): Promise<void> {
  const { user, aal } = await requireOperator();
  const itemId = form.get("itemId");
  const decision = form.get("decision");
  if (typeof itemId !== "string" || (decision !== "approved" && decision !== "rejected")) throw new Error("Invalid gallery review");
  await reviewGalleryItem(getDb(), { itemId, decision, operator: user, aal });
  revalidatePath("/app/ops/gallery");
  revalidatePath("/gallery");
  revalidatePath("/sitemap.xml");
}
