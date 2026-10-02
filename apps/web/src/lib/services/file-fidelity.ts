import { readStoredFidelity, type StoredFidelity } from "@curvi/pipeline/fidelity-record";
import { complianceForVariant } from "@/lib/compliance-report";

/** Exact post-packaging proof, including picked variations and followups. */
export function fidelityForVariant(raw: unknown, variant: {
  workspaceId: string; jobId: string; r2Key: string; filename: string; channelSpecId: string;
}, qc?: Record<string, unknown> | null): StoredFidelity | null {
  return readStoredFidelity(complianceForVariant(raw, variant, qc)?.fidelity);
}
