"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { Card, CardContent, buttonVariants, cn } from "@curvi/ui";
import { OutputPreview } from "@/components/app/output-preview";
import { aspectRatioCss, mayBeTransparentFile, previewAspect } from "@/lib/output-preview";
import { PACK_ZIP_REFUSAL_PARAM, packZipRefusalCopy } from "@/lib/pack-zip";
import { familyName } from "@/lib/preflight/copy";
import { track } from "@/lib/track";
import type { JobFilesView, JobFileView } from "@/lib/services/types";

/** Previews in the list are signed for at least an hour. Refresh the list
 * well before that, and when the tab comes back after a long absence, so an
 * open page never shows broken previews. Downloads always sign on click. */
const REFRESH_MS = 40 * 60 * 1000;

/** Sent when an action on the job page changes the pack's files (a version
 * pick deletes the touched channel zips), so the list reloads at once. */
export const PACK_FILES_CHANGED_EVENT = "curvi:pack-files-changed";

export function announcePackFilesChanged(jobId: string): void {
  window.dispatchEvent(new CustomEvent(PACK_FILES_CHANGED_EVENT, { detail: { jobId } }));
}

/** Decimal units, like spec maxBytes and the compliance report's file size,
 * so one file shows the same size everywhere on the job page. */
function formatBytes(bytes: number | null): string | null {
  if (bytes === null || bytes <= 0) {
    return null;
  }
  if (bytes < 1000) {
    return `${bytes} B`;
  }
  if (bytes < 1_000_000) {
    return `${Math.max(1, Math.round(bytes / 1000))} KB`;
  }
  return `${Math.round((bytes / 1_000_000) * 10) / 10} MB`;
}

function trackDownload(jobId: string, file: Pick<JobFileView, "channel" | "kind">): void {
  track("pack_downloaded", { jobId, channel: file.channel, kind: file.kind });
}

/**
 * One file's preview in its channel's shape, with the checkerboard behind a
 * PNG's transparent pixels, like the shot cards on the board (PHASE_15 item 34).
 */
export function FilePreview({ file }: { file: Pick<JobFileView, "name" | "specId" | "url"> }) {
  const aspect = previewAspect([file.specId]);
  if (!file.url) {
    return (
      <div
        className="flex w-full items-center justify-center rounded-lg border border-dashed border-ink-200 text-xs text-ink-400"
        style={{ aspectRatio: aspectRatioCss(aspect) }}
      >
        Preview unavailable
      </div>
    );
  }
  return (
    <OutputPreview
      src={file.url}
      alt={`${file.specId ?? "asset"} ${file.name}`}
      aspect={aspect}
      transparent={mayBeTransparentFile(file.name)}
      testId="file-preview"
    />
  );
}

/**
 * Whether the header offers the "all files" zip. The pack route only zips a
 * pack whose status is done, so while a shot re-runs the link would land on
 * a refusal; the seller gets a plain note instead (the files stay listed).
 */
export function downloadAllState(
  view: Pick<JobFilesView, "files">,
  packDone: boolean,
): "link" | "after_rerun" | "none" {
  const hasFiles = view.files.some((f) => f.kind === "image" && f.downloadUrl);
  if (!hasFiles) {
    return "none";
  }
  return packDone ? "link" : "after_rerun";
}

/** Channel tabs with correctly named downloads (plan 3.3.4): per channel
 * image files, the channel zip, everything in one zip and the compliance
 * report. Every download link goes through the download route, which signs
 * a fresh url that saves the file under its channel name. */
export function PackDownloads({ jobId, packDone }: { jobId: string; packDone: boolean }) {
  const [view, setView] = useState<JobFilesView | null>(null);
  const [failed, setFailed] = useState(false);
  const [activeChannel, setActiveChannel] = useState<string | null>(null);
  const [zipRefusal, setZipRefusal] = useState<string | null>(null);
  const tabRefs = useRef(new Map<string, HTMLButtonElement>());
  const baseId = useId();

  // The pack route sends a refused Download all back here with a code.
  useEffect(() => {
    try {
      setZipRefusal(new URLSearchParams(window.location.search).get(PACK_ZIP_REFUSAL_PARAM));
    } catch {
      setZipRefusal(null);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    let lastLoadAt = 0;
    async function load() {
      try {
        const response = await fetch(`/api/jobs/${jobId}/files`, { cache: "no-store" });
        if (!response.ok) {
          if (!cancelled) {
            setFailed(true);
          }
          return;
        }
        const data = (await response.json()) as JobFilesView;
        if (!cancelled) {
          lastLoadAt = Date.now();
          setView(data);
          setFailed(false);
        }
      } catch {
        if (!cancelled) {
          setFailed(true);
        }
      }
    }
    function onVisible() {
      if (document.visibilityState === "visible" && Date.now() - lastLoadAt > REFRESH_MS) {
        void load();
      }
    }
    function onFilesChanged(event: Event) {
      if ((event as CustomEvent<{ jobId?: string } | null>).detail?.jobId === jobId) {
        void load();
      }
    }
    void load();
    const interval = setInterval(() => void load(), REFRESH_MS);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener(PACK_FILES_CHANGED_EVENT, onFilesChanged);
    return () => {
      cancelled = true;
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener(PACK_FILES_CHANGED_EVENT, onFilesChanged);
    };
    // packDone is a dependency on purpose: a finished follow up deletes and
    // adds files, so the list reloads when the pack is done again.
  }, [jobId, packDone]);

  if (failed && !view) {
    return (
      <p className="text-sm text-red-600" role="alert">
        The file list could not be loaded. Refresh the page to try again.
      </p>
    );
  }
  if (!view) {
    return <p className="text-sm text-ink-500">Collecting your files.</p>;
  }

  const channels = [...new Set(view.files.map((f) => f.channel).filter((c): c is string => c !== null))];
  const active = activeChannel && channels.includes(activeChannel) ? activeChannel : channels[0];
  const channelFiles = view.files.filter((f) => f.channel === active && f.kind === "image");
  const zip = view.files.find((f) => f.channel === active && f.kind === "zip");
  const report = view.files.find((f) => f.kind === "report");
  const downloadAll = downloadAllState(view, packDone);
  // A "not finished" refusal is stale once the pack is done.
  const zipNotice =
    downloadAll === "after_rerun" || (packDone && zipRefusal === "not_finished") ? null : packZipRefusalCopy(zipRefusal);
  const tabId = (channel: string) => `${baseId}-tab-${channel}`;
  const panelId = (channel: string) => `${baseId}-panel-${channel}`;

  function focusTab(channel: string) {
    setActiveChannel(channel);
    tabRefs.current.get(channel)?.focus();
  }

  function onTabKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const last = channels.length - 1;
    let next: number | null = null;
    if (event.key === "ArrowRight") next = index === last ? 0 : index + 1;
    if (event.key === "ArrowLeft") next = index === 0 ? last : index - 1;
    if (event.key === "Home") next = 0;
    if (event.key === "End") next = last;
    if (next !== null) {
      event.preventDefault();
      focusTab(channels[next]);
    }
  }

  return (
    <section id="your-files" data-testid="pack-downloads" className="scroll-mt-6 space-y-4" aria-labelledby={`${baseId}-heading`}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id={`${baseId}-heading`} className="text-lg font-semibold text-ink-950">
          Your files
        </h2>
        <div className="flex flex-wrap items-center gap-3">
          {report?.downloadUrl ? (
            <a
              href={report.downloadUrl}
              className="text-sm font-medium text-ink-700 underline"
              onClick={() => trackDownload(jobId, report)}
            >
              Compliance report
            </a>
          ) : null}
          {downloadAll === "link" ? (
            <a
              href={`/api/jobs/${jobId}/pack`}
              className={buttonVariants({ variant: "outline", size: "sm" })}
              onClick={() => track("pack_downloaded", { jobId, channel: null, kind: "all" })}
              data-testid="download-all"
            >
              Download all files
            </a>
          ) : null}
        </div>
      </div>
      {downloadAll === "after_rerun" ? (
        <p className="text-sm text-ink-500" data-testid="download-all-later">
          Download all files comes back once this shot finishes. Each file below is ready now.
        </p>
      ) : null}
      {zipNotice ? (
        <p className="text-sm text-amber-700" role="status" data-testid="download-all-notice">
          {zipNotice}
        </p>
      ) : null}
      {view.notice ? <p className="text-sm text-amber-700">{view.notice}</p> : null}

      {channels.length > 0 && active ? (
        <>
          <div className="flex flex-wrap gap-2" role="tablist" aria-label="Channels">
            {channels.map((channel, index) => {
              const selected = channel === active;
              return (
                <button
                  key={channel}
                  type="button"
                  role="tab"
                  id={tabId(channel)}
                  aria-selected={selected}
                  aria-controls={panelId(channel)}
                  tabIndex={selected ? 0 : -1}
                  ref={(node) => {
                    if (node) {
                      tabRefs.current.set(channel, node);
                    } else {
                      tabRefs.current.delete(channel);
                    }
                  }}
                  onClick={() => setActiveChannel(channel)}
                  onKeyDown={(event) => onTabKeyDown(event, index)}
                  className={cn(
                    "rounded-full border px-4 py-1.5 text-sm font-medium transition-colors",
                    "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink-900",
                    selected
                      ? "border-ink-900 bg-ink-900 text-white"
                      : "border-ink-200 bg-white text-ink-700 hover:border-ink-400",
                  )}
                >
                  {familyName(channel)}
                </button>
              );
            })}
          </div>

          <div role="tabpanel" id={panelId(active)} aria-labelledby={tabId(active)} tabIndex={0} className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm text-ink-500">
                {channelFiles.length} {channelFiles.length === 1 ? "file" : "files"} named for {familyName(active)}.
              </p>
              {zip?.downloadUrl ? (
                <a
                  href={zip.downloadUrl}
                  className={buttonVariants({ variant: "secondary", size: "sm" })}
                  onClick={() => trackDownload(jobId, zip)}
                >
                  Download {zip.name}
                </a>
              ) : null}
            </div>

            <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {channelFiles.map((file) => (
                <li key={file.id}>
                  <Card data-testid="pack-file">
                    <CardContent className="p-4">
                      <FilePreview file={file} />
                      <div className="mt-3 flex items-center justify-between gap-2">
                        <div className="min-w-0">
                          <p className="truncate text-xs font-medium text-ink-900" title={file.name}>
                            {file.name}
                          </p>
                          <p className="text-xs text-ink-400">
                            {file.specId}
                            {formatBytes(file.bytes) ? ` (${formatBytes(file.bytes)})` : ""}
                          </p>
                        </div>
                        {file.downloadUrl ? (
                          <a
                            href={file.downloadUrl}
                            className={buttonVariants({ variant: "outline", size: "sm", className: "shrink-0" })}
                            aria-label={`Download ${file.name}`}
                            onClick={() => trackDownload(jobId, file)}
                          >
                            Download
                          </a>
                        ) : null}
                      </div>
                    </CardContent>
                  </Card>
                </li>
              ))}
            </ul>
          </div>
        </>
      ) : null}
    </section>
  );
}
