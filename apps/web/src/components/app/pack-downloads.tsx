"use client";

import { useEffect, useState } from "react";
import { Badge, Button, Card, CardContent, cn } from "@curvi/ui";
import type { JobFilesView } from "@/lib/services/types";

function channelTitle(channel: string): string {
  return channel.charAt(0).toUpperCase() + channel.slice(1);
}

function formatBytes(bytes: number | null): string | null {
  if (bytes === null || bytes <= 0) {
    return null;
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${Math.round(bytes / 1024)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Channel tabs with correctly named downloads (plan 3.3.4): per channel
 * image files, the channel zip and the compliance report, all served through
 * short lived signed urls. */
export function PackDownloads({ jobId }: { jobId: string }) {
  const [view, setView] = useState<JobFilesView | null>(null);
  const [failed, setFailed] = useState(false);
  const [activeChannel, setActiveChannel] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
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
          setView(data);
        }
      } catch {
        if (!cancelled) {
          setFailed(true);
        }
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [jobId]);

  if (failed) {
    return <p className="text-sm text-red-600">The file list could not be loaded. Refresh to try again.</p>;
  }
  if (!view) {
    return <p className="text-sm text-ink-500">Collecting your files.</p>;
  }
  if (view.files.length === 0) {
    return view.notice ? <p className="text-sm text-amber-700">{view.notice}</p> : null;
  }

  const channels = [...new Set(view.files.map((f) => f.channel).filter((c): c is string => c !== null))];
  const active = activeChannel && channels.includes(activeChannel) ? activeChannel : channels[0];
  const channelFiles = view.files.filter((f) => f.channel === active && f.kind === "image");
  const zip = view.files.find((f) => f.channel === active && f.kind === "zip");
  const report = view.files.find((f) => f.kind === "report");

  return (
    <section data-testid="pack-downloads" className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold text-ink-950">Your files</h2>
        {report?.url ? (
          <a href={report.url} download className="text-sm font-medium text-ink-700 underline">
            Compliance report
          </a>
        ) : null}
      </div>
      {view.notice ? <p className="text-sm text-amber-700">{view.notice}</p> : null}

      <div className="flex flex-wrap gap-2" role="tablist" aria-label="Channels">
        {channels.map((channel) => (
          <button
            key={channel}
            role="tab"
            aria-selected={channel === active}
            onClick={() => setActiveChannel(channel)}
            className={cn(
              "rounded-full border px-4 py-1.5 text-sm font-medium transition-colors",
              channel === active
                ? "border-ink-900 bg-ink-900 text-white"
                : "border-ink-200 bg-white text-ink-700 hover:border-ink-400",
            )}
          >
            {channelTitle(channel)}
          </button>
        ))}
      </div>

      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-ink-500">
          {channelFiles.length} {channelFiles.length === 1 ? "file" : "files"} named for {channelTitle(active ?? "")}.
        </p>
        {zip?.url ? (
          <a href={zip.url} download>
            <Button variant="secondary" size="sm">
              Download {zip.name}
            </Button>
          </a>
        ) : null}
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {channelFiles.map((file) => (
          <Card key={`${file.channel}-${file.name}`} data-testid="pack-file">
            <CardContent className="p-4">
              {file.url ? (
                // Plain img: signed R2 urls and data uris are not next/image compatible.
                <img
                  src={file.url}
                  alt={`${file.specId ?? "asset"} ${file.name}`}
                  className="aspect-square w-full rounded-lg border border-ink-100 bg-white object-contain"
                />
              ) : (
                <div className="flex aspect-square w-full items-center justify-center rounded-lg border border-dashed border-ink-200 text-xs text-ink-400">
                  Preview unavailable
                </div>
              )}
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
                {file.url ? (
                  <a href={file.url} download={file.name} className="shrink-0">
                    <Badge variant="default">Download</Badge>
                  </a>
                ) : null}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </section>
  );
}
