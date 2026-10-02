import Link from "next/link";
import { operatorCases } from "@/lib/ops/cases";
import { CASE_LABELS, STATUS_LABELS } from "@/lib/cases/types";
import { requireOperator } from "@/lib/ops/access";
import { isDbMode } from "@/lib/services";
import { getDb } from "@/lib/services/db";
export default async function OperatorCasesPage() {
  const session = await requireOperator();
  if (!isDbMode()) return <p>Connect the database to view cases.</p>;
  const cases = await operatorCases(getDb(), { userId: session.user.id, email: session.user.email! });
  return <div className="space-y-5"><h1 className="text-2xl font-semibold">Pack cases</h1><p className="text-sm">Oldest updated open cases first. Showing up to 100 cases.</p>{cases.length ? <ul className="space-y-3">{cases.map((item) => <li key={item.case.id} className="rounded border p-4"><Link href={`/app/ops/cases/${item.case.id}`} className="underline">{CASE_LABELS[item.case.category]}</Link><p className="text-sm">{STATUS_LABELS[item.case.status]}</p><p className="text-xs">Workspace {item.workspaceId}</p></li>)}</ul> : <p>No open cases.</p>}</div>;
}
