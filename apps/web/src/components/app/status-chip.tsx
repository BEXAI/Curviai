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
};

/** Pipeline states that are actively working and get a live pulsing dot. */
const ACTIVE = new Set(["analyzing", "planning", "generating", "qc", "packaging"]);

export function StatusChip({ status, testId }: { status: string; testId?: string }) {
  return (
    <Badge variant={VARIANTS[status] ?? "default"} data-testid={testId}>
      {ACTIVE.has(status) ? (
        <span className="size-1.5 animate-pulse-dot rounded-full bg-current" aria-hidden="true" />
      ) : null}
      {LABELS[status] ?? status}
    </Badge>
  );
}
