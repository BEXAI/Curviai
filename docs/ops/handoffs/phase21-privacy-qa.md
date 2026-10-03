# Phase 21 privacy and browser acceptance handoff

Status: implementation and focused checks complete. Root's shared production build and 195 browser checks passed; the final assistant budget disclosure needs a targeted privacy browser rerun after rebuild.

## Changes

- Workspace exports require an owner or admin in both builders. The existing route already checks the same roles.
- Added explicitly projected public case history and replies. Operator notes, operator identities and internal request bookkeeping are neither queried nor serialized. The export remains scoped to the selected workspace.
- Added current credit budget and change history, including owner actor IDs and prior/new limits. No provider or payment data is added.
- Added completion endpoint lifecycle, terminal event and delivery status metadata. Destinations expose only their HTTPS origin. Signing ciphertext, key IDs, verification state internals, URL credentials, paths, query strings, fragments and delivery leases are excluded. Receiver response bodies are not stored or exported.
- Existing bounded operational retention now deletes resolved cases after the seeded 180 days, budget change audit after 365 days, and completion events after 30 days. Parent deletion cascades case events/private notes and webhook deliveries. Open cases, current budget settings and endpoints remain until their explicit deletion or workspace deletion. Existing source-photo expiry is unchanged.
- Privacy retention copy reads the same seeds as the purge. Its fingerprint was updated on the existing 2026-10-02 release date.
- The assistant privacy field inventory and disclosure include the optional monthly budget, monthly limit, remaining headroom, active holds, delivered credits used this month and UTC period boundaries. No provider or financial account details are disclosed.
- Added `e2e/phase21.spec.ts`: durable report submission, reload, duplicate-category handling and keyboard reply; sparse-history credit planning and history links; inactive demo webhook setup and receiver contract. Each journey includes serious/critical WCAG accessibility checks. All use demo/local fixtures and create no external receiver requests.

## Focused evidence

- `pnpm --filter @curvi/web exec vitest run src/lib/trust/export.test.ts src/lib/ops/retention.test.ts src/lib/legal/retention.test.ts src/lib/legal/facts.test.ts src/lib/legal/pages.test.ts src/app/api/account/export/route.test.ts src/app/api/account/export/route-access.test.ts`: **7 files, 51 tests passed**. Log: `/tmp/curvi-p21-privacy-tests.log`.
- ESLint on all ten changed/new implementation and test files: passed. Log: `/tmp/curvi-p21-privacy-lint.log`.
- `pnpm --filter @curvi/web typecheck`: passed. Log: `/tmp/curvi-p21-privacy-types.log`.
- Database fixtures cover tenant filtering, exclusion of sensitive values, member-role denial, retention cutoff boundaries, dry runs, repeated purge, cascade removal and workspace deletion. A database-controlled run UUID is read back before fixture event creation.
- Final schema integration: the retention fixture reads the endpoint revision returned by its insert and uses it for both delivery rows. Export fixtures already use the returned revision.
- Final focused rerun, including `src/app/(marketing)/privacy/assistant-fields.test.ts`: **8 files, 56 tests passed**. Log: `/tmp/curvi-p21-privacy-finalfix-tests.log`. Changed-file lint and diff checks passed; lint log: `/tmp/curvi-p21-privacy-finalfix-lint.log`.
- Root reported and the E2E log confirms the production build and **195 browser tests passed**, including the three Phase 21 journeys, before the final disclosure sentence was added.

## Remaining verification

Root owns the shared production build and complete browser gate. The only final production source change is the privacy policy's assistant budget disclosure sentence. Targeted browser reruns should cover `e2e/assistant-site.spec.ts` and `e2e/legal.spec.ts` after rebuild. Actual webhook receiver setup/delivery and live seller-support pilots remain separately authorized acceptance work. This lane made no migration, Git, live SQL, deployment, credential or environment changes.
