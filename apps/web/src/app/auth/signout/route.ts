import { NextResponse, type NextRequest } from "next/server";
import { sameOriginOrRefuse } from "@/lib/http/same-origin";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/** Signs the current user out and returns to the homepage. A post from
 * another site is refused, so no page elsewhere can sign a seller out. */
export async function POST(request: NextRequest) {
  const crossSite = sameOriginOrRefuse(request);
  if (crossSite) {
    return crossSite;
  }
  const supabase = await createSupabaseServerClient();
  if (supabase) {
    await supabase.auth.signOut();
  }
  return NextResponse.redirect(new URL("/", new URL(request.url).origin), { status: 303 });
}
