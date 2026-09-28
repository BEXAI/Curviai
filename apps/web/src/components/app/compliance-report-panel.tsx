"use client";

import { useEffect, useId, useState } from "react";
import { Badge, Card, CardContent, buttonVariants, cn } from "@curvi/ui";
import { track } from "@/lib/track";
import type { ComplianceFileView, ComplianceReportView } from "@/lib/services/types";

/**
 * The readable compliance report on the pack page: a summary line, then each
 * channel's files with what was checked, what was measured and what the
 * channel requires. Files that need attention open by default. The PDF
 * download is built from the same report on the server.
 */
export function ComplianceReportPanel({ jobId }: { jobId: string }) {
  const [report, setReport] = useState<ComplianceReportView | null>(null);
  const [failed, setFailed] = useState(false);
  const headingId = useId();

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const response = await fetch(`/api/jobs/${jobId}/compliance`, { cache: "no-store" });
        if (!response.ok) {
          if (!cancelled) setFailed(true);
          return;
        }
        const data = (await response.json()) as ComplianceReportView;
        if (!cancelled) setReport(data);
      } catch {
        if (!cancelled) setFailed(true);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [jobId]);

  if (failed && !report) {
    return (
      <p className="text-sm text-red-600" role="alert">
        The compliance report could not be loaded. Refresh the page to try again.
      </p>
    );
  }
  if (!report) {
    return null;
  }

  const { files, passed, needsAttention, leftOut } = report.summary;

  return (
    <section data-testid="compliance-report" className="space-y-4" aria-labelledby={headingId}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id={headingId} className="text-lg font-semibold text-ink-950">
          Compliance report
        </h2>
        {report.available ? (
          <a
            href={`/api/jobs/${jobId}/compliance-report.pdf`}
            className={buttonVariants({ variant: "outline", size: "sm" })}
            onClick={() => track("pack_downloaded", { jobId, channel: null, kind: "report_pdf" })}
            data-testid="compliance-pdf"
          >
            Download compliance-report.pdf
          </a>
        ) : null}
      </div>

      {report.available ? (
        <p className="text-sm text-ink-600" data-testid="compliance-summary">
          {files} {files === 1 ? "file" : "files"} checked against each channel&apos;s published image rules.{" "}
          {passed} passed every check.
          {needsAttention > 0 ? ` ${needsAttention} need attention.` : ""}
          {leftOut > 0 ? ` ${leftOut} left out of the pack and not charged.` : ""}
        </p>
      ) : null}
      {report.notice ? <p className="text-sm text-amber-700">{report.notice}</p> : null}

      {report.channels.map((channel) => (
        <Card key={channel.channel}>
          <CardContent className="p-4">
            <h3 className="text-sm font-semibold text-ink-900">{channel.title}</h3>
            <ul className="mt-2 divide-y divide-ink-100">
              {channel.files.map((file) => (
                <li key={`${file.specId}:${file.file}`}>
                  <FileChecks file={file} demo={report.demo} />
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ))}

      {report.dropped.length > 0 ? (
        <Card>
          <CardContent className="p-4">
            <h3 className="text-sm font-semibold text-ink-900">Left out of the pack</h3>
            <ul className="mt-2 space-y-2 text-sm">
              {report.dropped.map((entry) => (
                <li key={`${entry.channelTitle}:${entry.file}`}>
                  <span className="font-medium text-ink-900">
                    {entry.channelTitle}: {entry.file}
                  </span>
                  <span className="block text-ink-500">{entry.reason}</span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}
    </section>
  );
}

function FileChecks({ file, demo }: { file: ComplianceFileView; demo: boolean }) {
  return (
    <details className="group py-2" open={!file.pass} data-testid="compliance-file">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3">
        <span className="min-w-0">
          <span className="block truncate text-sm font-medium text-ink-900" title={file.file}>
            {file.file}
          </span>
          <span className="block text-xs text-ink-500">{file.specLabel}</span>
        </span>
        {demo ? (
          <Badge variant="default">Checks listed</Badge>
        ) : file.pass ? (
          <Badge variant="success">Passed</Badge>
        ) : (
          <Badge variant="danger">Needs attention</Badge>
        )}
      </summary>
      <table className="mt-2 w-full text-left text-xs">
        <thead className="text-ink-400">
          <tr>
            <th scope="col" className="py-1 pr-2 font-medium">
              Check
            </th>
            <th scope="col" className="py-1 pr-2 font-medium">
              Measured
            </th>
            <th scope="col" className="py-1 pr-2 font-medium">
              Required
            </th>
            <th scope="col" className="py-1 font-medium">
              <span className="sr-only">Result</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {file.checks.map((check) => (
            <tr key={check.key} className="border-t border-ink-50 align-top">
              <td className="py-1 pr-2 text-ink-800">{check.label}</td>
              <td className="py-1 pr-2 text-ink-600">{check.measured}</td>
              <td className="py-1 pr-2 text-ink-600">{check.required}</td>
              <td className={cn("py-1 font-medium", check.pass ? "text-emerald-700" : "text-red-700")}>
                {demo ? "" : check.pass ? "Pass" : "Fail"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {file.notes.length > 0 ? (
        <ul className="mt-2 space-y-1 text-xs text-ink-500">
          {file.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      ) : null}
    </details>
  );
}
