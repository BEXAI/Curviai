import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  PackAssetTreatment,
  TREATMENT_NOTES,
  TREATMENT_NOTE_PREFIXES,
  parseTreatmentNote,
  treatmentNotes,
  type TreatmentNoteKey,
} from "./treatment";

describe("treatmentNotes", () => {
  it("builds exactly the plan's machine notes", () => {
    expect(treatmentNotes({ kind: "original_unchanged" })).toEqual([
      "background: kept at seller request",
      "original: unchanged file",
    ]);
    expect(
      treatmentNotes({
        kind: "original",
        reencodedAtUpload: true,
        cropped: true,
        scale: 0.5,
        sourceWidth: 4032,
        sourceHeight: 3024,
        colorConverted: true,
        alphaFilledHex: "#ffffff",
        padHex: "#1f2a44",
        otherItems: true,
      }),
    ).toEqual([
      "background: kept at seller request",
      "original: stored copy, turned upright at upload",
      "original: cropped around product",
      "original: resized from 4032x3024",
      "original: color converted to srgb",
      "original: transparent areas filled #FFFFFF",
      "original: padded #1F2A44",
      "original: other items kept",
    ]);
    expect(treatmentNotes({ kind: "original", scale: 1.25 })).toEqual([
      "background: kept at seller request",
      "original: enlarged 1.3x",
    ]);
    expect(treatmentNotes({ kind: "original", alreadyWhite: true, scale: 1 })).toEqual(["original: already white"]);
    expect(treatmentNotes({ kind: "background", forcedWhite: true, colorHex: "#1F2A44" })).toEqual([
      "background: white required",
    ]);
    expect(treatmentNotes({ kind: "background", colorHex: "#eadfcf" })).toEqual(["background: color #EADFCF"]);
  });

  it("says nothing for today's white files and for no treatment", () => {
    expect(treatmentNotes({ kind: "background", colorHex: "#FFFFFF" })).toEqual([]);
    expect(treatmentNotes({ kind: "background" })).toEqual([]);
    expect(treatmentNotes(undefined)).toEqual([]);
    expect(treatmentNotes(null)).toEqual([]);
  });

  it("does not call a scale of 1 a resize", () => {
    expect(treatmentNotes({ kind: "original", scale: 1, sourceWidth: 100, sourceHeight: 100 })).toEqual([
      "background: kept at seller request",
    ]);
  });
});

describe("parseTreatmentNote", () => {
  it("reads every note back to its key and value", () => {
    const samples: Array<[string, TreatmentNoteKey, string | undefined]> = [
      [TREATMENT_NOTES.keptAtSellerRequest, "keptAtSellerRequest", undefined],
      [TREATMENT_NOTES.unchangedFile, "unchangedFile", undefined],
      [TREATMENT_NOTES.turnedUpright, "turnedUpright", undefined],
      [TREATMENT_NOTES.resizedFrom(4032, 3024), "resizedFrom", "4032x3024"],
      [TREATMENT_NOTES.padded("#1F2A44"), "padded", "#1F2A44"],
      [TREATMENT_NOTES.cropped, "cropped", undefined],
      [TREATMENT_NOTES.cropFallback, "cropFallback", undefined],
      [TREATMENT_NOTES.enlarged(1.25), "enlarged", "1.3"],
      [TREATMENT_NOTES.colorConverted, "colorConverted", undefined],
      [TREATMENT_NOTES.alphaFilled("#FFFFFF"), "alphaFilled", "#FFFFFF"],
      [TREATMENT_NOTES.otherItems, "otherItems", undefined],
      [TREATMENT_NOTES.alreadyWhite, "alreadyWhite", undefined],
      [TREATMENT_NOTES.whiteRequired, "whiteRequired", undefined],
      [TREATMENT_NOTES.color("#EADFCF"), "color", "#EADFCF"],
    ];
    expect(new Set(samples.map(([, key]) => key))).toEqual(new Set(Object.keys(TREATMENT_NOTES)));
    for (const [note, key, value] of samples) {
      expect(parseTreatmentNote(note)).toEqual(value === undefined ? { key } : { key, value });
    }
    expect(parseTreatmentNote("fidelity: passed")).toBeNull();
  });

  it("builds each valued note from its exported prefix", () => {
    expect(TREATMENT_NOTES.resizedFrom(1, 2).startsWith(TREATMENT_NOTE_PREFIXES.resizedFrom)).toBe(true);
    expect(TREATMENT_NOTES.padded("#000000").startsWith(TREATMENT_NOTE_PREFIXES.padded)).toBe(true);
    expect(TREATMENT_NOTES.enlarged(1.5).startsWith(TREATMENT_NOTE_PREFIXES.enlarged)).toBe(true);
    expect(TREATMENT_NOTES.alphaFilled("#000000").startsWith(TREATMENT_NOTE_PREFIXES.alphaFilled)).toBe(true);
    expect(TREATMENT_NOTES.color("#000000").startsWith(TREATMENT_NOTE_PREFIXES.color)).toBe(true);
  });
});

describe("PackAssetTreatment", () => {
  it("round trips through JSON and refuses unknown keys and bad hexes", () => {
    const value = { kind: "original", padHex: "#1F2A44", scale: 0.5, sourceWidth: 10, sourceHeight: 10 } as const;
    expect(PackAssetTreatment.parse(JSON.parse(JSON.stringify(value)))).toEqual(value);
    expect(PackAssetTreatment.safeParse({ kind: "original", note: "x" }).success).toBe(false);
    expect(PackAssetTreatment.safeParse({ kind: "original", padHex: "#FFF" }).success).toBe(false);
    expect(PackAssetTreatment.safeParse({ kind: "kept" }).success).toBe(false);
  });
});

describe("client safe modules", () => {
  it("import no sharp and no node APIs", () => {
    for (const file of ["./treatment.ts", "./output-options.ts", "./seed/templates.ts", "./seed/brand.ts", "./seed/variations.ts", "./schemas.ts"]) {
      const source = readFileSync(new URL(file, import.meta.url), "utf8");
      const imports = [...source.matchAll(/^(?:import|export)\b[^;]*?\sfrom "([^"]+)";/gm)].map((m) => m[1]);
      if (file === "./treatment.ts" || file === "./output-options.ts") {
        // The scan must see the imports it checks.
        expect(imports.length, file).toBeGreaterThan(0);
      }
      for (const spec of imports) {
        expect(spec, `${file} imports ${spec}`).not.toMatch(/^(sharp|node:|fs$|path$|exiftool)/);
        // seed/templates.ts reads Shot from ../schemas (PHASE_16 packBundles), the same module;
        // the Shot schema and the options read the variation limits (PHASE_16 workstream 6).
        expect(["zod", "@curvi/specs", "./schemas", "../schemas", "./seed/brand", "./seed/templates", "./seed/variations"], `${file} imports ${spec}`).toContain(spec);
      }
    }
  });
});
