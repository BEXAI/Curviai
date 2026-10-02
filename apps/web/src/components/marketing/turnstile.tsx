"use client";

import Script from "next/script";
import { useEffect, useRef, useState } from "react";

export const turnstileEnabled = Boolean(process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY);
interface WidgetApi {
  render(node: HTMLElement, options: Record<string, unknown>): string;
  remove(id: string): void;
}

/** Remount using resetKey after every request: tokens are single use. */
export function Turnstile({ action, resetKey = 0, onToken }: { action: string; resetKey?: number; onToken: (token: string) => void }) {
  const node = useRef<HTMLDivElement>(null);
  const callback = useRef(onToken);
  callback.current = onToken;
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const api = (window as Window & { turnstile?: WidgetApi }).turnstile;
    if (!ready || !api || !node.current) return;
    callback.current("");
    setFailed(false);
    const id = api.render(node.current, {
      sitekey: process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY,
      action,
      callback: (token: string) => { setFailed(false); callback.current(token); },
      "expired-callback": () => callback.current(""),
      "error-callback": () => { callback.current(""); setFailed(true); },
    });
    return () => { api.remove(id); };
  }, [ready, resetKey, action]);
  if (!turnstileEnabled) return null;
  return <div>
    <Script src="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit" onReady={() => setReady(true)} onError={() => setFailed(true)} />
    <div ref={node} />
    {failed ? <p role="alert" className="text-sm text-red-600">We could not check that you are a person. Please reload the page and try again.</p> : null}
  </div>;
}
