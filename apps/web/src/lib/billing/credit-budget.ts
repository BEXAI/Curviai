import { creditPlanningPolicy } from "@curvi/pipeline/seed";
import { z } from "zod";
import type { CreditBudgetView } from "./credit-planning";

export const CREDIT_BUDGET_MESSAGE = "This work exceeds the workspace credit budget for this UTC calendar month. Choose fewer images, wait for existing holds to settle or ask the owner to change the budget in Billing.";
export const CREDIT_BUDGET_OWNER_MESSAGE = "Only the workspace owner can change the credit budget.";
export const CreditBudgetInput = z.object({
  monthlyLimit: z.number().finite().min(0).max(creditPlanningPolicy.maxMonthlyCredits)
    .refine((value) => Math.abs(value * 10 - Math.round(value * 10)) < 0.00001, "Use at most one decimal place.").nullable(),
}).strict();

/** Inspect only the stable SQLSTATE, including a Drizzle-wrapped driver error. */
export function isCreditBudgetExceeded(error: unknown): boolean {
  let current = error;
  for (let i = 0; i < 5 && current && typeof current === "object"; i += 1) {
    if ((current as { code?: unknown }).code === "CU429") return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}
export function creditBudgetRejection(creditsNeeded: number) {
  return { outcome: "rejected" as const, reason: "credit_budget_exceeded" as const,
    message: CREDIT_BUDGET_MESSAGE, creditsNeeded };
}
export function creditBudgetEstimateLine(budget: CreditBudgetView, creditsNeeded: number): string | null {
  if (budget.remaining === null || budget.monthlyLimit === null) return null;
  const left = Math.max(0, budget.remaining).toLocaleString("en-US", { maximumFractionDigits: 1 });
  return `${left} credits of this month's workspace budget remain after delivered work and active holds.${creditsNeeded > budget.remaining ? " This estimate exceeds the budget. Ask the owner to adjust it in Billing or choose fewer images." : ""}`;
}
