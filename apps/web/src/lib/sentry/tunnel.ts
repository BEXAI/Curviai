import type { ErrorEvent } from "@sentry/nextjs";
import { createScrubber } from "./scrub";

/** The browser may send errors only to the single configured Sentry project. */
export function prepareErrorEnvelope(raw: string, configuredDsn: string | undefined): { url: string; body: string } | null {
  try {
    if (!configuredDsn) return null;
    const dsn = new URL(configuredDsn);
    if (dsn.protocol !== "https:" || !/^[a-z0-9.-]+\.ingest(?:\.[a-z]+)?\.sentry\.io$/.test(dsn.hostname) || dsn.port || dsn.password) return null;
    const project = dsn.pathname.slice(1);
    if (!/^\d+$/.test(project) || !/^[a-f0-9]+$/i.test(dsn.username)) return null;
    const lines = raw.trimEnd().split("\n");
    // Error-only telemetry: no attachments, replay, profiles or arbitrary items.
    if (lines.length !== 3) return null;
    const header = JSON.parse(lines[0]!);
    const item = JSON.parse(lines[1]!);
    const event = JSON.parse(lines[2]!);
    if (header.dsn !== configuredDsn || item.type !== "event" || !event || typeof event !== "object" || Array.isArray(event)) return null;
    if (event.type && event.type !== "error") return null;
    const scrubbed = createScrubber({}).scrubEvent(event as ErrorEvent);
    const payload = JSON.stringify(scrubbed);
    return {
      url: `${dsn.origin}/api/${project}/envelope/?sentry_key=${dsn.username}&sentry_version=7`,
      body: `${JSON.stringify({ dsn: configuredDsn })}\n${JSON.stringify({ type: "event", length: Buffer.byteLength(payload) })}\n${payload}`,
    };
  } catch { return null; }
}
