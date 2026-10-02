import { describe, expect, it } from "vitest";
import { fidelityForVariant } from "./file-fidelity";
const fidelity = { meanDeltaE: 0.84, maxDeltaE: 3.2, exactByteShare: 0.4123, maskArea: 52000, threshold: 3, maxDeltaELimit: 10, kind: "main", exact: false };
const file = { file: "main.jpg", channel: "amazon", specId: "amazon.main", pass: true, fidelity };
const variant = { workspaceId: "ws", jobId: "job", r2Key: "ws/ws/jobs/job/files/amazon/main.jpg", filename: "main.jpg", channelSpecId: "amazon.main" };
describe("exact delivered-file fidelity", () => {
  it("returns only the matching report measurement", () => {
    expect(fidelityForVariant({ files: [file] }, variant)).toEqual(fidelity);
    expect(fidelityForVariant({ files: [{ ...file, specId: "amazon.secondary" }] }, variant)).toBeNull();
    expect(fidelityForVariant({ files: [file, file] }, variant)).toBeNull();
  });
  it("never attributes the original metrics to a variation or followup with the same name", () => {
    for (const r2Key of ["ws/ws/jobs/job/files/amazon/variation-2/main.jpg", "ws/ws/jobs/job/followups/run/amazon/main.jpg", "ws/another/jobs/job/files/amazon/main.jpg"]) {
      expect(fidelityForVariant({ files: [file] }, { ...variant, r2Key })).toBeNull();
    }
    expect(fidelityForVariant(null, variant)).toBeNull();
    expect(fidelityForVariant({ files: [{ ...file, fidelity: { meanDeltaE: 0 } }] }, variant)).toBeNull();
  });
});
