import type { SpendCapPolicy } from "../caps";
export const TEST_SPEND_CAPS: SpendCapPolicy & { globalDailyHardStopMicros: number } = {
  perImageAssetMicros: 600_000, perVideoAssetMicros: 3_000_000, perPackMicros: 8_000_000,
  workspaceDailyMultiplier: 3, globalDailyAlertMicros: 50_000_000, globalDailyHardStopMicros: 150_000_000,
};
