import { timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { optionalEnv } from "@/lib/env";

/** Cloudflare must overwrite this header with the configured shared proof. */
export const PROXY_PROOF_HEADER = "x-curvi-proxy-secret";

function matchesProof(actual: string | null, expected: string | undefined): boolean {
  if (!actual || !expected) return false;
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function address(value: string | null | undefined): string | null {
  const candidate = value?.trim();
  return candidate && isIP(candidate) ? candidate : null;
}

/** Only a proxy-authenticated configured header may override Render's last hop. */
export function clientIp(headers: Headers): string {
  const configured = optionalEnv("CLIENT_IP_HEADER")?.toLowerCase() ?? "x-forwarded-for";
  const forwarded = headers.get("x-forwarded-for")?.split(",").at(-1);
  if (configured === "x-forwarded-for") return address(forwarded) ?? "unknown";
  if (matchesProof(headers.get(PROXY_PROOF_HEADER), optionalEnv("CLIENT_IP_PROXY_SECRET"))) {
    const trusted = address(headers.get(configured));
    if (trusted) return trusted;
  }
  return address(forwarded) ?? "unknown";
}

function maskedPrefix(value: string | null | undefined): string | null {
  const ip = address(value);
  if (!ip) return null;
  if (isIP(ip) === 4) return `${ip.split(".").slice(0, 3).join(".")}.0/24`;
  try {
    // URL canonicalization also converts IPv4-mapped addresses to hex.
    const normalized = new URL(`http://[${ip}]/`).hostname.slice(1, -1);
    const [left, right] = normalized.split("::");
    const a = left ? left.split(":") : [];
    const b = right ? right.split(":") : [];
    const groups = normalized.includes("::") ? [...a, ...Array(8 - a.length - b.length).fill("0"), ...b] : a;
    return `${groups.slice(0, 4).join(":")}::/64`;
  } catch {
    return null;
  }
}

/** Only the authenticated health response exposes these coarse diagnostics. */
export function clientIpDiagnostics(headers: Headers) {
  return {
    selected: maskedPrefix(clientIp(headers)),
    forwardedLast: maskedPrefix(headers.get("x-forwarded-for")?.split(",").at(-1)),
    cloudflare: maskedPrefix(headers.get("cf-connecting-ip")),
    realIp: maskedPrefix(headers.get("x-real-ip")),
    proxyProofAccepted: matchesProof(headers.get(PROXY_PROOF_HEADER), optionalEnv("CLIENT_IP_PROXY_SECRET")),
  };
}

/** Refuse an alternate origin in production, including the direct Render host. */
export function requestHostAllowed(request: Request): boolean {
  if (optionalEnv("NODE_ENV") !== "production") return true;
  const site = optionalEnv("NEXT_PUBLIC_SITE_URL");
  if (!site) return optionalEnv("ALLOW_DEMO_MODE") === "1";
  try {
    const configured = new URL(site);
    const host = request.headers.get("host") ?? new URL(request.url).host;
    return host.toLowerCase() === configured.host.toLowerCase();
  } catch {
    return false;
  }
}
