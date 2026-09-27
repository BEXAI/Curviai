"use client";

import { useEffect, useRef, useState } from "react";
import { Badge, Card, CardContent } from "@curvi/ui";
import { PackDownloads } from "@/components/app/pack-downloads";
import { StatusChip } from "@/components/app/status-chip";
import type { JobShotView, JobView } from "@/lib/services/types";

const POLL_MS = 2000;
const TERMINAL = new Set(["done", "failed", "canceled"]);

function shotTitle(shotType: string): string {
  const pretty = shotType.replaceAll("_", " ");
  return pretty.charAt(0).toUpperCase() + pretty.slice(1);
}

function ComplianceBadge({ shot }: { shot: JobShotView }) {
  if (shot.status !== "done" || !shot.compliance) {
    return null;
  }
  const { pass, fillPct, background } = shot.compliance;
  if (!pass) {
    return <Badge variant="danger">Needs another pass</Badge>;
  }
  if (fillPct !== null && background) {
    return (
      <Badge variant="success" data-testid="compliance-badge">
        Passes channel rules. Fill {fillPct} percent, background {background.join(", ")}
      </Badge>
    );
  }
  if (fillPct !== null) {
    return (
      <Badge variant="success" data-testid="compliance-badge">
        Passes channel rules. Fill {fillPct} percent
      </Badge>
    );
  }
  return (
    <Badge variant="success" data-testid="compliance-badge">
      Passes channel rules
    </Badge>
  );
}

export function JobProgressBoard({ jobId }: { jobId: string }) {
  const [job, setJob] = useState<JobView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const stopped = useRef(false);

  useEffect(() => {
    stopped.current = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function poll() {
      if (stopped.current) {
        return;
      }
      try {
        const response = await fetch(`/api/jobs/${jobId}`, { cache: "no-store" });
        if (response.status === 404) {
          setError("This job does not exist or belongs to another workspace.");
          return;
        }
        const data = (await response.json()) as { job?: JobView };
        if (data.job) {
          setJob(data.job);
          if (TERMINAL.has(data.job.status)) {
            return;
          }
        }
      } catch {
        // Transient network error: keep polling.
      }
      timer = setTimeout(() => void poll(), POLL_MS);
    }

    void poll();
    return () => {
      stopped.current = true;
      if (timer) {
        clearTimeout(timer);
      }
    };
  }, [jobId]);

  if (error) {
    return <p className="text-sm text-red-600">{error}</p>;
  }
  if (!job) {
    return <p className="text-sm text-ink-500">Loading your pack.</p>;
  }

  const doneCount = job.shots.filter((s) => s.status === "done").length;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-ink-950">{job.productTitle}</h1>
          <p className="mt-1 text-sm text-ink-500">
            {job.mode === "concept" ? "Concept Mode. Outputs carry the Concept render label." : "Listing Mode."}{" "}
            {job.creditsReserved} credits reserved. {doneCount} of {job.shots.length} shots done.
          </p>
        </div>
        <StatusChip status={job.status} testId="job-status" />
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {job.shots.map((shot) => (
          <Card key={shot.shotId} data-testid="shot-card">
            <CardContent className="p-5">
              <div className="flex items-start justify-between gap-2">
                <p className="text-sm font-semibold text-ink-900">{shotTitle(shot.shotType)}</p>
                <StatusChip status={shot.status} />
              </div>
              <p className="mt-1 text-xs text-ink-400">{shot.providerStage}</p>
              <p className="mt-2 text-xs text-ink-500">
                {shot.channels.length > 0 ? shot.channels.join(", ") : "all selected channels"}
              </p>
              <div className="mt-3 min-h-6">
                <ComplianceBadge shot={shot} />
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {job.status === "done" ? <PackDownloads jobId={job.id} /> : null}
    </div>
  );
}
