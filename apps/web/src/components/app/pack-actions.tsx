"use client";

import { useRef, useState } from "react";
import { Button, cn } from "@curvi/ui";
import { track } from "@/lib/track";
import { uploadSourcePhoto } from "@/lib/upload-photo";
import type { JobShotView, JobView } from "@/lib/services/types";

/**
 * The pack operations on the progress board: cancel a running pack, run a
 * shot that needs review again, and add the photo a skipped shot waits for.
 * Each asks for confirmation first, since each one holds or returns credits,
 * and hands the job the server answered with back to the board.
 */

export interface PackActionResult {
  job: JobView | null;
  notice: string | null;
  error: string | null;
}

async function postJson(url: string, body?: unknown): Promise<{ status: number; data: Record<string, unknown> }> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: response.status, data };
}

function resultOf(status: number, data: Record<string, unknown>, okNotice: string | null): PackActionResult {
  const job = (data.job as JobView | undefined) ?? null;
  if (status >= 200 && status < 300) {
    return { job, notice: typeof data.notice === "string" ? data.notice : okNotice, error: null };
  }
  const error = typeof data.error === "string" ? data.error : "Something went wrong. Please try again.";
  return { job, notice: null, error };
}

const NETWORK_ERROR = "We could not reach the server. Check your connection and try again.";

/** An inline yes or no question under the button that asked it. */
function Confirm({
  question,
  confirmLabel,
  cancelLabel,
  busy,
  danger,
  onConfirm,
  onCancel,
  testId,
}: {
  question: string;
  confirmLabel: string;
  cancelLabel: string;
  busy: boolean;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  testId: string;
}) {
  return (
    <div
      className="mt-2 space-y-2 rounded-lg border border-ink-200 bg-white p-3"
      role="alertdialog"
      aria-label={question}
      data-testid={testId}
    >
      <p className="text-sm text-ink-800">{question}</p>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant={danger ? "danger" : "primary"} loading={busy} disabled={busy} onClick={onConfirm}>
          {confirmLabel}
        </Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={onCancel}>
          {cancelLabel}
        </Button>
      </div>
    </div>
  );
}

export function CancelPackButton({ job, onDone }: { job: JobView; onDone: (result: PackActionResult) => void }) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);

  async function cancel() {
    setBusy(true);
    try {
      const { status, data } = await postJson(`/api/jobs/${job.id}/cancel`);
      track("pack_canceled", { jobId: job.id, status });
      onDone(resultOf(status, data, null));
    } catch {
      onDone({ job: null, notice: null, error: NETWORK_ERROR });
    } finally {
      setBusy(false);
      setAsking(false);
    }
  }

  return (
    <div>
      {!asking ? (
        <Button size="sm" variant="outline" onClick={() => setAsking(true)} data-testid="cancel-pack">
          {job.followUpRunning ? "Stop these shots" : "Cancel pack"}
        </Button>
      ) : (
        <Confirm
          question={
            job.followUpRunning
              ? "Stop the shots that are running again? Credits held for them go back to your balance. Your delivered files stay."
              : "Cancel this pack? Shots still running stop, and every credit held for shots not delivered goes back to your balance."
          }
          confirmLabel={job.followUpRunning ? "Yes, stop them" : "Yes, cancel pack"}
          cancelLabel="Keep it running"
          busy={busy}
          danger
          onConfirm={() => void cancel()}
          onCancel={() => setAsking(false)}
          testId="cancel-confirm"
        />
      )}
    </div>
  );
}

export function RetryShotButton({
  jobId,
  shot,
  title,
  onDone,
}: {
  jobId: string;
  shot: JobShotView;
  title: string;
  onDone: (result: PackActionResult) => void;
}) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);

  async function retry() {
    setBusy(true);
    try {
      const { status, data } = await postJson(
        `/api/jobs/${jobId}/shots/${encodeURIComponent(shot.shotId)}/retry`,
      );
      track("shot_retried", { jobId, shotType: shot.shotType, status });
      const held = typeof data.creditsHeld === "number" ? data.creditsHeld : null;
      onDone(
        resultOf(
          status,
          data,
          held !== null
            ? `Running ${title.toLowerCase()} again. ${held} ${held === 1 ? "credit is" : "credits are"} held and charged only if it passes.`
            : null,
        ),
      );
    } catch {
      onDone({ job: null, notice: null, error: NETWORK_ERROR });
    } finally {
      setBusy(false);
      setAsking(false);
    }
  }

  return (
    <div className="mt-3">
      {!asking ? (
        <Button size="sm" variant="outline" onClick={() => setAsking(true)} data-testid="retry-shot">
          Try this shot again
        </Button>
      ) : (
        <Confirm
          question="Run this shot again? Its credits are held while it runs and charged only if it passes. If it needs review again, they come back."
          confirmLabel="Yes, run it again"
          cancelLabel="Not now"
          busy={busy}
          onConfirm={() => void retry()}
          onCancel={() => setAsking(false)}
          testId="retry-confirm"
        />
      )}
    </div>
  );
}

export function AddPhotoButton({
  jobId,
  shot,
  angleName,
  onDone,
}: {
  jobId: string;
  shot: JobShotView;
  angleName: string;
  onDone: (result: PackActionResult) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send(photo: File) {
    setBusy(true);
    setError(null);
    try {
      const upload = await uploadSourcePhoto(photo);
      if (!upload.ok) {
        setError(upload.message);
        return;
      }
      const { status, data } = await postJson(`/api/jobs/${jobId}/shots/${encodeURIComponent(shot.shotId)}/photo`, {
        key: upload.key,
        sha256: upload.sha256,
      });
      track("shot_photo_added", { jobId, angle: shot.angle ?? null, status });
      const held = typeof data.creditsHeld === "number" ? data.creditsHeld : null;
      const result = resultOf(
        status,
        data,
        held !== null
          ? `Making the ${angleName} shot. ${held} ${held === 1 ? "credit is" : "credits are"} held and charged only if it passes.`
          : null,
      );
      if (result.error) {
        setError(result.error);
        return;
      }
      setFile(null);
      onDone(result);
    } catch {
      setError(NETWORK_ERROR);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-3">
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className="sr-only"
        aria-label={`Photo of the ${angleName}`}
        data-testid="add-photo-input"
        onChange={(event) => {
          const picked = event.target.files?.[0] ?? null;
          event.target.value = "";
          setError(null);
          setFile(picked);
        }}
      />
      {!file ? (
        <Button size="sm" variant="outline" onClick={() => inputRef.current?.click()} data-testid="add-photo">
          Add the {angleName} photo
        </Button>
      ) : (
        <Confirm
          question={`Use ${file.name} as the ${angleName} photo? We make the shots it unlocks. Their credits are held and charged only if they pass.`}
          confirmLabel="Yes, use this photo"
          cancelLabel="Pick another"
          busy={busy}
          onConfirm={() => void send(file)}
          onCancel={() => {
            setFile(null);
            inputRef.current?.click();
          }}
          testId="add-photo-confirm"
        />
      )}
      {error ? (
        <p className={cn("mt-2 text-xs text-red-700")} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
