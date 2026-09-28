"use client";

import { useEffect, useRef, useState } from "react";
import { Badge, Card, CardContent, Progress, Skeleton } from "@curvi/ui";
import { cn } from "@curvi/ui";
import { StatusChip } from "@/components/app/status-chip";
import type { JobShotView, JobView } from "@/lib/services/types";

const POLL_MS = 2000;
const TERMINAL = new Set(["done", "failed", "canceled"]);

const STAGES = [
  { key: "queued", label: "Queued" },
  { key: "analyzing", label: "Analyzing" },
  { key: "planning", label: "Planning" },
  { key: "generating", label: "Generating" },
  { key: "qc", label: "Quality check" },
  { key: "packaging", label: "Packaging" },
  { key: "done", label: "Done" },
] as const;

function shotTitle(shotType: string): string {
  const pretty = shotType.replaceAll("_", " ");
  return pretty.charAt(0).toUpperCase() + pretty.slice(1);
}

function StageStepper({ status }: { status: string }) {
  const currentIndex = STAGES.findIndex((stage) => stage.key === status);
  if (currentIndex === -1) {
    return null;
  }
  return (
    <ol className="flex flex-wrap items-center gap-x-1 gap-y-2" aria-label="Pipeline stage">
      {STAGES.map((stage, index) => {
        const state = index < currentIndex ? "past" : index === currentIndex ? "current" : "ahead";
        return (
          <li key={stage.key} className="flex items-center gap-1">
            {index > 0 ? (
              <span
                className={cn("h-px w-4", state === "ahead" ? "bg-ink-200" : "bg-accent-400")}
                aria-hidden="true"
              />
            ) : null}
            <span
              className={cn(
                "flex items-center gap-1.5 rounded-full px-2 py-0.5 font-mono text-[11px] uppercase tracking-wide",
                state === "past" && "text-ink-500",
                state === "current" && "bg-accent-500/10 font-semibold text-accent-700",
                state === "ahead" && "text-ink-300",
              )}
              aria-current={state === "current" ? "step" : undefined}
            >
              {state === "current" && stage.key !== "done" ? (
                <span className="size-1.5 animate-pulse-dot rounded-full bg-accent-500" aria-hidden="true" />
              ) : null}
              {stage.label}
            </span>
          </li>
        );
      })}
    </ol>
  );
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

function BoardSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading your pack">
      <div className="space-y-3">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-4 w-96 max-w-full" />
        <Skeleton className="h-2 w-full" />
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <Card key={i}>
            <CardContent className="space-y-3 p-5">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-3 w-24" />
              <Skeleton className="h-3 w-40" />
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
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
    return (
      <Card className="border-red-200">
        <CardContent className="p-6">
          <p className="text-sm font-semibold text-red-700">We could not open this job</p>
          <p className="mt-1 text-sm text-ink-500">{error}</p>
        </CardContent>
      </Card>
    );
  }
  if (!job) {
    return <BoardSkeleton />;
  }

  const doneCount = job.shots.filter((s) => s.status === "done").length;

  return (
    <div className="space-y-6">
      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="font-display text-2xl font-bold tracking-tight text-ink-950">{job.productTitle}</h1>
            <p className="mt-1 text-sm text-ink-500">
              {job.mode === "concept" ? "Concept Mode. Outputs carry the Concept render label." : "Listing Mode."}{" "}
              {job.creditsReserved} credits reserved.
            </p>
          </div>
          <StatusChip status={job.status} testId="job-status" />
        </div>
        <StageStepper status={job.status} />
        {job.status === "failed" && job.error ? (
          <p className="max-w-2xl rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {job.error}
          </p>
        ) : null}
        {job.status === "done" && job.shots.some((shot) => shot.imageUrl) ? (
          <a
            href={`/api/jobs/${job.id}/pack`}
            className="inline-flex h-9 items-center rounded-lg bg-ink-900 px-3 text-sm font-medium text-white transition-colors hover:bg-ink-800"
          >
            Download pack
          </a>
        ) : null}
        <div className="flex items-center gap-3">
          <Progress value={doneCount} max={job.shots.length} className="max-w-md" />
          <p className="whitespace-nowrap font-mono text-xs text-ink-500">
            {doneCount} of {job.shots.length} shots done
          </p>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {job.shots.map((shot) => (
          <Card key={shot.shotId} className="transition-shadow hover:shadow-raised" data-testid="shot-card">
            <CardContent className="p-5">
              <div className="flex items-start justify-between gap-2">
                <p className="text-sm font-semibold text-ink-900">{shotTitle(shot.shotType)}</p>
                <StatusChip status={shot.status} />
              </div>
              {shot.imageUrl ? (
                <>
                  {/* Signed, short lived R2 URL; a plain img avoids next/image domain config. */}
                  <img
                    src={shot.imageUrl}
                    alt={`${shotTitle(shot.shotType)} result`}
                    className="mt-3 aspect-square w-full rounded-lg border border-ink-950/10 object-cover"
                  />
                  <a
                    href={shot.imageUrl}
                    download
                    className="mt-2 inline-block text-xs font-medium text-accent-600 hover:text-accent-700"
                  >
                    Download image
                  </a>
                </>
              ) : null}
              <p className="mt-1 font-mono text-xs text-ink-400">{shot.providerStage}</p>
              <p className="mt-2 font-mono text-xs text-ink-500">
                {shot.channels.length > 0 ? shot.channels.join(", ") : "all selected channels"}
              </p>
              <div className="mt-3 min-h-6">
                <ComplianceBadge shot={shot} />
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
