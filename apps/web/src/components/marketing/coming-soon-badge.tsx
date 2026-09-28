import { cn } from "@curvi/ui";
import { COMING_SOON_LABEL } from "@/lib/marketing-facts";

/**
 * The label every feature that does not run in production carries on the
 * marketing site (Phase 10 decision 1). Tone "dark" suits the night sections
 * of the home page, "light" the white pages.
 */
export function ComingSoonBadge({ tone = "light", className }: { tone?: "light" | "dark"; className?: string }) {
  return (
    <span
      data-testid="coming-soon"
      className={cn(
        "inline-flex shrink-0 items-center rounded-full px-2.5 py-0.5 text-xs font-medium",
        tone === "dark" ? "bg-white/10 text-ink-200 ring-1 ring-inset ring-white/15" : "bg-amber-100 text-amber-800",
        className,
      )}
    >
      {COMING_SOON_LABEL}
    </span>
  );
}
