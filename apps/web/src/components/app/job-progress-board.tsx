"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Badge, Button, Card, CardContent, Progress, Skeleton, buttonVariants, cn } from "@curvi/ui";
import {
  AddPhotoButton,
  CancelPackButton,
  RetryShotButton,
  type PackActionResult,
} from "@/components/app/pack-actions";
import { ComplianceReportPanel } from "@/components/app/compliance-report-panel";
import { GalleryGrid } from "@/components/app/gallery-grid";
import { VersionPick } from "@/components/app/version-pick";
import { InventoryCard } from "@/components/app/inventory-card";
import { JobOptionsCard } from "@/components/app/job-options-card";
import { OutputPreview } from "@/components/app/output-preview";
import { PackDownloads } from "@/components/app/pack-downloads";
import { PackReveal } from "@/components/app/pack-reveal";
import { StatusChip } from "@/components/app/status-chip";
import { packSummaryLine } from "@/lib/job-copy";
import { isTerminalJobStatus, nextPoll, pollStopCopy, type PollResult, type PollStopReason } from "@/lib/job-poll";
import { canReveal, revealShots } from "@/lib/makeover";
import {
  boardSections,
  boardShots,
  isOriginalShot,
  isTransparentShot,
  isTurnedOffShot,
  previewAspect,
  type GroupedShot,
} from "@/lib/output-preview";
import { galleryItemsFromJob } from "@/lib/library";
import { REUSE_LABEL, reuseHref } from "@/lib/reuse";
import { track } from "@/lib/track";
import type { JobShotView, JobView } from "@/lib/services/types";

/** Previews are signed for at least an hour; a finished board refreshes them
 * well before that, and whenever the tab comes back after a long absence. */
const PREVIEW_REFRESH_MS = 40 * 60 * 1000;

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
  const pretty = shotType.replaceAll("_", " ").replaceAll(":", " ").replaceAll(".", " ").trim();
  return pretty.charAt(0).toUpperCase() + pretty.slice(1);
}

function channelList(channels: string[]): string {
  return channels.map((c) => c.replaceAll(".", " ").replaceAll("_", " ")).join(", ");
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
  const { pass, fillPct } = shot.compliance;
  // A kept photo is never held to a background rule, so no background
  // reading is shown for it (PHASE_15: no pure white check on originals).
  const background = isOriginalShot(shot.shotType) ? null : shot.compliance.background;
  if (!pass) {
    return <Badge variant="warning">Needs another pass</Badge>;
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

/** The chip a shot card shows, given where the whole job is. A planned shot
 * is in progress while the job generates, and was never made once the job
 * stopped without it. */
function shotChip(shot: JobShotView, jobStatus: JobView["status"]): { status: string; label: string | null } {
  if (shot.status === "pending") {
    if (jobStatus === "generating" || jobStatus === "qc") {
      return { status: "generating", label: "In progress" };
    }
    if (isTerminalJobStatus(jobStatus)) {
      return { status: "canceled", label: "Not made" };
    }
  }
  return { status: shot.status, label: shot.label ?? null };
}

/** A section of grouped cards: a carousel's slides in order, or the ads. */
function ShotGroup({
  title,
  line,
  testId,
  cards,
  job,
  canManage,
  onAction,
}: {
  title: string;
  line: string;
  testId: string;
  cards: GroupedShot<JobShotView>[];
  job: Pick<JobView, "id" | "status">;
  canManage: boolean;
  onAction: (result: PackActionResult) => void;
}) {
  if (cards.length === 0) {
    return null;
  }
  return (
    <section className="space-y-3" aria-label={title} data-testid={testId}>
      <div>
        <h2 className="text-base font-semibold text-ink-900">{title}</h2>
        <p className="text-sm text-ink-500">{line}</p>
      </div>
      <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {cards.map((card) => (
          <li key={card.shot.shotId}>
            <ShotCard shot={card.shot} job={job} canManage={canManage} onAction={onAction} title={card.title} />
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * One shot on the board. The preview shows the whole file inside a box in
 * its channel's shape, with a checkerboard behind a transparent PNG
 * (PHASE_15 job page), so a kept photo is never cropped to a square.
 */
export function ShotCard({
  shot,
  job,
  canManage,
  onAction,
  title: titleOverride,
}: {
  shot: JobShotView;
  job: Pick<JobView, "id" | "status">;
  canManage: boolean;
  onAction: (result: PackActionResult) => void;
  /** A grouped card's own title, for example "Slide 2" or "Ad 3". */
  title?: string;
}) {
  const chip = shotChip(shot, job.status);
  const title = titleOverride ?? shotTitle(shot.shotType);
  return (
    <Card
      className={cn(
        "h-full transition-shadow hover:shadow-raised",
        shot.status === "skipped" && "border-dashed bg-ink-50/60",
      )}
      data-testid="shot-card"
      data-shot-status={shot.status}
      data-shot-type={shot.shotType}
    >
      <CardContent className="p-5">
        <div className="flex items-start justify-between gap-2">
          <p className="text-sm font-semibold text-ink-900">{title}</p>
          <StatusChip status={chip.status} label={chip.label} />
        </div>
        {shot.imageUrl ? (
          <>
            <OutputPreview
              src={shot.imageUrl}
              alt={`${title} result`}
              aspect={previewAspect(shot.channels)}
              transparent={isTransparentShot(shot.shotType)}
              className="mt-3"
              testId="shot-preview"
            />
            {shot.downloadUrl ? (
              <a
                href={shot.downloadUrl}
                className="mt-2 inline-block text-xs font-medium text-accent-600 hover:text-accent-700"
                onClick={() => track("pack_downloaded", { jobId: job.id, kind: "shot", channel: shot.channels[0] ?? null })}
              >
                Download {title.toLowerCase()} image
              </a>
            ) : null}
          </>
        ) : null}
        {shot.providerStage ? <p className="mt-1 font-mono text-xs text-ink-400">{shot.providerStage}</p> : null}
        {shot.channels.length > 0 ? (
          <p className="mt-2 font-mono text-xs text-ink-500">{channelList(shot.channels)}</p>
        ) : null}
        {shot.note ? (
          <p
            className={cn("mt-2 text-xs", shot.status === "needs_review" ? "text-amber-800" : "text-ink-500")}
            data-testid="shot-note"
          >
            {shot.note}
          </p>
        ) : null}
        <div className="mt-3 min-h-6">
          <ComplianceBadge shot={shot} />
        </div>
        {shot.version ? (
          <VersionPick
            jobId={job.id}
            shotId={shot.shotId}
            version={shot.version}
            canPick={canManage && job.status === "done" && shot.status === "done"}
            onDone={onAction}
          />
        ) : null}
        {canManage && shot.action === "retry" ? (
          <RetryShotButton jobId={job.id} shot={shot} title={title} onDone={onAction} />
        ) : null}
        {canManage && shot.action === "add_photo" ? (
          <AddPhotoButton jobId={job.id} shot={shot} angleName={shot.angle ?? "missing"} onDone={onAction} />
        ) : null}
      </CardContent>
    </Card>
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

function StopCard({
  jobId,
  reason,
  onRetry,
}: {
  jobId: string;
  reason: Exclude<PollStopReason, "terminal">;
  onRetry: () => void;
}) {
  const copy = pollStopCopy(reason);
  return (
    <Card className={reason === "gave_up" ? "border-amber-200" : "border-red-200"} data-testid="job-poll-error">
      <CardContent className="p-6" role="alert">
        <p className={cn("text-sm font-semibold", reason === "gave_up" ? "text-amber-800" : "text-red-700")}>
          {copy.title}
        </p>
        <p className="mt-1 text-sm text-ink-600">{copy.body}</p>
        {reason === "signed_out" ? (
          <Link
            href={`/login?next=${encodeURIComponent(`/app/jobs/${jobId}`)}`}
            className={buttonVariants({ size: "sm", className: "mt-4" })}
          >
            Sign in again
          </Link>
        ) : null}
        {reason === "gave_up" ? (
          <Button size="sm" variant="outline" className="mt-4" onClick={onRetry}>
            Try again
          </Button>
        ) : null}
        {reason === "forbidden" || reason === "not_found" ? (
          <Link href="/app" className={buttonVariants({ size: "sm", variant: "outline", className: "mt-4" })}>
            Back to your packs
          </Link>
        ) : null}
      </CardContent>
    </Card>
  );
}

export function JobProgressBoard({ jobId }: { jobId: string }) {
  const [job, setJob] = useState<JobView | null>(null);
  const [stopReason, setStopReason] = useState<Exclude<PollStopReason, "terminal"> | null>(null);
  const [runId, setRunId] = useState(0);
  const [actionNotice, setActionNotice] = useState<{ tone: "info" | "error"; text: string } | null>(null);
  const lastFetchAt = useRef(0);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    let inFlight = false;
    let stopped = false;
    setStopReason(null);

    async function poll() {
      if (!active || inFlight) {
        return;
      }
      inFlight = true;
      timer = undefined;
      let result: PollResult;
      let body: JobView | null = null;
      try {
        const response = await fetch(`/api/jobs/${jobId}`, { cache: "no-store" });
        if (response.ok) {
          const data = (await response.json()) as { job?: JobView };
          body = data.job ?? null;
          result = body ? { kind: "job", status: body.status } : { kind: "http", status: 500 };
        } else {
          result = { kind: "http", status: response.status };
        }
      } catch {
        result = { kind: "network" };
      }
      inFlight = false;
      if (!active) {
        return;
      }
      if (body) {
        setJob(body);
        lastFetchAt.current = Date.now();
      }
      const decision = nextPoll(result, failures);
      failures = decision.failures;
      if (result.kind !== "job") {
        track("job_poll_failed", { status: result.kind === "http" ? result.status : 0 });
      }
      if (decision.action === "continue") {
        timer = setTimeout(() => void poll(), decision.delayMs);
        return;
      }
      if (decision.reason === "terminal") {
        // Finished: refresh once in a while so previews never expire on an
        // open page (Update.md 6.6).
        timer = setTimeout(() => void poll(), PREVIEW_REFRESH_MS);
        return;
      }
      stopped = true;
      setStopReason(decision.reason);
    }

    // Back on the tab after a long absence: refresh now rather than wait for
    // the timer, so previews and status are current.
    function onVisible() {
      if (
        document.visibilityState === "visible" &&
        !stopped &&
        !inFlight &&
        Date.now() - lastFetchAt.current > PREVIEW_REFRESH_MS
      ) {
        if (timer) {
          clearTimeout(timer);
        }
        void poll();
      }
    }

    void poll();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      active = false;
      document.removeEventListener("visibilitychange", onVisible);
      if (timer) {
        clearTimeout(timer);
      }
    };
  }, [jobId, runId]);

  const retry = useCallback(() => setRunId((n) => n + 1), []);

  // A pack operation answered: show the job it returned and what happened,
  // and poll again, since a shot run again takes the job back to working.
  const onAction = useCallback((result: PackActionResult) => {
    if (result.job) {
      setJob(result.job);
    }
    if (result.error) {
      setActionNotice({ tone: "error", text: result.error });
      return;
    }
    setActionNotice(result.notice ? { tone: "info", text: result.notice } : null);
    setRunId((n) => n + 1);
  }, []);

  if (stopReason && (!job || stopReason !== "gave_up")) {
    return <StopCard jobId={jobId} reason={stopReason} onRetry={retry} />;
  }
  if (!job) {
    return <BoardSkeleton />;
  }

  // Shots the seller turned off are not shown, and not counted as left out.
  // Carousel slides and ads get their own sections (PHASE_16 workstream 3).
  const sections = boardSections(boardShots(job.shots));
  const planned = job.shots.filter((s) => s.status !== "skipped");
  const skipped = job.shots.filter((s) => s.status === "skipped" && !isTurnedOffShot(s));
  const delivered = planned.filter((s) => s.status === "done").length;
  const needsReview = planned.filter((s) => s.status === "needs_review" || s.status === "failed").length;
  const finished = delivered + needsReview;
  const planning = planned.length === 0 && !isTerminalJobStatus(job.status);
  const canManage = job.canManage !== false;
  const running = !isTerminalJobStatus(job.status);

  return (
    <div className="space-y-6">
      {stopReason === "gave_up" ? <StopCard jobId={jobId} reason="gave_up" onRetry={retry} /> : null}
      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="font-display text-2xl font-bold tracking-tight text-ink-950">{job.productTitle}</h1>
            <p className="mt-1 text-sm text-ink-500">
              {job.mode === "concept" ? "Concept Mode." : "Listing Mode."}{" "}
              {job.status === "done" || job.status === "failed" || job.status === "canceled"
                ? `${job.creditsCharged} credits charged.`
                : job.followUpRunning
                  ? "Running shots again. Their credits are held and charged only if they pass."
                  : `${job.creditsReserved} credits held while it runs. You are charged only for shots that pass.`}
            </p>
          </div>
          <div className="flex flex-wrap items-start gap-3">
            {running && canManage ? <CancelPackButton job={job} onDone={onAction} /> : null}
            <StatusChip status={job.status} testId="job-status" />
          </div>
        </div>
        <StageStepper status={job.status} />
        {job.status === "failed" && job.error ? (
          <p
            className="max-w-2xl rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
            role="alert"
            data-testid="job-error"
          >
            {job.error}
          </p>
        ) : null}
        {actionNotice ? (
          <p
            className={cn(
              "max-w-2xl rounded-lg border px-3 py-2 text-sm",
              actionNotice.tone === "error"
                ? "border-red-200 bg-red-50 text-red-700"
                : "border-ink-200 bg-white text-ink-700",
            )}
            role={actionNotice.tone === "error" ? "alert" : "status"}
            data-testid="pack-action-notice"
          >
            {actionNotice.text}
          </p>
        ) : null}
        {job.status === "canceled" && !actionNotice ? (
          <p className="max-w-2xl rounded-lg border border-ink-200 bg-white px-3 py-2 text-sm text-ink-700">
            This pack was canceled. Credits held for it went back to your balance.
          </p>
        ) : null}
        {job.status === "done" ? (
          <Card className="border-emerald-200 bg-emerald-50/40" data-testid="pack-summary">
            <CardContent className="flex flex-wrap items-center justify-between gap-3 p-4">
              <p className="text-sm font-medium text-ink-900">
                {packSummaryLine({
                  delivered,
                  needsReview,
                  skipped: skipped.length,
                  creditsCharged: job.creditsCharged,
                })}
              </p>
              <div className="flex flex-wrap gap-2">
                {delivered > 0 ? (
                  <a href="#your-files" className={buttonVariants({ size: "sm", variant: "secondary" })}>
                    Get your files
                  </a>
                ) : null}
                <Link
                  href={`/app/new?product=${encodeURIComponent(job.productId)}`}
                  className={buttonVariants({ size: "sm", variant: "outline" })}
                >
                  New pack for this product
                </Link>
                <Link href={reuseHref(job.id)} className={buttonVariants({ size: "sm", variant: "outline" })} data-testid="reuse-pack">
                  {REUSE_LABEL}
                </Link>
              </div>
            </CardContent>
          </Card>
        ) : null}
        {job.status === "failed" || job.status === "canceled" ? (
          <div className="flex flex-wrap gap-2">
            <Link
              href={`/app/new?product=${encodeURIComponent(job.productId)}`}
              className={buttonVariants({ size: "sm", variant: "outline" })}
            >
              Try this product again
            </Link>
            <Link href={reuseHref(job.id)} className={buttonVariants({ size: "sm", variant: "outline" })} data-testid="reuse-pack">
              {REUSE_LABEL}
            </Link>
          </div>
        ) : null}
        {planned.length > 0 ? (
          <div className="flex items-center gap-3">
            <Progress value={finished} max={planned.length} className="max-w-md" aria-label="Shots finished" />
            <p className="whitespace-nowrap font-mono text-xs text-ink-500" aria-live="polite">
              {finished} of {planned.length} shots finished
            </p>
          </div>
        ) : null}
      </div>

      {canReveal(job) && job.sourceImageUrl ? (
        <PackReveal jobId={job.id} sourceImageUrl={job.sourceImageUrl} shots={revealShots(job.shots)} />
      ) : null}

      {job.outputOptions || job.inventory ? (
        <div className="grid gap-4 lg:auto-cols-fr lg:grid-flow-col [&:empty]:hidden">
          <JobOptionsCard options={job.outputOptions} />
          <InventoryCard inventory={job.inventory} />
        </div>
      ) : null}

      {planning ? (
        <Card data-testid="plan-pending">
          <CardContent className="p-5">
            <p className="text-sm text-ink-600" aria-live="polite">
              We are reading your photo and planning the shots. Every shot appears here as soon as the plan is
              ready.
            </p>
          </CardContent>
        </Card>
      ) : null}

      {sections.shots.length > 0 ? (
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" aria-label="Shots in this pack">
          {sections.shots.map((shot) => (
            <li key={shot.shotId}>
              <ShotCard shot={shot} job={job} canManage={canManage} onAction={onAction} />
            </li>
          ))}
        </ul>
      ) : null}

      <ShotGroup
        title="Carousel"
        line="The slides read as one swipe, in this order. They ship in the carousel folder, numbered."
        testId="carousel-group"
        cards={sections.carousel}
        job={job}
        canManage={canManage}
        onAction={onAction}
      />
      <ShotGroup
        title="Ads"
        line="Each ad ships for every placement you picked, inside its safe zone, with its headline and call to action in the ads file."
        testId="ads-group"
        cards={sections.ads}
        job={job}
        canManage={canManage}
        onAction={onAction}
      />
      {job.status === "done" && galleryItemsFromJob(job).length > 0 ? (
        <section className="space-y-3" aria-labelledby="pack-gallery-title">
          <h2 id="pack-gallery-title" className="text-lg font-semibold text-ink-950">
            Gallery
          </h2>
          <GalleryGrid
            items={galleryItemsFromJob(job)}
            canFavorite={canManage}
            emptyText="No images match these filters."
            testId="pack-gallery"
          />
        </section>
      ) : null}

      {job.status === "done" || job.followUpRunning ? <PackDownloads jobId={job.id} packDone={job.status === "done"} /> : null}
      {job.status === "done" ? <ComplianceReportPanel jobId={job.id} /> : null}
    </div>
  );
}
