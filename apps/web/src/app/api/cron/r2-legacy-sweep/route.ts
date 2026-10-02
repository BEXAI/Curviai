import { NextResponse } from "next/server";
import { checkCronAuth } from "@/lib/cron-auth";
import { recordCronSuccess } from "@/lib/cron-health";
import { isR2Configured } from "@/lib/env";
import { legacyTmpStorage, sweepLegacyTemporaryObjects } from "@/lib/ops/temporary-storage";
import { isDbMode } from "@/lib/services";
import { getDb } from "@/lib/services/db";
export const dynamic="force-dynamic";
export async function POST(request:Request):Promise<NextResponse> {
  const auth=checkCronAuth(request.headers);
  if(auth!=="ok") return NextResponse.json({error:"Not authorized or configured."},{status:auth==="denied"?401:503});
  if(!isDbMode() || !isR2Configured()) return NextResponse.json({ok:true,skipped:"No database or storage."});
  try {
    const db=getDb();
    const dryRun=new URL(request.url).searchParams.get("dryRun")==="1";
    const report=await sweepLegacyTemporaryObjects({db,storage:legacyTmpStorage(),dryRun});
    if(!dryRun && report.failed===0) await recordCronSuccess(db,"r2-legacy-sweep");
    return NextResponse.json({ok:report.failed===0,report},{status:report.failed?500:200,headers:{"cache-control":"no-store"}});
  } catch { return NextResponse.json({error:"The temporary object sweep did not finish."},{status:500}); }
}
