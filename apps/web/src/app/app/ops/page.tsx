import { randomUUID } from "node:crypto";
import Link from "next/link";
import { costCaps, opsGrants } from "@curvi/pipeline/seed";
import { requireOperator } from "@/lib/ops/access";
import { loadOpsOverview } from "@/lib/ops/overview";
import { isDbMode } from "@/lib/services";
import { getDb } from "@/lib/services/db";
import { changeSwitch, grantWorkspaceCredits, providerAction } from "./actions";

const inputClass = "rounded border border-ink-200 px-3 py-2 text-sm";
const dollars = (micros: number) => `$${(micros / 1000000).toFixed(2)}`;

export default async function OpsOverviewPage() {
  await requireOperator();
  if (!isDbMode()) return <p>Connect the database to view operations.</p>;
  const view = await loadOpsOverview(getDb());
  return <div className="space-y-8"><header><h1 className="text-2xl font-semibold">Operations</h1><p className="mt-2">Status: <strong>{view.health.status}</strong>. Commit {view.health.commit ?? "unknown"}. Uptime {Math.floor(view.health.uptimeSeconds / 60)} minutes.</p>
    <p className="text-sm text-ink-600">Memory {(view.report.runtime.memory.rssBytes / 1048576).toFixed(0)} MiB. Runner: {view.health.packs ? `${view.health.packs.running} running, ${view.health.packs.waiting} waiting, ${view.health.packs.overdue} overdue` : "idle"}.</p>
    {view.health.degradedBy.length ? <p className="text-sm text-amber-700">{view.health.degradedBy.join(", ")}</p> : null}
    {view.report.warnings.length ? <ul className="mt-3 list-disc pl-5 text-sm">{view.report.warnings.map((warning) => <li key={warning.code}>{warning.message} <span className="text-ink-500">({warning.code})</span></li>)}</ul> : <p>All reported checks passed.</p>}</header>
    <section><h2 className="text-lg font-semibold">Spend today</h2><p>{dollars(view.spendMicros)} spent. Alert at {dollars(costCaps.globalDailyAlertMicros)}. Hard stop {dollars(view.hardStopMicros)}.</p></section>
    <section><h2 className="text-lg font-semibold">Switches</h2><div className="mt-3 grid gap-3 lg:grid-cols-2">{view.switches.map((entry) => {
      const on = typeof entry.value === "object" && entry.value ? entry.value.on : entry.value;
      return <form action={changeSwitch} key={entry.key} className="space-y-2 rounded border p-4"><input type="hidden" name="key" value={entry.key} /><label className="block text-sm font-medium">{entry.key}
        {entry.kind === "usd" ? <input className={`${inputClass} mt-2 block w-full`} name="value" type="number" min="0" step="0.01" defaultValue={typeof entry.value === "number" ? entry.value : ""} placeholder="Use configured default" />
          : <select className={`${inputClass} ml-3`} name="value" defaultValue={String(on)}><option value="true">On</option><option value="false">Off</option></select>}</label>
        {entry.kind === "flag" ? <label className="block text-sm">Seller message <input name="message" maxLength={200} className={`${inputClass} block w-full`} defaultValue={typeof entry.value === "object" && entry.value ? entry.value.message ?? "" : ""} /></label> : null}
        <button className={inputClass}>Save switch</button></form>;
    })}</div></section>
    <section><h2 className="text-lg font-semibold">Grant credits</h2><p className="text-sm text-ink-600">Up to {opsGrants.maxCreditsPerGrant} credits per adjustment and {opsGrants.maxCreditsPerMonth} granted per month. A negative adjustment removes unused credits.</p>
      <form action={grantWorkspaceCredits} className="mt-3 flex flex-wrap items-end gap-3"><input type="hidden" name="key" value={randomUUID()} />
        <label>Workspace <input className={`${inputClass} block`} name="workspaceId" required /></label><label>Credits <input className={`${inputClass} block`} type="number" step="0.1" name="credits" required /></label><label>Internal note <input className={`${inputClass} block`} name="note" maxLength={120} required /></label>
        <label><input type="checkbox" name="confirm" value="yes" required /> Confirm adjustment</label><button className={inputClass}>Apply credits</button>
      </form></section>
    <section><h2 className="text-lg font-semibold">Providers</h2><p className="text-sm text-ink-600">Probe now respects the configured canary switch and spend limits. Reset records a recovery override without calling a provider.</p><ul className="mt-2 space-y-3">{view.providers.map((provider) => <li key={provider.name} className="rounded border p-3"><p>{provider.name}: {provider.reason ? `breaker open (${provider.reason})` : "breaker closed"}.</p>
      <p className="text-xs text-ink-500">Last probe: {provider.probe?.at ? new Date(provider.probe.at).toISOString() : "not recorded"}. Result: {provider.probe ? provider.probe.ok ? "passed" : "failed" : "unknown"}. Reset: {provider.probe?.resetAt ? new Date(provider.probe.resetAt).toISOString() : "never"}.</p>
      <form action={providerAction} className="mt-2 flex flex-wrap items-center gap-3"><input type="hidden" name="provider" value={provider.name} /><label><input type="checkbox" name="confirm" value="yes" required /> Confirm</label><button className={inputClass} name="action" value="reset">Reset</button><button className={inputClass} name="action" value="probe">Probe now</button></form>
    </li>)}</ul>
      {view.report.falBalances?.map((balance) => <pre key={JSON.stringify(balance)} className="mt-2 overflow-auto rounded bg-ink-50 p-2 text-xs">{JSON.stringify(balance, null, 2)}</pre>)}</section>
    <section><h2 className="text-lg font-semibold">Open alerts</h2>{view.alerts.length ? <ul className="mt-2 space-y-2">{view.alerts.map((alert) => <li key={alert.id}>{alert.rule}: {alert.subject} ({alert.count})</li>)}</ul> : <p>No open alerts.</p>}</section>
    <section><h2 className="text-lg font-semibold">Packs in the past 24 hours</h2><ul className="mt-2">{view.packs.map((pack) => <li key={pack.status}>{pack.status}: {pack.count}. Median {pack.p50 === null ? "unknown" : `${Math.round(pack.p50)}s`}, p95 {pack.p95 === null ? "unknown" : `${Math.round(pack.p95)}s`}.</li>)}</ul><Link href="/app/ops/jobs" className="underline">Inspect packs</Link></section>
    <section><h2 className="text-lg font-semibold">Scheduled jobs and recovery</h2><ul className="mt-2 space-y-2">{view.report.crons?.map((cron) => <li key={cron.name}><pre className="overflow-auto text-xs">{JSON.stringify(cron)}</pre></li>)}</ul>
      {view.monitoring.map((setting) => <p key={setting.key} className="break-all text-xs">{setting.key}: {JSON.stringify(setting.value)}</p>)}</section>
    <section><h2 className="text-lg font-semibold">Database tables</h2><p>{view.report.databaseSize ? `${(view.report.databaseSize.bytes / 1048576).toFixed(1)} MiB in use` : "Size unavailable"}</p><ul>{view.tables.map((table) => <li key={table.name}>{table.name}: {(Number(table.bytes) / 1048576).toFixed(1)} MiB</li>)}</ul></section>
    <section><h2 className="text-lg font-semibold">CSP reports today</h2>{view.csp.length ? <ul>{view.csp.map((row) => <li key={row.key}>{row.key}: {row.total_micros}</li>)}</ul> : <p>No reports recorded today.</p>}</section>
  </div>;
}
