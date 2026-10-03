import { lookup } from "node:dns/promises";
import { request, type RequestOptions } from "node:https";
import { BlockList, isIP } from "node:net";
import type { ClientRequest, IncomingMessage } from "node:http";
import { webhookPolicy } from "@curvi/pipeline/seed";

export type DeliveryError = "unsafe_destination" | "dns_failed" | "timeout" | "response_too_large" | "redirect_refused" | "network_failed" | "http_error" | "key_unavailable";
export class WebhookTransportError extends Error {
  constructor(readonly code: DeliveryError) { super(code); }
}
const blocked = new BlockList();
for (const [address, prefix] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 3]] as const) blocked.addSubnet(address, prefix, "ipv4");
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");
for (const [address, prefix] of [["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["3fff::", 20]] as const) blocked.addSubnet(address, prefix, "ipv6");
export function publicAddress(address: string): boolean {
  const family = isIP(address);
  return family === 4 ? !blocked.check(address, "ipv4") : family === 6 && globalV6.check(address, "ipv6") && !blocked.check(address, "ipv6");
}
export function webhookUrl(raw: string): URL {
  let url: URL;
  try { url = new URL(raw); } catch { throw new WebhookTransportError("unsafe_destination"); }
  const host = url.hostname;
  if (raw.length > webhookPolicy.maxUrlChars || url.protocol !== "https:" || url.port && url.port !== "443" || url.username || url.password || url.search || url.hash || isIP(host) || host.includes(":") || host.endsWith(".") || !host.includes(".") || !/^[a-z0-9.-]+$/.test(host) || host.split(".").some(label => !label || label.length > 63 || label.startsWith("-") || label.endsWith("-"))) throw new WebhookTransportError("unsafe_destination");
  return url;
}
export type Resolver = (host: string) => Promise<readonly { address: string; family: number }[]>;
export type Requester = (options: RequestOptions, callback: (response: IncomingMessage) => void) => ClientRequest;
export type TransportResult = { statusCode: number; verification?: string };
export type WebhookTransport = (url: string, body: string, headers: Record<string, string>) => Promise<TransportResult>;

/** Resolve on each attempt; pin the vetted answer in lookup while HTTPS keeps
 * the original hostname for certificate verification and SNI. No pooled socket,
 * proxy, redirect, second DNS lookup or response body escapes this boundary. */
export function createWebhookTransport(deps: { resolve?: Resolver; request?: Requester; timeoutMs?: number } = {}): WebhookTransport {
  const resolve: Resolver = deps.resolve ?? (host => lookup(host, { all: true, verbatim: true }));
  const send = deps.request ?? request;
  return async (raw, body, headers) => {
    const url = webhookUrl(raw);
    if (Buffer.byteLength(body) > webhookPolicy.maxRequestBytes) throw new WebhookTransportError("unsafe_destination");
    const deadline = Date.now() + (deps.timeoutMs ?? webhookPolicy.totalTimeoutMs);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let addresses: readonly { address: string; family: number }[];
    try {
      addresses = await Promise.race([resolve(url.hostname), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new WebhookTransportError("timeout")), Math.max(1, deadline - Date.now())); })]);
    } catch (error) { throw error instanceof WebhookTransportError ? error : new WebhookTransportError("dns_failed"); }
    finally { clearTimeout(timer); }
    if (!addresses.length || addresses.some(answer => !publicAddress(answer.address) || answer.family !== isIP(answer.address))) throw new WebhookTransportError("unsafe_destination");
    if (Date.now() >= deadline) throw new WebhookTransportError("timeout");
    const pinned = addresses[0];
    return new Promise<TransportResult>((resolveResult, reject) => {
      let finished = false;
      let req: ClientRequest | undefined;
      let connectTimer: ReturnType<typeof setTimeout> | undefined;
      const fail = (code: DeliveryError) => {
        if (finished) return;
        finished = true; clearTimeout(timer); clearTimeout(connectTimer); req?.destroy(); reject(new WebhookTransportError(code));
      };
      timer = setTimeout(() => fail("timeout"), Math.max(1, deadline - Date.now()));
      try {
        req = send({ protocol: "https:", hostname: url.hostname, servername: url.hostname, port: 443, path: url.pathname, method: "POST", agent: false, family: pinned.family, ...{ autoSelectFamily: false }, rejectUnauthorized: true, maxHeaderSize: webhookPolicy.maxHeaderBytes,
          lookup: ((_hostname: string, _options: unknown, callback: (error: Error | null, address: string, family: number) => void) => callback(null, pinned.address, pinned.family)) as RequestOptions["lookup"],
          headers: { ...headers, "content-type": "application/json", "content-length": Buffer.byteLength(body), "user-agent": "Curvi-Webhooks/1" },
        }, response => {
          const code = response.statusCode ?? 0;
          if (code >= 300 && code < 400) { response.destroy(); fail("redirect_refused"); return; }
          const size = Number(response.headers["content-length"] ?? 0);
          if (size > webhookPolicy.maxResponseBytes) { response.destroy(); fail("response_too_large"); return; }
          let read = 0;
          response.on("data", (chunk: Buffer) => { read += chunk.length; if (read > webhookPolicy.maxResponseBytes) { response.destroy(); fail("response_too_large"); } });
          response.on("error", () => fail("network_failed"));
          response.on("aborted", () => fail("network_failed"));
          response.on("end", () => {
            if (finished) return;
            finished = true; clearTimeout(timer); clearTimeout(connectTimer);
            const verification = response.headers["curvi-webhook-verification"];
            resolveResult({ statusCode: code, ...(typeof verification === "string" && verification.length <= 64 ? { verification } : {}) });
          });
        });
        connectTimer = setTimeout(() => fail("timeout"), Math.min(webhookPolicy.connectTimeoutMs, Math.max(1, deadline - Date.now())));
        req.on("socket", socket => socket.once("secureConnect", () => clearTimeout(connectTimer)));
        req.on("error", () => fail("network_failed"));
        req.end(body);
      } catch { fail("network_failed"); }
    });
  };
}
export const deliverWebhook = createWebhookTransport();
