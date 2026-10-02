import { NextResponse } from "next/server";
import { checkCronAuth } from "@/lib/cron-auth";
import { runTick } from "@/lib/cron-tick";
import { isDbMode } from "@/lib/services";
import { getDb } from "@/lib/services/db";
export const dynamic="force-dynamic";
export async function POST(request:Request):Promise<NextResponse> {
  const auth=checkCronAuth(request.headers);
  const headers={"cache-control":"no-store"};
  if(auth!=="ok")return NextResponse.json({error:"Not authorized or configured."},{status:auth==="denied"?401:503,headers});
  if(!isDbMode())return NextResponse.json({ok:true,skipped:"No database."},{headers});
  try {
    const report=await runTick({db:getDb()});
    const ok=report.status!=="stuck" && report.failed.length===0 && !report.budgetExhausted;
    return NextResponse.json({ok,...report},{status:ok?200:503,headers});
  } catch {return NextResponse.json({error:"The scheduled run did not finish."},{status:503,headers});}
}
