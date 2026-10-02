/**
 * The web app's door to the server side funnel (docs/phases/PHASE_18.md
 * P18-02): recordFunnelEvent from @curvi/db over the owner connection in db
 * mode, nothing in demo mode. Never throws and never waits on anything but
 * the one insert (two for a first step), so a funnel row can never break or
 * slow the action it records beyond that.
 *
 * Code that already holds the owner connection (the services layer, the
 * runner store) calls recordFunnelEvent directly instead.
 */

import { recordFunnelEvent, type Db, type FunnelEventInput, type FunnelRecordResult } from "@curvi/db";
import { isDbMode } from "@/lib/services";
import { getDb } from "@/lib/services/db";

const NOT_RECORDED: FunnelRecordResult = { recorded: false, firstRecorded: false };

export async function recordFunnel(input: FunnelEventInput, db?: Db): Promise<FunnelRecordResult> {
  try {
    if (!db && !isDbMode()) {
      return NOT_RECORDED;
    }
    return await recordFunnelEvent(db ?? getDb(), input);
  } catch (err) {
    console.error(
      JSON.stringify({
        level: "error",
        event: "funnel_event_failed",
        name: input.name,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return NOT_RECORDED;
  }
}
