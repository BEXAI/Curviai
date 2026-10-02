/** P21-02 customer credit planning. These limits never change credit prices. */
export const creditPlanningPolicy = {
  period: "utc_calendar_month",
  observationDays: 30,
  minimumHistoryDays: 14,
  minimumActiveDays: 3,
  minimumActivitySpanDays: 7,
  maxMonthlyCredits: 1_000_000_000,
  creditStep: 0.1,
  auditRetentionDays: 365,
} as const;
