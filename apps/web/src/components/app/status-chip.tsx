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

export function StatusChip({ status, testId }: { status: string; testId?: string }) {
  return (
    <Badge variant={VARIANTS[status] ?? "default"} data-testid={testId}>
      {status}
    </Badge>
  );
}
