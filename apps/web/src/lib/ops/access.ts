import { notFound, redirect } from "next/navigation";
import { getOperatorSession } from "@/lib/operator-session";

/** Call in every operator page and action; a layout alone does not fence reads. */
export async function requireOperator() {
  const session = await getOperatorSession();
  if (!session) notFound();
  if (session.aal !== "aal2") redirect("/app/ops/security");
  return session;
}
