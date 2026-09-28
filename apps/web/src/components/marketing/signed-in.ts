"use client";

import { useEffect, useState } from "react";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

/** The slice of the Supabase browser client the header reads. */
export interface AuthSessionSource {
  auth: {
    getSession(): Promise<{ data: { session: unknown } }>;
    onAuthStateChange(callback: (event: string, session: unknown) => void): {
      data: { subscription: { unsubscribe(): void } };
    };
  };
}

/**
 * Reports whether a browser session exists, once now and again whenever
 * auth changes (sign in, sign out, another tab). Returns a stop function.
 * Without a client (Supabase not configured) the visitor stays signed out.
 * Only navigation reads this; /app and the APIs check the user server side.
 */
export function watchSignedIn(client: AuthSessionSource | null, onChange: (signedIn: boolean) => void): () => void {
  if (!client) {
    return () => {};
  }
  let active = true;
  void client.auth
    .getSession()
    .then(({ data }) => {
      if (active) {
        onChange(Boolean(data.session));
      }
    })
    .catch(() => {
      // A failed read leaves the signed out links, which still work.
    });
  const { data } = client.auth.onAuthStateChange((_event, session) => {
    if (active) {
      onChange(Boolean(session));
    }
  });
  return () => {
    active = false;
    data.subscription.unsubscribe();
  };
}

/**
 * True once the browser has a Supabase session. Starts false, so the static
 * marketing pages render the signed out links and switch after hydration.
 */
export function useSignedIn(): boolean {
  const [signedIn, setSignedIn] = useState(false);
  useEffect(() => watchSignedIn(createSupabaseBrowserClient(), setSignedIn), []);
  return signedIn;
}
