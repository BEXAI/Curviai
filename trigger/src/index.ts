/**
 * @curvi/trigger public surface: the Trigger.dev tasks plus the pure modules
 * they wrap (state machine, pipeline runner, churn scorer, drop planner,
 * digest composer and the demo runtime wiring).
 */

export * from "./state";
export * from "./churn";
export * from "./drops";
export * from "./digest";
export * from "./pipeline-runner";
export * from "./runtime";
export * from "./db-store";
export * from "./db-runtime";
export * from "./r2";
export * from "./recipes";

export { generatePack } from "./tasks/generate-pack";
export { generateShot, type GenerateShotPayload } from "./tasks/generate-shot";
export {
  weeklyDrop,
  DemoDropWorkspaceReader,
  type DropWorkspaceReader,
} from "./tasks/weekly-drop";
export {
  churnScore,
  DemoChurnSignalReader,
  type ChurnSignalReader,
  type ChurnScoreRunResult,
} from "./tasks/churn-score";
export { metricsDigest, type MetricsDigestRunResult } from "./tasks/metrics-digest";
