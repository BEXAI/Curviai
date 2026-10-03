import { describe, expect, it } from "vitest";
import { buildComplianceReportView, pickedComplianceReport } from "./compliance-report";
import { fidelityForVariant } from "./services/file-fidelity";

const old = { file: "photo.jpg", channel: "shopify", specId: "shopify.product", checks: [{ name: "bytes", pass: true, measured: 100, limit: "<= 200" }], pass: true };
const original = { workspaceId: "w", jobId: "j", assetId: "a1", r2Key: "ws/w/jobs/j/files/shopify/photo.jpg", filename: "photo.jpg", channelSpecId: "shopify.product", picked: true };
const variation = { ...original, assetId: "a2", r2Key: "ws/w/jobs/j/files/variation-2/shopify/photo.jpg" };
const fidelity = { meanDeltaE: 0.84, maxDeltaE: 3.2, exactByteShare: 0.4123, maskArea: 52000, threshold: 3, maxDeltaELimit: 10, kind: "main", exact: false };

describe("picked compliance reports", () => {
  it.each([undefined, 1, 2])("preserves the stored version %s and nested metadata while replacing only picked files", (version) => {
    const fresh = { ...old, ref: "picked-ref", checks: [{ ...old.checks[0], measured: 150, provenance: { method: "pixel-check" } }] };
    const raw = { ...(version === undefined ? {} : { version }), channels: ["shopify"], files: [old],
      intent: { featured: ["Mug"], removed: [], futureIntent: { sellerConfirmed: true } },
      inventory: [{ photo: 1, items: [{ label: "Mug", color: "blue", shape: "round", status: "featured", confidence: 0.99 }] }],
      dropped: [{ file: "extra.jpg", channel: "shopify", specId: "shopify.product", reason: "file limit", ref: "dropped-ref", futureReason: { limit: 8 } }],
      producer: { revision: "future-compatible" },
    };
    const selected = pickedComplianceReport(raw, [{ ...original, picked: false }, variation],
      [{ id: variation.assetId, qc: { fileReports: { [variation.r2Key]: fresh } } }]);
    expect(selected).toEqual({ ...raw, files: [fresh] });
    if (version === undefined) expect(selected).not.toHaveProperty("version");
  });

  it("follows picks using each exact delivered file's checks, including followups", () => {
    const fresh = { ...old, checks: [{ name: "bytes", pass: true, measured: 150, limit: "<= 200" }], fidelity };
    const qc = { fileReports: { [variation.r2Key]: fresh } };
    const selected = pickedComplianceReport({ files: [old] }, [{ ...original, picked: false }, variation], [{ id: "a2", qc }]);
    const view = buildComplianceReportView(selected, { jobId: "j", productTitle: "Mug" });
    expect(view?.summary.files).toBe(1);
    expect(selected?.files[0].checks[0].measured).toBe(150);
    expect(fidelityForVariant({ files: [old] }, variation, qc)).toEqual(fidelity);
    const switched = pickedComplianceReport({ files: [old] }, [original, { ...variation, picked: false }], [{ id: "a2", qc }]);
    expect(switched?.files[0].checks[0].measured).toBe(100);
  });
  it("does not reuse original checks for a same-named version or a foreign key", () => {
    const report = pickedComplianceReport({ files: [old] }, [variation], []);
    expect(report?.files[0]).toMatchObject({ pass: false, checks: [{ name: "checksUnavailable", pass: false }] });
    expect(fidelityForVariant(null, { ...variation, workspaceId: "other" }, { fileReports: { [variation.r2Key]: { ...old, fidelity } } })).toBeNull();
    expect(pickedComplianceReport(null, [variation], [])).toBeNull();
  });
});
