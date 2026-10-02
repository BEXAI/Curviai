/**
 * Disposable email domains (docs/phases/PHASE_20.md P20-30): the vendored
 * CC0 disposable-email-domains list that seed-cli loads into the platform
 * table disposable_email_domains, so the signup grant withholds free credits
 * from temporary inboxes. The source, commit and date go in
 * docs/verification.md when the list is vendored (CLAUDE.md rule 7).
 *
 * Only metadata enters the client barrel. The 130 KB list and its license
 * stay in vendor/ and are read by the Node-only seed CLI, never the app.
 */

export const disposableDomainSeedSource = {
  repository: "https://github.com/disposable-email-domains/disposable-email-domains",
  commit: "0c4fd3aaac31f826cd5d2e698385c6cc53f76336",
  committedAt: "2026-10-02T05:50:24Z",
  verifiedAt: "2026-10-02",
  license: "CC0-1.0",
  file: "./vendor/disposable-email-domains.conf",
  licenseFile: "./vendor/disposable-email-domains-LICENSE.txt",
  sha256: "eec4f833fcac629a2da00bcaad7f431630b28bfee7daee3a676ea6a57a6a815b",
  domainCount: 9199,
} as const;

export const disposableDomainSeedPolicy = { batchSize: 500 } as const;
