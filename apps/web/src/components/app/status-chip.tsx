import { Badge, type BadgeVariant } from "@curvi/ui";

const VARIANTS: Record<string, BadgeVariant> = {
  queued: "outline",
  analyzing: "default",
  planning: "default",
  generating: "warning",
  qc: "warning",
  packaging: "default",
  done: "success",
  failed: "danger",
  canceled: "outline",
  pending: "outline",
  // A shot that did not pass was released at no charge: amber, never red.
  needs_review: "warning",
  skipped: "outline",
};

const LABELS: Record<string, string> = {
  queued: "Queued",
  analyzing: "Analyzing product",
  planning: "Planning shots",
  generating: "Generating",
  qc: "Quality check",
  packaging: "Packaging files",
  done: "Done",
  failed: "Failed",
  canceled: "Canceled",
  pending: "Pending",
  needs_review: "Needs review",
  skipped: "Skipped",
};

/** Pipeline states that are actively working and get a live pulsing dot. */
const ACTIVE = new Set(["analyzing", "planning", "generating", "qc", "packaging"]);

export function statusLabel(status: string): string {
  return LABELS[status] ?? status;
}

export function StatusChip({ status, label, testId }: { status: string; label?: string | null; testId?: string }) {
  return (
    <Badge variant={VARIANTS[status] ?? "default"} data-testid={testId} data-status={status}>
      {ACTIVE.has(status) ? (
        <span className="size-1.5 animate-pulse-dot rounded-full bg-current" aria-hidden="true" />
      ) : null}
      {label || statusLabel(status)}
    </Badge>
  );
}
