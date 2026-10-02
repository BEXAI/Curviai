import { readBodyLimited } from "@/lib/http/read-body";
import { limitByIp } from "@/lib/rate-limit";
import { prepareErrorEnvelope } from "@/lib/sentry/tunnel";

export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  const denied = await limitByIp(request, "telemetry.error");
  if (denied) return denied;
  const body = await readBodyLimited(request, 256 * 1024);
  if (!body.ok) return new Response(null, { status: body.reason === "too_large" ? 413 : 400 });
  const envelope = prepareErrorEnvelope(body.text, process.env.NEXT_PUBLIC_SENTRY_DSN);
  if (!envelope) return new Response(null, { status: 400 });
  try {
    await fetch(envelope.url, { method: "POST", headers: { "content-type": "application/x-sentry-envelope" }, body: envelope.body,
      redirect: "error", signal: AbortSignal.timeout(2000) });
  } catch { /* Telemetry must not expose payloads or interrupt the product. */ }
  return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
}
