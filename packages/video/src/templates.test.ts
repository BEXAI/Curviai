import { hasSpec } from "@curvi/specs";
import { describe, expect, it } from "vitest";
import {
  assertTemplateSpecsExist,
  getVideoTemplate,
  listVideoTemplates,
  templateCompositionIds,
  videoTemplates,
} from "./templates";

describe("video template descriptors", () => {
  it("defines the four planned templates", () => {
    expect(videoTemplates.map((t) => t.id).sort()).toEqual([
      "dimension_reveal",
      "feature_callouts",
      "slideshow",
      "spin360",
    ]);
  });

  it("uses unique ids, composition ids and credits keys", () => {
    const ids = videoTemplates.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    const compositionIds = videoTemplates.map((t) => t.compositionId);
    expect(new Set(compositionIds).size).toBe(compositionIds.length);
    const creditsKeys = videoTemplates.map((t) => t.creditsKey);
    expect(new Set(creditsKeys).size).toBe(creditsKeys.length);
  });

  it("references only real channel specs", () => {
    for (const template of videoTemplates) {
      expect(template.targetSpecIds.length).toBeGreaterThan(0);
      for (const specId of template.targetSpecIds) {
        expect(hasSpec(specId), `${template.id} references ${specId}`).toBe(true);
      }
    }
    expect(() => assertTemplateSpecsExist()).not.toThrow();
  });

  it("points every template at a registered composition id", () => {
    for (const template of videoTemplates) {
      expect(templateCompositionIds).toContain(template.compositionId);
    }
  });

  it("supports both canvas formats and carries no prices", () => {
    for (const template of videoTemplates) {
      expect(template.formats).toContain("9x16");
      expect(template.formats).toContain("1x1");
      expect(template.creditsKey).not.toMatch(/\$|\d+\.\d+/);
    }
  });

  it("looks templates up by id and rejects unknown ids", () => {
    expect(getVideoTemplate("spin360").compositionId).toBe("Spin360");
    expect(() => getVideoTemplate("nope")).toThrow(/Unknown video template/);
    expect(listVideoTemplates()).toHaveLength(4);
  });
});
