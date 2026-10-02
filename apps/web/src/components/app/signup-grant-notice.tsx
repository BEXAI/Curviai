import { isDbMode } from "@/lib/services";
import { getDb } from "@/lib/services/db";
import { getSessionUser } from "@/lib/supabase/server";

export async function SignupGrantNotice() {
  try {
    if (!isDbMode()) return null;
    const user = await getSessionUser();
    if (!user) return null;
    const grant = await getDb().query.signupGrants.findFirst({
      columns: { withheldReason: true }, where: (t, { eq }) => eq(t.userId, user.id),
    });
    if (grant?.withheldReason !== "disposable_email") return null;
    return <p role="status" className="my-4 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950">Temporary inboxes cannot receive free credits. Please use an address you keep.</p>;
  } catch { return null; }
}
