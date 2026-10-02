/**
 * GET /r/<code>
 * An invite link (docs/phases/PHASE_18.md P18-24). While referrals are on
 * it sends the visitor to the home page carrying ref=<code> and the
 * referral UTM tags, which P18-01's signup links carry on to /signup; the
 * auth callback then records the referral. While they are off, or for a
 * malformed code, it sends the visitor to the plain home page, so an old
 * link never promises a reward that is not running. The code is not looked
 * up here: an unknown code is dropped at signup.
 */

import { NextResponse, type NextRequest } from "next/server";
import { publicOrigin } from "@/lib/http/public-origin";
import { cleanReferralCode, referralLandingPath } from "@/lib/referrals/codes";
import { referralsOn } from "@/lib/referrals/switch";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest, context: { params: Promise<{ code: string }> }): Promise<NextResponse> {
  const origin = publicOrigin(request);
  const { code: raw } = await context.params;
  const code = cleanReferralCode(raw);
  const target = code && (await referralsOn()) ? referralLandingPath(code) : "/";
  const response = NextResponse.redirect(new URL(target, origin), 302);
  response.headers.set("cache-control", "no-store");
  response.headers.set("x-robots-tag", "noindex");
  return response;
}
