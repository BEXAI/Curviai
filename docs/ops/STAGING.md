# Staging and real-stack smoke

Local scaffolding is implemented. No staging accounts, credentials, service, webhook or paid smoke have been created or enabled by this change. P20-54 acceptance still requires a deployed staging SHA, the environment banner and a Stripe test purchase that grants credits through staging's own webhook. P20-55 also needs matched staging/production smoke evidence and seven days of the explicitly enabled synthetic run with verified metric exclusion.

## Separate resources

Apply `render.staging.yaml` explicitly as the Blueprint path. It creates only the `curvi-staging` web service: Node 22, `plan: free`, main after CI passes, one pack and one shot at a time. The production Blueprint remains `render.yaml`. Render's current free plan has 512 MB RAM and 0.1 CPU; monitor cold starts and memory before approving a real pack. See [Render's Blueprint specification](https://render.com/docs/blueprint-spec) and [free service limits](https://render.com/docs/free), checked 2026-10-02.

The founder must create and record these resources outside source control:

| Resource | Staging setting |
| --- | --- |
| Supabase | A separate Free organization and project, with its own database, anon key, service role key and Auth users. Do not copy production customer rows. Keep `STAGING_DATABASE_URL` and `STAGING_SUPABASE_URL` in the founder's restore-drill environment so its target guard recognizes staging. |
| R2 | Private `curvi-staging` bucket; a separate token scoped to this bucket. Apply the reviewed `ops/r2/lifecycle.json` rules and its staging origin CORS. Never reuse the backup bucket or production write token. |
| Render | The separate Blueprint above. `NEXT_PUBLIC_SITE_URL` must equal the exact staging origin; production host validation otherwise refuses API calls. `NEXT_PUBLIC_ENV_LABEL=staging` must be present at build time. |
| Stripe | Separate test-mode products/prices, test secret and webhook signing secret, and a test endpoint at staging's `/api/webhooks/stripe`. Supply every self-serve price using `docs/STRIPE_SETUP.md`; do not configure production prices or live keys here. |
| Turnstile | Always-pass test site key and secret from [Cloudflare's testing documentation](https://developers.cloudflare.com/turnstile/troubleshooting/testing/), also set as the CAPTCHA secret in staging Supabase Auth. Production secrets reject dummy tokens. |
| Providers | Add restricted staging provider credentials only after approving the real-pack check and its spend ceiling. Consult the provider targets/limits in the seed and health report. Missing provider keys are an honest readiness failure. No provider secret or balance is committed. |
| Email | Staging sender/domain and test recipients only. Leave optional lifecycle mail and founder reporting unset until its intended recipients are configured. |
| Smoke user | A confirmed staging Auth user. For API smoke, its workspace must be owned by an email in staging's `OPS_EMAILS`, with API access and enough test credits granted via the audited operator tool; create a staging-only key. The server verifies operator ownership before any pack is created. |

The [Supabase billing FAQ](https://supabase.com/docs/guides/platform/billing-faq) describes the two active Free-project allowance across owner/admin memberships. Confirm eligibility before creating a project. Current [Free-project pausing guidance](https://supabase.com/docs/guides/platform/free-project-pausing) identifies low activity over seven days and database requests as activity; a daily smoke may help, but it does not guarantee the project will stay active. Both checked 2026-10-02.

**Staging is never a restore target.** It is public, auto deployed and may hold provider keys. Restore production backups only into the isolated local or explicitly named throwaway drill described in [BACKUP_RESTORE.md](BACKUP_RESTORE.md).

## Setup and acceptance

1. Create the separate resources and set only their own values in Render. Apply migrations to the staging database, then review/seed its recipes and switches. Follow the same migration checks as production.
2. In staging Supabase Auth set its own site URL, exact allowed redirects, SMTP/test sender, confirmation templates and test CAPTCHA secret. Do not enable the P19 OAuth public flag as part of this work; use its separate review runbook if testing OAuth later.
3. Configure Stripe test prices and endpoint, then verify checkout readiness. Complete one test card purchase manually and check the staging webhook grant and ledger. No live card or production account is used.
4. Wait for CI and the staging deploy. Confirm the banner, `noindex`, expected commit, `/api/status`, and health findings. A free web service does not create scheduled tick/backup resources: decide its operational monitoring/scheduling separately. Never write fake success rows to clear health. Strict smoke requires health `status: ok` and will expose missing cron, provider, storage or billing setup.
5. Run staging and production light smoke against the same deployed SHA using the commands below. Record date, full SHA, mode, result and any skipped steps in `docs/verification.md`. Do not record passwords, API keys, signed URLs or screenshots containing them.

## Smoke modes

`playwright.smoke.config.ts` uses an existing `SMOKE_BASE_URL` and never starts a server. Its defaults are local demo only. Normal `pnpm e2e` does not discover the `.smoke.ts` tests. `pnpm smoke` selects them explicitly.

| Mode | Credentials | Work |
| --- | --- | --- |
| `demo` | None; loopback only | Health, marketing pages, public status and MCP; sign in and pack skipped. This runs on every PR/main push in the Smoke workflow. |
| `production` | None; canonical Curvi host only | Health/commit, marketing, status and MCP. It never signs in or makes a pack, even if pack variables are accidentally present. |
| `staging` | `SMOKE_USER_EMAIL`, `SMOKE_USER_PASSWORD`; staging API key only for enabled pack | Public checks plus sign in with staging's test CAPTCHA. One pack only when `SMOKE_ALLOW_PACKS=1`. The staging banner is checked before credentials or a pack are sent. |
| `synthetic` | Production operator `SMOKE_API_KEY` | API only, no browser sign in. One `amazon.main`, `bundle: main` pack, poll to completion, download ZIP and inspect the included main image's seeded dimensions and white corners. Requires `SMOKE_ALLOW_PRODUCTION_PACK=1` and `SMOKE_WORKSPACE_EXCLUDED=1`. |

The staging pack uses the same API/ZIP/image verification as the synthetic run. Both first call `GET /api/v1/smoke-context` with `packs:read`; it returns only the caller's own workspace ID and `excluded: true` when authoritative membership/Auth rows identify an operator-owned workspace. An unknown, non-operator or unavailable context stops the test before any paid request. The endpoint is documented in OpenAPI. The fixture is the repository's sample product. No automatic retry creates a second pack; reruns of the same GitHub run share an idempotency key. All traces, screenshots and videos are off. `unzip` must be installed for the ZIP check (present on GitHub's Ubuntu runners and macOS). Temporary ZIP bytes are deleted after the check.

An OAuth-enabled MCP server correctly returns `401` plus protected-resource metadata to unauthenticated `initialize`. Public smoke then checks `server/discover`; it never supplies a production credential to bypass that challenge. This verifies the public transport boundary, not P19's signed-in client acceptance.

```sh
# Start the demo separately before this command.
SMOKE_BASE_URL=http://localhost:3100 SMOKE_MODE=demo pnpm smoke

# Read-only public smoke used by a release after the deployment is live.
SMOKE_BASE_URL=https://curvi.ai SMOKE_MODE=production SMOKE_EXPECTED_SHA=<deployed-sha> pnpm smoke

# Supply staging credentials privately in the process environment.
SMOKE_BASE_URL=https://<staging-host> SMOKE_MODE=staging SMOKE_EXPECTED_SHA=<deployed-sha> pnpm smoke
```

Paid packs are intentionally absent from these example commands. The founder must explicitly approve the environment, fixture, current provider cost and daily ceiling before enabling their opt-ins.

## Workflow controls

`.github/workflows/smoke.yml` supports dispatch, the daily schedule and PR/main demo checks. No remote daily job runs until its repository variable is enabled:

- `SMOKE_PUBLIC_ENABLED=1`: daily public production checks; no credentials or paid pack.
- `SMOKE_STAGING_ENABLED=1`, `STAGING_SITE_URL`, staging environment secrets `SMOKE_USER_EMAIL` and `SMOKE_USER_PASSWORD`: daily staging public/sign-in checks. `SMOKE_STAGING_PACK_ENABLED=1` plus secret `SMOKE_STAGING_API_KEY` separately authorizes its daily pack. A dispatch also requires its `allow_pack` checkbox.
- `SMOKE_SYNTHETIC_ENABLED=1` and `SMOKE_WORKSPACE_EXCLUDED=1`, with secret `SMOKE_API_KEY` in the `production-smoke` environment: daily production synthetic pack. Configure an environment approval rule for manual runs if desired; dispatch additionally requires `allow_pack`. Keep all these variables absent until explicitly approved.

`lib/customer-metrics.ts` resolves operator ownership and supplies the shared SQL filter used by the funnel/repeat-retention report, weekly customer revenue/pack/support metrics, unit economics, overview customer counts and customer alert samples. The existing lifecycle sender excludes operator owners too. Synthetic API requests carry no browser cookie or client analytics, so they do not trigger browser conversion tracking. Actual global/provider spend, all-pack COGS, workspace safety caps, stale/queued recovery alerts and runner health deliberately retain synthetic work. The weekly email labels customer metrics separately from total costs.

`SMOKE_WORKSPACE_EXCLUDED` records the operator's enabling decision; it is not the proof. The read-only endpoint independently verifies the same database policy before every paid smoke. Tests cover an operator and customer together, exclusion from customer revenue/funnel/economics, preserved actual spend/caps and operational stale-job alerts, and refusal of a different workspace's key. A week of live exclusion evidence is still an acceptance gate. Do not claim P20-55 complete until the seven daily results exist.

Disable a failing paid schedule by removing its enable variable. Inspect the existing pack and its ledger/provider records before rerunning. Do not rotate API keys or buy more credits just to make a smoke pass without diagnosing the failure.
