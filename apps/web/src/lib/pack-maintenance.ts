import type { Db } from "@curvi/db";
import { opsSwitch } from "@/lib/features";
import { platformSettingReader } from "@/lib/platform-settings";

export const PACK_MAINTENANCE_MESSAGE = "New packs are paused for a short update. Your photos are saved. Please try again in a few minutes.";

export async function getPackMaintenance(db: Pick<Db, "select">): Promise<{
  paused: boolean;
  message: string;
  deployPending: boolean;
}> {
  const read = platformSettingReader(db);
  const [pause, deploy] = await Promise.all([
    opsSwitch("ops:packs_paused", read),
    opsSwitch("ops:deploy_pending", read),
  ]);
  return { paused: pause.on, message: PACK_MAINTENANCE_MESSAGE, deployPending: deploy.on };
}
