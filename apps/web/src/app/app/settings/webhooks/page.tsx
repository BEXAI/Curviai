import type { Metadata } from "next";
import Link from "next/link";
import { WebhooksPanel } from "@/components/app/webhooks-panel";
import { listWebhooks } from "@/lib/webhooks/db-store";
import { webhookSession } from "@/lib/webhooks/session";
export const metadata: Metadata = { title: "Completion webhooks" };
export const dynamic = "force-dynamic";
export default async function WebhooksPage() {
  const session = await webhookSession();
  return <div className="mx-auto max-w-3xl space-y-8">
    <div><Link href="/app/settings" className="text-sm underline">Settings</Link><h1 className="mt-2 text-2xl font-bold">Completion webhooks</h1>
      <p className="mt-2 text-ink-600">Receive a private event when a pack run ends. Delivery uses the existing scheduler, normally checked every 10 minutes, and may arrive later during retries. Events can repeat or arrive out of order.</p></div>
    {!session.ok ? <p role="status">{session.notice}</p> : <WebhooksPanel {...await listWebhooks(session.db, session.actor)} configured={!!session.keys?.length} />}
    <section className="space-y-3 text-sm" aria-label="Receiver contract"><h2 className="text-lg font-semibold">Receiver contract</h2>
      <p>Handle <code>pack.run.terminal</code> version 1. Deduplicate by event ID. Use <code>pack_path</code> with your own authorized Curvi API key to fetch current pack details. Events contain no images, download links or credentials.</p>
      <p><code>outcome</code> describes the run. <code>pack_status</code> describes pack availability. A failed or canceled follow up can leave an earlier pack available. A terminal event does not promise that final credit settlement has completed.</p>
      <p>Verify HMAC SHA256 over the exact UTF-8 bytes of <code>curvi:webhook:v1:TIMESTAMP:KEY_ID:BODY</code> using your signing secret. Read timestamp, key ID and <code>v1=HEX</code> signature from <code>curvi-webhook-timestamp</code>, <code>curvi-webhook-key-id</code> and <code>curvi-webhook-signature</code>. Reject unknown keys and timestamps more than five minutes old or more than five minutes in the future. Compare signatures in constant time before parsing JSON.</p>
      <p>For <code>webhook.verify</code>, verify the signed request, then return status 200 and header <code>curvi-webhook-verification</code> with the hexadecimal HMAC SHA256 of <code>curvi:webhook:verify:v1:CHALLENGE</code>. Use the same signing secret. No response body is needed.</p>
      <p>Return any 2xx response after accepting a completion. Curvi tries up to six times over 72 hours. Owners and admins can request up to two replays before expiry, each keeping the event ID. Delivery history is kept for up to 30 days. Disabling cancels queued deliveries; a request already in flight may finish.</p>
    </section>
  </div>;
}
