/**
 * IPTC digital source type marking (CURVI_BUILD_PLAN.md sections 2.6 and 5.7).
 * Google Merchant Center requires TrainedAlgorithmicMedia on fully generated
 * images; composites of a real photo carry CompositeSynthetic; deterministic
 * edits of the user's photo carry no AI tag.
 *
 * A single shared exiftool instance is used; call endExiftool() in afterAll or
 * on process shutdown.
 */
import { ExifTool, type WriteTags } from "exiftool-vendored";

export type DigitalSourceKind = "composite" | "trained" | "none";

const IPTC_URI_BASE = "http://cv.iptc.org/newscodes/digitalsourcetype/";
const KIND_TO_URI: Record<Exclude<DigitalSourceKind, "none">, string> = {
  composite: `${IPTC_URI_BASE}compositeSynthetic`,
  trained: `${IPTC_URI_BASE}trainedAlgorithmicMedia`,
};

let shared: ExifTool | null = null;

/** Lazily created shared exiftool process pool. */
export function getExiftool(): ExifTool {
  if (!shared) {
    shared = new ExifTool({ maxProcs: 1 });
  }
  return shared;
}

/** Shut the shared exiftool down. Safe to call more than once. */
export async function endExiftool(): Promise<void> {
  if (shared) {
    const tool = shared;
    shared = null;
    await tool.end();
  }
}

/**
 * Write Iptc4xmpExt:DigitalSourceType on the file in place. Kind "none"
 * removes the tag (deterministic edits of the user's photo carry no AI tag).
 */
export async function writeDigitalSourceType(file: string, kind: DigitalSourceKind): Promise<void> {
  const et = getExiftool();
  const value = kind === "none" ? null : KIND_TO_URI[kind];
  // DigitalSourceType (XMP-iptcExt) is not in exiftool-vendored's WriteTags
  // union, so widen the type. exiftool itself validates the tag name.
  const tags = { "XMP-iptcExt:DigitalSourceType": value } as unknown as WriteTags;
  await et.write(file, tags, { writeArgs: ["-overwrite_original"] });
}

/**
 * The DigitalSourceType value exactly as exiftool reads it from the file, or
 * null when the file carries none. The smoke:iptc check prints it.
 */
export async function readDigitalSourceTypeValue(file: string): Promise<string | null> {
  const et = getExiftool();
  const tags = (await et.read(file)) as Record<string, unknown>;
  const value = tags["DigitalSourceType"];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Read the digital source type back, mapping unknown or missing values to "none". */
export async function readDigitalSourceType(file: string): Promise<DigitalSourceKind> {
  const value = await readDigitalSourceTypeValue(file);
  if (value === null) {
    return "none";
  }
  if (value.includes("compositeSynthetic")) {
    return "composite";
  }
  if (value.includes("trainedAlgorithmicMedia")) {
    return "trained";
  }
  return "none";
}
