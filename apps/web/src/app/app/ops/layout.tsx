import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import React, { type ReactNode } from "react";
import Link from "next/link";
import { getOperatorSession } from "@/lib/operator-session";

/**
 * The founder cockpit under /app/ops (docs/phases/PHASE_20.md, W7): one
 * operator gate for every page below it, reusing isOperator (lib/ops.ts,
 * OPS_EMAILS). Everyone else, signed in or not, gets a 404, so the pages do
 * not show that they exist. Never indexed. Each page and server action
 * still checks isOperator itself, and P20-49 adds the second factor here.
 * P20-45 adds the navigation.
 */

export const metadata: Metadata = {
  robots: { index: false, follow: false, nocache: true },
};
export const dynamic = "force-dynamic";

export default async function OpsLayout({ children }: { children: ReactNode }) {
  const session = await getOperatorSession();
  if (!session) {
    notFound();
  }
  const path = (await headers()).get("x-curvi-ops-path");
  if (session.aal !== "aal2" && path !== "/app/ops/security") redirect("/app/ops/security");
  return <div className="space-y-6"><nav aria-label="Operations" className="flex flex-wrap gap-4 border-b pb-3 text-sm">
    {[["Overview", "/app/ops"], ["Jobs", "/app/ops/jobs"], ["Gallery", "/app/ops/gallery"], ["Visitors", "/app/ops/visitors"], ["Prospects", "/app/ops/prospects"], ["Funnel", "/app/ops/funnel"], ["Security", "/app/ops/security"]].map(([label, href]) => <Link key={href} href={href!} className="underline underline-offset-4">{label}</Link>)}
  </nav>{children}</div>;
}
