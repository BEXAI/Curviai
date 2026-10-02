# Customer readiness handoff

Verified locally on 2026-10-02 in `/tmp/curvi-phases-18-20` with Node 22.23.3. This records implementation and local proof, not production activation.

## Delivered

- Auth confirmation uses a scanner-safe GET interstitial and origin-checked POST. Signup, recovery and email-change token hashes preserve safe same-origin destinations and OAuth consent continuation. Fixed auth error copy, seeded resend cooldown and fresh Turnstile tokens cover signup, password and resend forms.
- Email change requires a verified session, preserves hashed suppression entries and updates only owner/admin Stripe customer records whose existing email matches the prior address. Confirmed changes retry their downstream synchronization on sign-in.
- Support sends through the transactional sender with seeded user/IP limits, honeypot, CAPTCHA for unsigned acknowledgements and workspace-scoped job attachment. Demo mode states that it sends no message. Unusable-pack feedback has a deduplicated founder notification.
- Searchable grouped help has individual published article URLs and Article structured data. Billing, refund and team gates stay consistent across page rendering, index and sitemap. Official marketplace source links are visible. Status exposes fixed customer labels; changelog does not invent shipped releases.
- App navigation supports mobile menus, keyboard focus, Escape, outside click and operator-only Ops access. Pack UI includes scoped regeneration with the server-provided credit confirmation, queue estimates and contextual support. Disposable-email grant notices, branded errors/404s and an explicitly configured staging banner are present.
- Operator security supports TOTP enrollment, challenge, verified AAL2 checks and owned-factor removal with audit intent before mutations and founder notices. Password-only sessions cannot replace an existing verified factor. Lost-factor recovery remains an administrative runbook, not a public bypass.
- App browser error capture uses the restricted Sentry tunnel. An actual installed SDK envelope is accepted and scrubbed. Browser initialization is currently scoped to the app shell and error boundaries to preserve the marketing script budget.

## Evidence

- Focused customer/auth/support/feedback/pack/security suite: **17 files, 254 tests passed**.
- Confirmation route: **6 passed**. Support and email-change HTTP routes: **7 passed**. Resend cooldown/token handler: **1 passed**. Customer shell plus actual Sentry SDK envelope compatibility: **4 passed**. Legal pages: **15 passed**. Some focused suites overlap; do not add these counts as a repository-wide total.
- Final customer browser and six-page axe run: **10 passed (41.8 seconds)**. Routes audited: `/app`, `/app/new`, `/app/products`, `/app/library`, `/help`, `/gallery`; no serious or critical WCAG 2 A/AA or 2.1 AA violations. Initial footer/gallery contrast findings were fixed before this passing run.
- Existing assistant-site, claims, legal and attribution browser regression: **26 passed**.
- Next production build, scoped ESLint and web TypeScript checks passed. Final `pnpm --filter @curvi/web typecheck` passed after the last support/email/resend tests.
- No local server or port 3100 ownership remains. Root may run the release build. This agent did not make a live database change, send real mail, use a paid provider, create credentials or activate a production feature.

## Remaining gates and limits

- Founder must configure Supabase email templates for the token-hash confirmation route, encoded destination and correct confirmation type, then prove signup, recovery, dual-address email change and OAuth continuation across devices. Live CAPTCHA configuration and signed-in support mail/acknowledgement delivery also need staging proof.
- Validate Stripe email synchronization and suppression retention with an authorized staging account. Confirm operator enrollment, AAL2 protection, founder notices and lost-factor recovery on the configured Supabase project. The UI cannot establish these external settings by itself.
- MFA audit intent prevents mutation when the initial audit fails. A later completion-audit or notification transport exception can occur after Supabase has changed a factor; refresh the factor list before retrying. There is no claim of an atomic transaction across Supabase, Postgres and mail.
- P20-43 paging stays deferred until a workspace exceeds 30 products or 100 images. P20-59 invites/switcher stays deferred until the first team/Agency request. P20-60 through P20-63 remain gated by Release 4 and their explicit prerequisites. Refund and team help articles remain unpublished until their policy/product gates open.
- Browser checks used local demo fixtures. They do not prove live providers, live auth, email delivery, production monitoring ingestion or full manual assistive-technology coverage.

## Official evidence

Supabase auth/email, verifyOtp/resend/updateUser and TOTP references; Cloudflare Turnstile validation/testing references; and marketplace help sources were sent to the parent for the central verification log, retrieved 2026-10-02. Administrative recovery signature additionally verified in the current official [Supabase SDK source](https://raw.githubusercontent.com/supabase/supabase-js/master/packages/core/auth-js/src/GoTrueAdminApi.ts): `auth.admin.mfa.deleteFactor({ userId, id })` deletes the specified user's specified factor. The old standalone auth-js repository is archived.

## Integration follow-up and P20-21

The shared full-suite pass found old synchronous page-render expectations and the terms-IP fixture still trusting an unsigned Cloudflare header. Updated those tests to the async support/notice and published article contracts and current trusted-proxy behavior. Fixed the actual withheld-credit notice placement to the signed-in dashboard; its lookup has focused current-user/no-session/failure tests. The seven-file regression batch passed **59 tests**, including deployment inventory 7 and tick shell 4. Web typecheck, scoped ESLint and diff whitespace checks pass.

The final combined Next rebuild and customer accessibility/readiness rerun passed **10 tests in 48.2 seconds**. The axe test now waits for Next's streamed nonempty document title as well as the page heading before auditing; the integrated run had otherwise sampled `/app` between those two render events. Log: `/tmp/curvi-customer-final-e2e.log`. Build and local port ownership are released again.

P20-21 repository work is complete: `render.yaml` declares the web service, isolated encrypted-backup cron and shared HTTP tick cron; Docker installs both scripts. The tick keeps bearer/monitor credentials out of process arguments, bounds the POST, sends start/success/failure heartbeats and cleans temporary files on failure. Source AST scanning covers direct and injected names, seeded Stripe prices/portal configurations and staging CLI prefixes. It checks the launch inventory and rejects backup secrets on web or web secrets on a cron. `docs/LAUNCH_CHECKLIST.md` now contains the full scoped inventory and replaces the obsolete Trigger.dev Cloud setup.

The Blueprint passed local validation against Render's official [draft 2020-12 schema](https://render.com/schema/render.yaml.json), fetched 2026-10-02. `checksPass` automatic deployment is preserved. Render ignores `sync: false` within an environment group, so `curvi-common` uses a generated cron capability only for new installations; the adoption procedure requires preserving the existing secret before first sync. `--prod=false` explicitly installs the build toolchain even with `NODE_ENV=production`, per [pnpm 10 install documentation](https://pnpm.io/10.x/cli/install).

P20-21 acceptance still requires the founder's Blueprint preview with no duplicate/suffixed resource or overwritten environment value, explicit cron adoption/provisioning, current dashboard values, real heartbeat/backup proof, and the protected `.env.example` update. That file was never read or changed. The Docker image itself was not built locally. No Blueprint or dashboard was applied by this agent.

## Next-phase planning

Customer implementation and P20-21 repository work are frozen. Added `docs/phases/PHASE_21.md` as a proposal only: seller-visible resolution cases, workspace credit planning with separately gated owner budgets, and private API completion webhooks. The third explicitly promotes the delivery foundation of P19's existing Events backlog without activating MCP Events. All proposals cite existing code, define scope/dependencies/security/acceptance/external setup, and preserve unfinished Phase 18–20 defects and live gates in their original phases. No new feature was implemented. Verified all 14 local document links resolve and all three proposal IDs are unique. Independent schema/security review found one acceptance gap, now fixed: inherited `no_oauth_clients` and direct client-role privilege tests, including attempted owner-budget bypasses.
