import { cache } from "react";
import { isOperator } from "@/lib/ops";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/** Verify both the account and the signed session before trusting its MFA level. */
export const getOperatorSession = cache(async () => {
  try {
    const supabase = await createSupabaseServerClient();
    if (!supabase) return null;
    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user || !isOperator(user)) return null;
    const { data, error } = await supabase.auth.getClaims();
    if (error || !data || data.claims.sub !== user.id) return null;
    const aal = data.claims.aal;
    if (aal !== "aal1" && aal !== "aal2") return null;
    return {
      user,
      aal: aal as "aal1" | "aal2",
      hasVerifiedFactor: user.factors?.some((factor) => factor.status === "verified") ?? false,
      supabase,
    };
  } catch {
    return null;
  }
});
