import { safeNextPath } from "@/lib/safe-next";

/** Supabase's RedirectTo is a full callback URL with its own query string. */
export function confirmationTarget(raw: string | null, origin: string): { next: string; params: URLSearchParams } {
  const fallback = { next: "/app", params: new URLSearchParams() };
  if (!raw || raw.length > 8192 || /[\\\u0000-\u001f\u007f]/.test(raw)) return fallback;
  if (!raw.startsWith("/") && !/^https?:\/\//i.test(raw)) return fallback;
  try {
    const url = new URL(raw, origin);
    if (url.origin !== new URL(origin).origin || url.username || url.password) return fallback;
    if (url.pathname === "/auth/callback" || url.pathname === "/auth/confirm") {
      return { next: safeNextPath(url.searchParams.get("next"), origin), params: url.searchParams };
    }
    return { next: safeNextPath(`${url.pathname}${url.search}${url.hash}`, origin), params: new URLSearchParams() };
  } catch {
    return fallback;
  }
}
