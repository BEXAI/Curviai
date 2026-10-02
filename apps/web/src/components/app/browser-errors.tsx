"use client";
import { useEffect } from "react";
export function BrowserErrors() {
  useEffect(() => {
    if (process.env.NEXT_PUBLIC_SENTRY_DSN) void import("@/lib/sentry/browser").then((m) => m.initializeBrowserErrors()).catch(() => {});
  }, []);
  return null;
}
