/**
 * The IPTC smoke check (docs/phases/PHASE_18.md P18-09 part 2):
 *
 *   pnpm --filter @curvi/trigger smoke:iptc <object key>
 *
 * reads one delivered file from the private R2 bucket and prints the IPTC
 * DigitalSourceType exiftool finds in it, so the founder can confirm once,
 * on a production file, that a lifestyle scene carries compositeSynthetic
 * and a white main image carries no AI label (docs/marketing.md claim C-11,
 * MKT-003 step 7). It only reads: nothing is written to R2 or the database.
 * The file is copied to a temporary folder for exiftool and deleted after.
 *
 * The CLI entry is smoke-iptc-cli.ts; this module is the testable part.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/** Where the founder finds a key: the newest delivered lifestyle scene. */
export const LIFESTYLE_KEY_QUERY =
  "select v.r2_key from asset_variants v join assets a on a.id = v.asset_id where a.shot_type = 'lifestyle' and a.approved order by v.created_at desc limit 1;";

export const SMOKE_IPTC_USAGE = [
  "Usage: pnpm --filter @curvi/trigger smoke:iptc <object key>",
  "",
  "The key is the r2_key of one delivered file, for example ws/<workspace id>/jobs/<job id>/files/<channel>/<file name>.jpg.",
  "To find the newest delivered lifestyle scene, run this in the Supabase SQL editor:",
  `  ${LIFESTYLE_KEY_QUERY}`,
  "R2_ACCOUNT_ID, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY must be set in the shell, and R2_BUCKET_PRIVATE when the bucket is not curvi-private.",
].join("\n");

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

/**
 * A delivered image under a job's files folder (r2.ts assetFileKey, and the
 * variation and follow up folders below a channel). Pack zips, the report
 * and uploaded source photos are not delivered images and are refused.
 */
const DELIVERED_IMAGE_KEY = new RegExp(
  `^ws/${UUID}/jobs/${UUID}/files/[^/]+/(?:[^/]+/)?[^/]+\\.(jpe?g|png|webp)$`,
  "i",
);

const MAX_KEY_LENGTH = 512;

export type SmokeIptcArgs = { ok: true; key: string; extension: string } | { ok: false; message: string };

/** Reads the one object key argument. pnpm may pass a leading "--". */
export function parseSmokeIptcArgs(argv: readonly string[]): SmokeIptcArgs {
  const args = argv[0] === "--" ? argv.slice(1) : [...argv];
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    return { ok: false, message: SMOKE_IPTC_USAGE };
  }
  if (args.length > 1) {
    return { ok: false, message: `Give exactly one object key, not ${args.length}.\n\n${SMOKE_IPTC_USAGE}` };
  }
  const key = (args[0] ?? "").trim();
  if (key.length > MAX_KEY_LENGTH || key.split("/").includes("..") || key.includes("\\")) {
    return { ok: false, message: `That is not an object key.\n\n${SMOKE_IPTC_USAGE}` };
  }
  const match = DELIVERED_IMAGE_KEY.exec(key);
  if (!match) {
    return {
      ok: false,
      message: `That key is not a delivered image. It must start with ws/<workspace id>/jobs/<job id>/files/ and end in .jpg, .png or .webp.\n\n${SMOKE_IPTC_USAGE}`,
    };
  }
  return { ok: true, key, extension: (match[1] ?? "jpg").toLowerCase() };
}

/** One plain sentence on what the value means for Google Merchant Center. */
export function describeDigitalSourceType(value: string | null): string {
  if (value === null) {
    return "This file carries no AI label. That is right for a white main image or a resized photo, and wrong for a lifestyle scene.";
  }
  if (value.includes("compositeSynthetic")) {
    return "This file carries compositeSynthetic, the label Google Merchant Center accepts for a scene made with AI around a real product.";
  }
  if (value.includes("trainedAlgorithmicMedia")) {
    return "This file carries trainedAlgorithmicMedia, the label for an image made entirely by AI. A Listing Mode scene should carry compositeSynthetic instead.";
  }
  return "This file carries a DigitalSourceType value Curvi does not write. Check how the file was made.";
}

export interface SmokeIptcDeps {
  /** The object's bytes, or null when it cannot be read. */
  get(key: string): Promise<Buffer | null>;
  /** The DigitalSourceType value in a local file, or null (pipeline readDigitalSourceTypeValue). */
  readValue(file: string): Promise<string | null>;
  /** Parent folder for the temporary copy. Defaults to the system temp folder. */
  tempRoot?: string;
}

export interface SmokeIptcResult {
  ok: boolean;
  value: string | null;
  lines: string[];
}

/** Reads one delivered file and reports its DigitalSourceType. Never throws. */
export async function checkDeliveredFile(
  args: { key: string; extension: string },
  deps: SmokeIptcDeps,
): Promise<SmokeIptcResult> {
  let bytes: Buffer | null;
  try {
    bytes = await deps.get(args.key);
  } catch {
    bytes = null;
  }
  if (!bytes) {
    return {
      ok: false,
      value: null,
      lines: [
        `Could not read ${args.key}.`,
        "Check the key, the R2 variables and that the file still exists (delivered files are kept while the pack is).",
      ],
    };
  }

  const dir = await mkdtemp(path.join(deps.tempRoot ?? tmpdir(), "curvi-smoke-iptc-"));
  try {
    const file = path.join(dir, `delivered.${args.extension}`);
    await writeFile(file, bytes);
    const value = await deps.readValue(file);
    return {
      ok: true,
      value,
      lines: [
        `Object: ${args.key}`,
        `Size: ${bytes.length} bytes`,
        `DigitalSourceType: ${value ?? "none"}`,
        describeDigitalSourceType(value),
      ],
    };
  } catch (error) {
    return {
      ok: false,
      value: null,
      lines: [
        `exiftool could not read the file: ${error instanceof Error ? error.message : String(error)}`,
      ],
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
