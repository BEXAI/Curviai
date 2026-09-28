/**
 * Entry layout of the "all files" zip (Update.md 6.5). It must agree with
 * the per channel downloads: one folder per channel holding each delivered
 * file under the exact name stored for it (the channel naming convention,
 * e.g. MUG1.MAIN.jpg), plus the pack's compliance report at the root. Pure,
 * so the naming is unit tested.
 */

export interface ZipVariant {
  r2Key: string;
  filename: string;
  channelSpecId: string;
}

export interface ZipReport {
  r2Key: string;
  filename: string;
}

export interface ZipEntry {
  r2Key: string;
  name: string;
}

/** Keeps a zip entry name inside its folder: no path separators, no parent
 * references, no control characters. */
function safeSegment(value: string): string {
  const cleaned = value
    .replace(/[\\/]/g, "_")
    .replace(/[\x00-\x1f\x7f]/g, "")
    .trim();
  return cleaned === "" || cleaned === "." || cleaned === ".." ? "file" : cleaned;
}

export function channelOfSpec(specId: string): string {
  return specId.split(".")[0] ?? specId;
}

export function packZipEntries(variants: ZipVariant[], report: ZipReport | null): ZipEntry[] {
  const used = new Set<string>();
  const entries: ZipEntry[] = [];
  const sorted = [...variants].sort(
    (a, b) => a.channelSpecId.localeCompare(b.channelSpecId) || a.filename.localeCompare(b.filename),
  );
  for (const variant of sorted) {
    const folder = safeSegment(channelOfSpec(variant.channelSpecId));
    const base = safeSegment(variant.filename);
    let name = `${folder}/${base}`;
    // Two specs of one channel can share a file name; never overwrite.
    for (let n = 2; used.has(name); n += 1) {
      const dot = base.lastIndexOf(".");
      name = dot > 0 ? `${folder}/${base.slice(0, dot)}-${n}${base.slice(dot)}` : `${folder}/${base}-${n}`;
    }
    used.add(name);
    entries.push({ r2Key: variant.r2Key, name });
  }
  if (report) {
    entries.push({ r2Key: report.r2Key, name: safeSegment(report.filename) });
  }
  return entries;
}
