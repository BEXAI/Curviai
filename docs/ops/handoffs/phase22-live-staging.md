# Live staging and publisher details

Verified 2026-10-02 at 18:34:48 UTC. This supersedes earlier “no live migrations” observations in the dated Phase 21/22 checkpoints. It does not record a new deployment.

## Applied database changes

Supabase project `tmwvjmvzjvpeagatjmud` has **0045 and 0046 applied**. Do not replay them. The prepared wrappers retain their original historical filenames containing `PREPARED-NOT-EXECUTED`; their current state is recorded in [LIVE-MIGRATION-STATE.json](../evidence/2026-10-02-staged-migrations/LIVE-MIGRATION-STATE.json).

| Migration | Applied UTC | Source SHA256 |
| --- | --- | --- |
| 0045 pack resolution cases | 18:27:07 | `1906760bd9b890f72922bb3dc9a75ab58e82081a3637fc7384a922d953f45380` |
| 0046 workspace credit budgets | 18:30:57 | `7a90bfdeda33f6659d70f0b31ef89b7eb51ceab3d11276ac05a43091fb7d2983` |

Both transactions used the reviewed exact-source wrapper with prior journal/hash guards, advisory lock, 5-second lock timeout and 60-second statement timeout. Independent journal reads followed each mutation. The original wrapper SHA256 values are `60c49ba69837aad8116085e878630fd965f73139b5f7be6dd32ccd3065b5bfaf` and `763771c1f0f80d15015f262d408b6c9e5827b2126cf90020f6a489b06617e4b8`.

The [staged postflight](../evidence/2026-10-02-staged-migrations/postflight-0045-0046-READ-ONLY.sql) reached its final result after asserting all 47 journal hashes, five RLS tables, exact policy/grant restrictions, server definer permissions, complete ledger visibility and absence of 0047. No configured or enabled budget exists. Before/after metadata showed identical reservation function identity and effective EXECUTE permissions for all 30 roles: only postgres, service_role and supabase_admin can execute; PUBLIC, anon and authenticated cannot. The new budget snapshot is stable, SECURITY DEFINER, has a pinned public search path and can read the complete ledger.

The [final proof result](../evidence/2026-10-02-staged-migrations/live-staged-final-proof-normalized-20261002T1834.json) preserves the direct readback. Root and an independent reviewer inspected all four tenant SELECT expressions: cases are visible to their workspace reporter or owner/admin; case events require a visible case in the same workspace; budgets and audit require workspace owner/admin. Private notes expose no customer SELECT policy.

The [SQL editor](https://supabase.com/dashboard/project/tmwvjmvzjvpeagatjmud/sql/6c495900-f01a-4118-a11b-0c09b498ff7f) now contains the saved [read-only final proof](../evidence/2026-10-02-staged-migrations/final-0045-0046-PROOF-READ-ONLY.sql), SHA256 `25a95082eeaf5afd1517900d7c6f028151fac6b28ff504d6e6789426344690b8`. Save is disabled and editor bytes match the local proof. Existing user SQL was preserved. No secrets or customer content were inspected.

## Remaining database release gate

**0047 is unapplied.** Quiesce every old job writer, including web requests, workers, scheduled recovery and read-triggered reconciliation, then coordinate 0047 with the compatible application and worker deployment. The old deployed `dae0fb0` can retain `done` after a failed/canceled run with an existing report. The new trigger would record that incorrect terminal event even with no webhook endpoint configured. A momentary zero-active-job count cannot establish compatibility.

The prerequisite PR 6 security gate remains unresolved. Do not deploy around it or weaken scanners. Once cleared, use the reviewed 0047 wrapper and full postflight, verify new process versions, and only then resume writers. Keep budgets unset until compatible budget handling is deployed. Public health still reports old-code cached 0044; direct journal evidence above is authoritative for the staged database.

## Legal source and publishing preparation

The founder authorized public use of AIManagement Inc. and 131 Continental Drive, Suite 305, Newark New Castle, DE 19713. Shared Terms and Privacy now use those exact details. Delaware incorporation and establishment in 2025 are user-provided facts. Governing law remains unset; publisher verification and action-time legal attestations remain separate. No acceptance records or verified-name manifest placeholders changed.

The isolated publisher-details candidate is based on PR 9 head `70c6036f7eddbc951e8642157fb5f1a282649ec2`. Full Node 22 lint/types, 6,842 local unit tests, production build and 199 browser tests passed. Local skips comprise 14 PostgreSQL cases covered in the hosted database job and one unavailable-ffmpeg diagnostic because ffmpeg is installed. Independent code review found no material concern. Hosted verification for this new candidate follows publication.

The OpenAI publishing portal is signed in and shows BEXAI organization. No new Curvi organization/project, verified identity, uploaded ZIP or submitted listing is claimed. Dedicated test/reviewer accounts, test OAuth setup and supplied sample assets are authorized. Exact account/project settings, numeric spend/credit ceilings, real ChatGPT proof, governing law/counsel and required attestations remain pending.

Raw catalog captures, separate journal verification, local PGlite replay/negative-case proof and the independent staging review remain in `/tmp/curvi-phase21-migration-review` and `/tmp/curvi-live-staging-review.md`. Those temporary files may not survive workspace cleanup; the durable read-only SQL, final result and execution-state record are linked above. Intermediate postflight assertions are evidenced by reaching the final grid, rather than individually exported rows.
