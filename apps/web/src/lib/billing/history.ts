/** A workspace's ledger, grouped once per pack, including all follow ups. */
import { sql, type Db, type LedgerReason, type LedgerSource } from "@curvi/db";
import { csvField } from "@curvi/pipeline/csv";
import { billingViews } from "@curvi/pipeline/seed";

export const HISTORY_PAGE_SIZE = billingViews.historyPageSize;
export interface CreditHistoryEntry {
  id: string;
  at: string;
  credits: number;
  label: string;
  jobId: string | null;
  held: boolean;
}
export interface HistoryPage { entries: CreditHistoryEntry[]; nextCursor: string | null }
interface HistoryGroup {
  id: string;
  at: string | Date;
  credits: string | number;
  reason: LedgerReason;
  source: LedgerSource | null;
  job_id: string | null;
  title: string | null;
  status: string | null;
  note: string | null;
}
function rowsOf<T>(value: unknown): T[] {
  return (Array.isArray(value) ? value : (value as { rows?: T[] })?.rows ?? []) as T[];
}
export function historyLabel(row: Pick<HistoryGroup, "reason" | "source" | "note" | "job_id" | "title">): string {
  if (row.job_id) return `Pack for ${row.title || "your product"}`;
  if (row.note) return row.note;
  if (row.source === "signup") return "Welcome credits";
  if (row.reason === "topup") return "Top up";
  if (row.reason === "referral") return "Referral credits";
  if (row.reason === "refund") return "Taken back after a refund or plan change";
  if (row.reason === "grant") return row.source === "system" ? "Operator credit grant" : "Plan credits";
  if (row.reason === "release") return "Credits returned";
  return "Credit adjustment";
}
export function historyEntry(row: HistoryGroup): CreditHistoryEntry {
  return {
    id: row.id, at: new Date(row.at).toISOString(), credits: Math.round(Number(row.credits) * 10) / 10,
    label: historyLabel(row), jobId: row.job_id,
    held: row.job_id !== null && row.status !== null && !["done", "failed", "canceled"].includes(row.status),
  };
}
function encodeCursor(entry: CreditHistoryEntry): string {
  return Buffer.from(JSON.stringify([entry.at, entry.id])).toString("base64url");
}
export function historyCursor(value: string | null): { at: string; id: string } | null {
  if (!value) return null;
  if (value.length > 240 || !/^[\w-]+$/.test(value)) throw new Error("Invalid credit history cursor.");
  try {
    const [at, id] = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown[];
    if (typeof at !== "string" || !Number.isFinite(Date.parse(at)) || typeof id !== "string" ||
      !/^(job|entry):[0-9a-f-]{36}$/i.test(id)) throw new Error();
    return { at: new Date(at).toISOString(), id };
  } catch { throw new Error("Invalid credit history cursor."); }
}
/** The route supplies the authenticated workspace; a cursor never supplies one.
 * SQL ordering uses the same millisecond precision as the serialized cursor. */
export async function listCreditHistory(db: Db, workspaceId: string, cursor: string | null = null): Promise<HistoryPage> {
  const after = historyCursor(cursor);
  const groups = rowsOf<HistoryGroup>(await db.execute(sql`
    with grouped as (
      select case when cl.job_id is null then 'entry:' || cl.id::text else 'job:' || cl.job_id::text end as id,
        date_trunc('milliseconds', max(cl.created_at)) as at, sum(cl.delta) as credits, min(cl.reason) as reason,
        min(cl.source) as source, cl.job_id, max(p.title) as title, max(j.status) as status, max(cl.note) as note
      from credit_ledger cl
      left join generation_jobs j on j.id = cl.job_id and j.workspace_id = cl.workspace_id
      left join products p on p.id = j.product_id and p.workspace_id = cl.workspace_id
      where cl.workspace_id = ${workspaceId}::uuid
      group by case when cl.job_id is null then 'entry:' || cl.id::text else 'job:' || cl.job_id::text end, cl.job_id
    )
    select * from grouped
    ${after ? sql`where (at, id) < (${after.at}::timestamptz, ${after.id})` : sql``}
    order by at desc, id desc limit ${HISTORY_PAGE_SIZE + 1}
  `));
  const entries = groups.slice(0, HISTORY_PAGE_SIZE).map(historyEntry);
  return { entries, nextCursor: groups.length > HISTORY_PAGE_SIZE ? encodeCursor(entries[entries.length - 1]) : null };
}
export function creditHistoryCsv(entries: readonly CreditHistoryEntry[]): string {
  return "date,description,credits,status\n" + entries.map((entry) => [
    csvField(entry.at), csvField(entry.label), csvField(String(entry.credits), { numeric: true }),
    csvField(entry.held ? "Held while the pack runs" : "Complete"),
  ].join(",")).join("\n") + "\n";
}
export function demoCreditHistory(): HistoryPage {
  return { entries: [
    { id: "demo-pack", at: "2026-10-01T12:00:00.000Z", credits: -8, label: "Pack for Ceramic mug", jobId: null, held: false },
    { id: "demo-topup", at: "2026-10-01T11:00:00.000Z", credits: 100, label: "Top up", jobId: null, held: false },
    { id: "demo-welcome", at: "2026-10-01T10:00:00.000Z", credits: 15, label: "Welcome credits", jobId: null, held: false },
  ], nextCursor: null };
}
