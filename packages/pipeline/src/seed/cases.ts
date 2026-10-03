/** Phase 21 pack-case policy. Changes require a matching retention/reopening review. */
export const packCasesPolicy = {
  reopenDays: 30,
  resolvedRetentionDays: 180,
  messageMaxChars: 2000,
  timelinePageSize: 100,
  casePageSize: 50,
  operatorPageSize: 100,
} as const;
