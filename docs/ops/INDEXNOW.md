# Curvi IndexNow

This is a manual operator tool for meaningful changes to Curvi's public pages. It complements `https://curvi.ai/sitemap.xml`. It installs no schedule, hook, database table or background worker. Bing Webmaster Tools remains the source for crawl and indexing diagnostics.

## Before enabling

1. Check Bing Webmaster Tools and the hosting/CDN settings for an existing IndexNow integration. Use one notification path. The source audit on 2026-10-03 found no implementation; the authenticated Bing console showed onboarding, not an active submission history.
2. Deploy and verify the tested application normally. Do not initialize or submit during maintenance, partial rollout, or a failed sitemap/page fetch. Apply the separate schema/runtime handoff before deploying dependent code.
3. Have the owner authorize the exact IndexNow ownership setup. An IndexNow proof is a public domain-verification value, not a Bing account API key, password, OAuth grant or analytics key. This tool never generates one. Configure the approved `INDEXNOW_KEY` using the hosting service's secure environment editor and securely supply the same variable to the local command environment. Do not paste it into chat, a shell command argument, a source file or a report. No `NEXT_PUBLIC_` variable is used.
4. The application serves the proof only at the exact root `/{key}.txt` path. Missing/invalid configuration and any other filename return 404. The response is UTF-8 plain text, `no-store`, and `noindex`. It is intentionally public for domain validation. No value is printed by the CLI. A submit run checks this file before sending anything.
5. The command uses existing Node 22/pnpm dependencies and Playwright Chromium for offline HTML/XML parsing. On a new operator machine, install the project's dependencies and Chromium through your normal approved developer setup. Parsing disables page JavaScript and browser network access; site retrieval is bounded HTTPS GET without cookies. No provider generation, credentials from env files, or database access is used.

## Initialize and review

Choose a dedicated persistent directory outside the checkout. Its parent must already exist. The tool creates the leaf with mode 0700 and keeps its files at 0600. Do not use a shared directory or a temporary filesystem if you need deduplication to survive machine restarts.

```sh
pnpm ops:indexnow initialize --state-dir /absolute/private/curvi-indexnow
pnpm ops:indexnow plan --state-dir /absolute/private/curvi-indexnow
pnpm ops:indexnow status --state-dir /absolute/private/curvi-indexnow
```

`initialize` takes a baseline and sends zero notifications. It refuses to replace an existing baseline. This prevents a first run from submitting all historical pages. Older content remains discoverable through the sitemap; do not delete state to trigger a bulk submission.

`plan` scans and reports proposed changes without updating the baseline or submitting. It uses only exact `https://curvi.ai` public URLs from the sitemap, plus previously public URLs that need a deletion check. A page must return 200, permit indexing and have exactly one matching canonical URL. Private/token paths, query strings, fragments, credentials, redirects and foreign hosts are rejected or excluded. Login/signup and approved gallery pages retain their existing indexing choices. Robots rules, including named Bing crawler rules, are respected; no GPTBot preference changes.

The fingerprint uses server-rendered title, description and main content, including relevant links/images. Scripts, CSS, deployment identifiers and common page chrome are excluded. Cosmetic asset rebuilds alone do not notify every page. Sitemap `lastmod` is kept as metadata, not used as a substitute for meaningful change detection. The three policy dates already come from their maintained displayed content dates; no request/build dates are invented.

Removed URLs are notified only if they were previously public and now actually return 404 or 410. Losing sitemap membership while a page still exists, or acquiring noindex/robots restrictions, does not submit it as a deletion. Any transport/server/maintenance failure aborts the complete scan before state is changed. The scan is capped at 1,000 combined current/previous URLs, bounded response sizes and five minutes. Growth beyond this cap requires a reviewed limit change, not a partial scan.

The scanner identifies itself as `CurviIndexNowBot`. The public share-page counter now uses the existing visitor bot/prefetch filter, so these audits do not inflate human share views. Offline parsing runs no visitor beacon or client analytics.

## Submit only changes

```sh
pnpm ops:indexnow submit --state-dir /absolute/private/curvi-indexnow --execute
```

The command scans again, persists the changed eligible inventory, verifies ownership, and posts to **one** endpoint: `https://api.indexnow.org/indexnow`. Participating search engines share IndexNow notifications; do not duplicate them across Bing and the global endpoint.

Local defaults are 100 URLs per run, 100 per batch and 500 URL attempts per UTC day, counting retries. `--max-urls` can lower or raise the per-run cap up to 500. These are conservative local limits, not a published universal IndexNow daily quota. The protocol permits up to 10,000 URLs per request; this tool deliberately stays lower. A changed URL waits at least five minutes after its previous attempt. Retryable 429/5xx responses stop the entire run and persist an endpoint-wide delay, honoring both forms of `Retry-After` and exponential backoff. A later manual run resumes due work; there is no hidden timer. Each content version has at most three classified attempts before operator review is required.

The state file records each URL's latest fingerprint/outcome, quota usage and the latest 200 batch events. It contains no ownership key, response body, raw HTML, cookies or visitor identifiers. A callback-wide exclusive lock prevents concurrent processes sharing the directory. Each request reserves its attempt and quota durably before POST; classified responses are saved with an atomic replacement. If a write fails, further submissions stop. Keep and reuse this directory across runs; a separate directory/machine has a separate local quota, so do not run competing copies.

| Outcome | Meaning | Next action |
| --- | --- | --- |
| `baseline` | Existing page observed; no notification sent | Wait for a meaningful change |
| `queued` | Eligible change waiting for its cap/debounce window | Review and run submit when due |
| `accepted` | HTTP 200 receipt | Check Bing for crawl/index evidence |
| `key_pending` | HTTP 202 receipt; ownership validation pending | Inspect ownership/console; unchanged content is not reposted automatically |
| `retryable` | 429 or 5xx, next attempt time persisted | Run manually after the delay |
| `failed` | Refusal or three attempts exhausted | Correct the cause and explicitly queue a retry |
| `unknown` | Network timeout or interrupted attempt may have arrived | Review before allowing a possible duplicate |
| `excluded` | Previously tracked URL is no longer eligible | No notification sent |

Neither 200 nor 202 means indexed. Indexing stays `unknown` until an operator separately records a current Bing URL Inspection observation:

```sh
pnpm ops:indexnow record-indexing --state-dir /absolute/private/curvi-indexnow --url https://curvi.ai/pricing --result indexed --observed-at 2026-10-03T12:00:00Z --confirm-bing-observation
```

Use the actual observed timestamp and result (`indexed` or `not_indexed`), not the example. The record is labelled `operator_recorded_bing_inspection`; it is not an API verification or guarantee. A content or eligibility change resets this separate indexing observation to unknown. A deleted or newly noindex page can still appear in Bing until its index catches up: record that observed `indexed` result for the tracked URL. A deletion notification is not evidence of removal from the index.

## Failure recovery

Exit 0 means the command completed; an accepted/key-pending submission still does not establish indexing. Exit 2 means queued/deferred/refused/ambiguous work remains. Exit 1 indicates setup, scan, state or command failure. Inspect `status` and the console before retrying. The CLI never logs response bodies or the key, and does not read env files.

```sh
pnpm ops:indexnow retry --state-dir /absolute/private/curvi-indexnow --url https://curvi.ai/pricing
# Only after reviewing an UNKNOWN request that may already have arrived:
pnpm ops:indexnow retry --state-dir /absolute/private/curvi-indexnow --url https://curvi.ai/pricing --acknowledge-duplicate-risk
```

For `key_pending`, first verify the approved root proof remains reachable and matches the secure configuration, then review Bing/IndexNow diagnostics. Do not repeatedly resubmit merely because indexing is pending. If that review establishes a need to retry the same notification after ownership is corrected, the same `retry --acknowledge-duplicate-risk` command explicitly queues it. The next submit verifies the proof again and keeps the original debounce/endpoint/daily controls.

These commands only queue local work. The next submit rescans eligibility and still honors debounce, endpoint delays and daily limits. IndexNow has no documented request idempotency key; this tool prevents ordinary duplicate notifications but cannot promise exactly-once delivery after a network/process failure. Unknown outcomes require explicit review rather than a blind automatic resend. An extreme Retry-After holds the work for review; an unparseable value falls back to the bounded exponential backoff.

Corrupt, oversized, nonprivate or symlinked state is refused, never reset. A crashed process can leave `.lock`: verify no process is still using this state directory before manually removing only the stale lock. Do not remove `state.json`. An `attempting` record becomes `unknown` on the next successful scan. Filesystem flush ordering is tested with injected failures; this is not a physical power-loss guarantee. Parent directory aliases are allowed, with a trusted local user/parent directory assumed.

## Verification and limits

Unit tests use mocked HTTP responses and private temporary state, including happy paths, error/refusal, Retry-After, quota, unchanged/deleted URLs, crash ambiguity, locking and atomic-write failures. Browser tests exercise the real offline parser and the actual tsx command environment without fetching Curvi or submitting notifications. The production proof route and share bot filter have regression coverage. Run the project's lint, typecheck, test and e2e gates before release.

Official contracts checked 2026-10-03: [IndexNow documentation](https://www.indexnow.org/documentation), [IndexNow FAQ](https://www.indexnow.org/faq), [Bing sitemap guidance](https://blogs.bing.com/webmaster/2025/7/Keeping-Content-Discoverable-with-Sitemaps-in-AI-Powered-Search/), [Sitemap protocol](https://www.sitemaps.org/protocol.html), [Robots Exclusion Protocol](https://www.rfc-editor.org/rfc/rfc9309.html). Notification acceptance does not guarantee crawling, indexing, ranking or inclusion in any assistant's answers.
