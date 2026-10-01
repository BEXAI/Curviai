import { siteUrl } from "@/lib/env";

/**
 * The origin a browser should be sent back to. Behind Render's proxy,
 * request.url and request.nextUrl carry the container's own bind address
 * (http://0.0.0.0:10000), so a redirect built from them leaves the site.
 * The browser's Host (or the proxy's X-Forwarded-Host) is the real one.
 *
 * To keep a forged Host header from turning a redirect into an open
 * redirect, a host is trusted only when it is the configured site's host
 * (NEXT_PUBLIC_SITE_URL) or a local development host; anything else falls
 * back to the configured site.
 */
export function publicOrigin(request: { url: string; headers: Headers }): string {
  const configured = new URL(siteUrl());
  const host = (request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? "").split(",")[0].trim();
  const forwardedProto = request.headers.get("x-forwarded-proto")?.split(",")[0].trim();
  const hostname = host.replace(/:\d+$/, "").toLowerCase();
  const local = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
  if (host && (hostname === configured.hostname || local)) {
    const proto = forwardedProto === "https" || forwardedProto === "http" ? forwardedProto : local ? "http" : configured.protocol.replace(":", "");
    return `${proto}://${host}`;
  }
  return configured.origin;
}
