"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { webhookAction } from "@/app/app/settings/webhooks/actions";
import type { DeliveryView, EndpointView, WebhookActionResult } from "@/lib/webhooks/db-store";

export function WebhooksPanel({ endpoints, deliveries, configured }: { endpoints: EndpointView[]; deliveries: DeliveryView[]; configured: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<WebhookActionResult | null>(null);
  const run = (input: Parameters<typeof webhookAction>[0]) => {
    setResult(null);
    startTransition(async () => {
      try { setResult(await webhookAction(input)); router.refresh(); }
      catch { setResult({ ok: false, notice: "The request could not finish. Reload and try again." }); }
    });
  };
  const style = "rounded border border-ink-300 px-3 py-2 text-sm disabled:opacity-50";
  return <div className="ph-no-capture ph-mask space-y-8" data-testid="webhook-private-panel">
    {!configured && <p role="status">Webhook signing is not configured. Endpoint creation and activation are unavailable.</p>}
    <form className="space-y-3" onSubmit={event => { event.preventDefault(); const data = new FormData(event.currentTarget); run({ action: "create", name: String(data.get("name") ?? ""), url: String(data.get("url") ?? "") }); }}>
      <h2 className="text-lg font-semibold">Add a receiver</h2>
      <label className="block">Name<input className="mt-1 block w-full rounded border p-2" name="name" maxLength={80} required disabled={!configured || pending} /></label>
      <label className="block">HTTPS receiver URL<input className="mt-1 block w-full rounded border p-2" name="url" type="url" maxLength={2048} placeholder="https://example.com/curvi/events" required disabled={!configured || pending} /></label>
      <p className="text-sm text-ink-600">Use a receiver you control. Credentials, query strings and private addresses are not accepted. Saving keeps delivery disabled.</p>
      <button className={style} disabled={!configured || pending} type="submit">Save disabled receiver</button>
    </form>
    {result && <div role={result.ok ? "status" : "alert"} aria-live="polite" className="rounded border p-4">
      <p>{result.notice}</p>
      {result.secret && <div className="mt-3 space-y-2"><p>Signing secret, shown once</p><code className="block break-all" data-testid="webhook-secret">{result.secret}</code><p>Key ID: <code>{result.keyId}</code></p><p>Store this in your receiver before leaving this page.</p></div>}
    </div>}
    <section className="space-y-4" aria-label="Webhook receivers"><h2 className="text-lg font-semibold">Receivers</h2>
      {!endpoints.length && <p>No receivers yet.</p>}
      {endpoints.map(endpoint => <article key={endpoint.id} className="space-y-2 rounded border p-4">
        <h3 className="font-semibold">{endpoint.name}</h3><p className="break-all text-sm">{endpoint.url}</p>
        <p>{endpoint.enabled ? "Active" : "Disabled"} · {endpoint.verified ? "Verified" : "Needs verification"}</p>
        <div className="flex flex-wrap gap-2">
          {!endpoint.enabled && <button className={style} disabled={pending || !configured} onClick={() => run({ action: "verify", id: endpoint.id })}>Verify and activate</button>}
          {endpoint.enabled && <button className={style} disabled={pending} onClick={() => run({ action: "disable", id: endpoint.id })}>Disable</button>}
          <button className={style} disabled={pending || !configured} onClick={() => run({ action: "rotate", id: endpoint.id })}>Replace signing key</button>
          <button className={style} disabled={pending} onClick={() => run({ action: "delete", id: endpoint.id })}>Delete receiver</button>
        </div>
        {!endpoint.enabled && <p className="text-sm text-ink-600">Verify and activate sends one signed challenge to this URL. A correct response enables future completion events.</p>}
      </article>)}
    </section>
    <section className="space-y-3" aria-label="Webhook delivery history"><h2 className="text-lg font-semibold">Recent deliveries</h2>
      {!deliveries.length && <p>No deliveries yet.</p>}
      {deliveries.map(delivery => <article key={delivery.id} className="space-y-2 rounded border p-4"><p>{delivery.endpointName}: {delivery.status}</p><p className="text-sm">Attempts: {delivery.attempts}. Event ID: <code>{delivery.eventId}</code></p>
        {delivery.lastError && <p className="text-sm">Last result: {delivery.lastError.replaceAll("_", " ")}</p>}
        <a href={`/app/jobs/${delivery.jobId}`} className="text-sm underline">View pack</a>
        {["succeeded", "exhausted", "canceled"].includes(delivery.status) && <button className={`${style} ml-3`} disabled={pending || !configured} onClick={() => run({ action: "replay", id: delivery.id })}>Replay event</button>}
      </article>)}
    </section>
  </div>;
}
