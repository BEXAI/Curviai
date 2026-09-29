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

/**
 * Why the "all files" zip could not be served. The Download all link is a
 * top level navigation, so the pack route sends a browser back to the job
 * page with one of these codes instead of a raw JSON error page, and the
 * files panel shows the plain copy for it.
 */
export type PackZipRefusal = "not_finished" | "no_files" | "missing_files";

export const PACK_ZIP_REFUSAL_PARAM = "pack_zip";

const PACK_ZIP_REFUSAL_COPY: Record<PackZipRefusal, string> = {
  not_finished: "The full zip is ready once this pack is done. You can still download each file below.",
  no_files: "This pack has no files to download yet.",
  missing_files:
    "Some files in this pack are missing, so the full zip is not available. Download each channel on this page, or contact us and we will sort it out.",
};

export function packZipRefusalCopy(code: string | null | undefined): string | null {
  if (!code || !Object.prototype.hasOwnProperty.call(PACK_ZIP_REFUSAL_COPY, code)) {
    return null;
  }
  return PACK_ZIP_REFUSAL_COPY[code as PackZipRefusal];
}

/** True when the request is a browser page navigation rather than a fetch. */
export function isPageNavigation(request: Request): boolean {
  const mode = request.headers.get("sec-fetch-mode");
  if (mode) {
    return mode === "navigate";
  }
  return (request.headers.get("accept") ?? "").includes("text/html");
}

/** Where a refused navigation lands: the job page, scrolled to its files. */
export function packZipRefusalPath(jobId: string, code: PackZipRefusal): string {
  return `/app/jobs/${jobId}?${PACK_ZIP_REFUSAL_PARAM}=${code}#your-files`;
}
