import { cn } from "@curvi/ui";
import { ComingSoonBadge } from "@/components/marketing/coming-soon-badge";
import { onTheWay } from "@/lib/billing/plan-features";
import { LARGER_PLAN_EMAIL, LARGER_PLAN_LINE } from "@/lib/billing/plans";

/**
 * Under the plan cards on /pricing and /app/billing (docs/phases/PHASE_20.md
 * P20-08): the one list of plan features that do not run yet, each with the
 * smallest plan that will get it, and the line for a plan larger than Pro.
 * Cards themselves list only what runs. No hooks, so both the marketing and
 * the app plan pickers can render it.
 */
export function OnTheWay({ className }: { className?: string }) {
  const lines = onTheWay();
  return (
    <div className={cn("mx-auto max-w-4xl space-y-4", className)}>
      {lines.length > 0 ? (
        <div className="rounded-xl border border-ink-100 p-6" data-testid="on-the-way">
          <div className="flex items-center gap-2">
            <p className="text-sm font-semibold text-ink-900">On the way</p>
            <ComingSoonBadge />
          </div>
          <ul className="mt-3 grid gap-x-6 gap-y-1 sm:grid-cols-2">
            {lines.map((line) => (
              <li key={line.label} className="text-sm text-ink-500">
                {line.label}, coming soon to {line.plans}.
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <p className="text-center text-sm text-ink-600" data-testid="larger-plan">
        {LARGER_PLAN_LINE}{" "}
        <a
          href={`mailto:${LARGER_PLAN_EMAIL}`}
          className="font-medium text-accent-700 underline underline-offset-2 hover:text-accent-800"
        >
          {LARGER_PLAN_EMAIL}
        </a>
      </p>
    </div>
  );
}
