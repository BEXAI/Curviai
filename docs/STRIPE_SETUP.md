# Stripe setup

Status checked against the integration checkout on 2026-10-02. The scheduled-plan, renewal-notice and billing-history code is implemented and locally tested; publication/deployment is tracked in [verification.md](verification.md). These are configuration and acceptance instructions, not evidence that Stripe accounts, legal text, senders or real payment flows have been configured or accepted. No real payment or notice was sent during this implementation pass.

What the code expects from the Stripe account before paid plans can be sold. Every price below is derived from the seed in `packages/pipeline/src/seed/credits.ts` (CLAUDE.md rule 2). If the seed changes, change Stripe to match, then update this file; `apps/web/src/lib/billing/plans.test.ts` fails when this file stops listing a seed price, an env var or a webhook event the code uses.

Stripe docs checked on 2026-09-29 for the four product catalog and the duplicate subscription protections (docs.stripe.com/customer-management, "Technical limitations"; docs.stripe.com/customer-management/configure-portal, "Manage downgrades"; the API pages listed in docs/verification.md under fix/duplicate-subscriptions). Stripe docs checked on 2026-09-28: Checkout terms of service consent (docs.stripe.com/payments/checkout/custom-components), Stripe Tax in Checkout (docs.stripe.com/tax/checkout/page), portal deep links (docs.stripe.com/customer-management/portal-deep-links), portal configuration (docs.stripe.com/customer-management/configure-portal and docs.stripe.com/api/customer_portal/configurations/create), dispute lifecycle and events (docs.stripe.com/disputes/how-disputes-work, docs.stripe.com/api/events/types, support.stripe.com/questions/disputes-on-a-refunded-transaction-faq). Smart Retries, discounts and Stripe pricing were checked the same day during discovery (docs.stripe.com/billing/revenue-recovery/smart-retries, docs.stripe.com/payments/checkout/discounts, stripe.com/billing/pricing). Record the dates in docs/verification.md when this setup is carried out.

## 1. Products and prices

Create **three** products for the plans sold online, one per tier: `Curvi Starter`, `Curvi Growth` and `Curvi Pro`. **Do not create Agency prices yet** (docs/phases/PHASE_20.md P20-08, founder decision 6): the seed marks Agency `selfServe: false` until client workspaces exist, so /pricing and /app/billing show no Agency card, checkout and plan requests answer `tier_not_self_serve`, checkout readiness does not require `STRIPE_PRICE_AGENCY_*`, and a seller who needs more than Pro emails support@curvi.ai. The Agency rows below stay for when it is sold online again. Each product gets two recurring prices in USD, one monthly and one yearly, six prices in all. The Customer Portal cannot offer two prices with the same product and billing interval (docs.stripe.com/customer-management, "Technical limitations": "You can't define multiple Prices with the same `product` and `recurring.interval` values"), so the earlier single `Curvi plans` product with four monthly prices cannot be put in the portal's plan switcher. Give each price a nickname such as "Growth monthly" so the portal and invoices name the plan. Create one product per top up with a one time price. Put the price ids in the env vars named in the last column.

The cost of one product per tier: the portal can only schedule a downgrade for the end of the billing period between prices of the **same** product (docs.stripe.com/customer-management/configure-portal, "Manage downgrades"). A tier downgrade in the portal (Pro to Growth, say) therefore applies at once; see section 5 and the open item there.

| Product | Price | Amount (unit_amount in cents) | Credits granted | Env var |
|---|---|---|---|---|
| Curvi Starter | Starter monthly | $29 (2900) | 200 on each paid monthly invoice | `STRIPE_PRICE_STARTER_MONTHLY` |
| Curvi Starter | Starter yearly | $288 (28800), shown as $24 per month | 2,400 on each paid annual invoice | `STRIPE_PRICE_STARTER_ANNUAL` |
| Curvi Growth | Growth monthly | $79 (7900) | 600 | `STRIPE_PRICE_GROWTH_MONTHLY` |
| Curvi Growth | Growth yearly | $792 (79200), shown as $66 per month | 7,200 | `STRIPE_PRICE_GROWTH_ANNUAL` |
| Curvi Pro | Pro monthly | $149 (14900) | 1,300 | `STRIPE_PRICE_PRO_MONTHLY` |
| Curvi Pro | Pro yearly | $1,488 (148800), shown as $124 per month | 15,600 | `STRIPE_PRICE_PRO_ANNUAL` |
| Curvi Agency (not yet) | Agency monthly | $349 (34900) | 3,500 | `STRIPE_PRICE_AGENCY_MONTHLY` |
| Curvi Agency (not yet) | Agency yearly | $3,480 (348000), shown as $290 per month | 42,000 | `STRIPE_PRICE_AGENCY_ANNUAL` |
| Curvi 100 credits | One time | $15 (1500) | 100 | `STRIPE_PRICE_TOPUP_100` |
| Curvi 500 credits | One time | $60 (6000) | 500 | `STRIPE_PRICE_TOPUP_500` |

Notes:

- Annual plans grant the whole year of credits when the annual invoice is paid (Phase 10 decision 2). There is no monthly drip for annual plans.
- Credits never expire while the account is open (docs/phases/PHASE_20.md founder decision 10, P20-05). Plans, top ups and grants write their credits with no expiry, the seed holds `creditExpiry = { kind: "none" }` (the old top up lifetime and `rolloverPolicy` are gone), migration `billing_terms` cleared the expiry the old top up code wrote, and every page shows the one sentence `CREDIT_TERMS_SENTENCE` in apps/web/src/lib/marketing-facts.ts. Choosing expiry later needs credit lots (an L item for a later phase); until then no copy mentions expiry.
- The yearly amount is `annualUsdPerMonth x 12` from the seed. The saving shown on /pricing is computed from the same numbers, rounded down.
- A price whose env var is unset simply cannot be bought; the billing page shows "This option cannot be bought online yet" for it.
- No free trials are configured. A trial's first invoice is $0 and would still grant a full period of credits, so add trial handling to the webhook before offering one.
- The founding member offer has gated local implementation. Leave its runtime switch off until the seeded offer, coupon/promotion codes, seat accounting and pricing decision have been reviewed together; use the current Phase 18 acceptance matrix rather than creating an additional subscription price ad hoc.
- Tax behavior: if the founder turns on Stripe Tax, decide whether prices are tax exclusive (tax added on top, the usual choice for US B2B) and set the same tax behavior on every price. Product tax code for AI generated images sold to businesses: check the current Stripe tax code list before choosing.

## 2. Environment variables

| Name | Required | What it does |
|---|---|---|
| `STRIPE_SECRET_KEY` | Yes | The API key. On its own it opens nothing: checkout opens only when this, `STRIPE_WEBHOOK_SECRET` and every self serve `STRIPE_PRICE_*` are set, in a key mode that fits the site (below). Until then every selling surface shows "Card payments are not open yet" or "Paid plans open soon", the billing page offers a Request button that stores an `upgrade_requested` event, and the checkout route answers 503 (`apps/web/src/lib/billing/readiness.ts`, PHASE_20 P20-01). |
| `STRIPE_WEBHOOK_SECRET` | Yes | Signing secret of the webhook endpoint below. Without it the endpoint answers 503 and checkout stays closed. |
| `STRIPE_PRICE_*` | Yes, one per self serve row above | Price ids from section 1. Each missing one keeps checkout closed; `/api/health` names it under `stripe_price_missing`. |
| `NEXT_PUBLIC_ENV_LABEL` | Staging only | Marks a non production site (PHASE_20 P20-54). Key modes: a test key on `https://curvi.ai` with no label, a live key on localhost, or a live key while the label is set, is `stripe_key_mode_mismatch` and keeps checkout closed. A test key on localhost or on a labelled staging site is fine. |
| `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | No | Not used by the app today. When set, it must be in the same mode as the secret key, or checkout stays closed. |
| `STRIPE_TAX_ENABLED` | No | Set to `1` only after Stripe Tax registrations exist. Turns on automatic tax, required billing address and tax id collection in Checkout. Any other value leaves tax off. |
| `NEXT_PUBLIC_SITE_URL` | Yes | Base of the Checkout success, cancel and portal return URLs, and of the terms link shown in Checkout. |
| `STRIPE_PORTAL_UPGRADE_CONFIG_STARTER`, `STRIPE_PORTAL_UPGRADE_CONFIG_STARTER_ANNUAL`, `STRIPE_PORTAL_UPGRADE_CONFIG_GROWTH`, `STRIPE_PORTAL_UPGRADE_CONFIG_GROWTH_ANNUAL`, `STRIPE_PORTAL_UPGRADE_CONFIG_PRO` | Yes once checkout is open | The five upgrade only portal configurations of section 5 (PHASE_20 P20-06), one per plan and cadence that has an upgrade. Unset: those subscribers land on the portal home and cannot upgrade online; `/api/health` warns `stripe_portal_upgrade_config_missing`. |
| `BILLING_EMAIL_FROM` | Yes once checkout is open | The sender of the plan activation email, an address on the verified `updates.curvi.ai` domain, for example `Curvi Billing <billing@updates.curvi.ai>` (PHASE_20 P20-07). Needs `RESEND_API_KEY` too. Checkout stays closed until both are set; `/api/health` warns `billing_email_not_configured` (info until billing is meant to be live, degraded after), and `billing_email_failing` when Resend refused the last plan email. |

The delivery inventory checks these names against `render.yaml` and the launch checklist. Local example-file gaps are reported separately; this document contains no credential values.

Readiness shows in two places. `GET /api/health/providers` (CRON_SECRET) carries `checkoutOpen` and the problem codes on its `stripe` service entry; the Release 2 gate reads it there. The public `GET /api/health` lists only the warning codes: `stripe_secret_key_missing`, `stripe_webhook_secret_missing`, `stripe_price_missing`, `stripe_key_mode_mismatch`, plus `stripe_webhook_quiet` (a checkout opened in the last `billingReconcile.quietWebhookDays` days, seed 7, and no webhook has succeeded since) and `stripe_webhook_endpoint_mismatch` (section 3). With no Stripe variable set at all there is nothing to warn about.

## 3. Webhook endpoint

- URL: `https://curvi.ai/api/webhooks/stripe` (that is `NEXT_PUBLIC_SITE_URL` plus `/api/webhooks/stripe`).
- API version: `2025-08-27.basil`. The code pins the same version in `apps/web/src/lib/billing/stripe.ts`; the webhook parser reads basil shapes (invoice line `pricing.price_details`, `parent.subscription_details`, item `current_period_end`).
- **Also set the account's default API version to `2025-08-27.basil`** (in the Stripe Dashboard developer settings, where the account API version is shown). The billing reconcile lists events through the API, and Stripe renders each event's data at the account default version of the day it was created (`api_version` on the event), whatever version the client pins. The reconcile never applies an event at another version: it reports it as failed with `api_version_mismatch` in the founder email.
- Events, exactly these:
  - `checkout.session.completed`
  - `checkout.session.async_payment_succeeded`
  - `checkout.session.async_payment_failed`
  - `invoice.paid`
  - `invoice.payment_failed`
  - `invoice.payment_action_required`
  - `customer.subscription.created`
  - `customer.subscription.updated`
  - `customer.subscription.deleted`
  - `subscription_schedule.released`
  - `subscription_schedule.canceled`
  - `subscription_schedule.completed`
  - `charge.refunded`
  - `charge.dispute.funds_withdrawn`
  - `charge.dispute.funds_reinstated`
  - `charge.dispute.closed`

Leave `charge.dispute.created` off the endpoint: nothing happens to credits until Stripe actually takes the money back, and the handler ignores it.

What each one does:

| Event | Effect |
|---|---|
| `checkout.session.completed` | Links the Stripe customer to the workspace when it has none yet (a different stored customer is kept and the conflict logged). Grants a top up only when `payment_status` is `paid` (or `no_payment_required`). |
| `checkout.session.async_payment_succeeded` | Grants a delayed top up once it clears. |
| `checkout.session.async_payment_failed` | Records a note; no credits. |
| `invoice.paid` | `subscription_create` and `subscription_cycle` grant one period of the tier (12 months for a yearly price). Plan change lines count only for the share of the billing period they cover. Without a discount that share is Stripe's own proration (the line amount over the seed price), exact on short and clamped periods. With a coupon or promotion code Stripe prorates from the discounted price, so the share follows the time left instead: a charge line counts the shortest time it can cover and a credit line the longest, so no plan change can add credits beyond the time paid for. An upgrade grants the new minus the old allowance for the time left, a downgrade takes the same amount back in full, even below a zero balance (section 5). Grants round down and debits round up to a tenth of a credit. Keyed on the invoice id, so it applies once. |
| `invoice.payment_failed`, `invoice.payment_action_required` | Records a note with the attempt count for the churn signal. Stripe emails the customer (section 6). |
| `customer.subscription.*` | Reads the subscription's current status and price from Stripe (events can arrive out of order), then upserts the subscription and sets `workspaces.plan`: the tier while active, trialing or past due, free once canceled, unpaid or expired. A status never moves out of `canceled` or `incomplete_expired`, and never back to `incomplete`. Writes a `plan_changed` event. Before writing, refunds and cancels any newer duplicate subscription the workspace has in Stripe (section 9). |
| `subscription_schedule.released`, `subscription_schedule.canceled`, `subscription_schedule.completed` | Clears pending tier/cadence/date only when the event names that persisted schedule. A late event for an old schedule never clears a newer pending change. |
| `charge.refunded` | Takes back the credits that payment granted, in proportion to the amount refunded, never below a zero balance (decision 3). |
| `charge.dispute.funds_withdrawn` | Takes back all the credits that payment granted, never below a zero balance, once per dispute. Inquiries (`warning_*` statuses) take nothing, since Stripe withdraws no funds for them. |
| `charge.dispute.funds_reinstated`, `charge.dispute.closed` | When the dispute status is `won`, gives back exactly what that dispute's clawback took, once per dispute, whichever event arrives first. A `lost` dispute gives nothing back, even though Stripe sends `funds_reinstated` for the already refunded part of a partly refunded payment. |

The subscription read uses `STRIPE_SECRET_KEY`. Without it (demo setups) the handler uses the event payload and still refuses the backwards moves above.

Errors: any processing error answers 500 so Stripe retries for up to three days; every handler is idempotent. An event with no `workspaceId` metadata whose customer is not linked to a workspace is logged as `stripe webhook: unroutable event` and retried. To fix one, set `workspaces.stripe_customer_id` for the right workspace (owner connection), then use "Resend" on the event in the Stripe Dashboard if the retries ran out. Subscriptions created by hand in the Dashboard need `workspaceId` in their metadata or a linked customer for the same reason.

Missed events (PHASE_20 P20-02): `POST /api/cron/billing-reconcile` lists the handled events of the last 72 hours (`billingReconcile.lookbackHours`; Stripe keeps events 30 days) and replays each through the same handler with the same claims, so anything the webhook missed lands exactly once and anything it already applied is left alone. The reconciler passes no Stripe write actions, so a replayed subscription event never refunds or cancels a duplicate (section 9 stays with the live webhook); it does read the subscription's current state. An event that names a deleted workspace is acknowledged; any other failure is emailed to the founder once and retried every run while it is in the window. `?dryRun=1` lists what would be written. Each run also checks the endpoint above: an enabled endpoint at this URL, sending every event listed, on `2025-08-27.basil`. An endpoint's API version cannot be changed after it is created, so a wrong one means adding a new endpoint (and its new signing secret). Otherwise `/api/health` warns `stripe_webhook_endpoint_mismatch` with the reason.

## 4. Checkout requirements

Set these in the Dashboard before the first checkout, or session creation fails and the billing page shows "Stripe could not open checkout just now":

- Settings, Public details: business name, support email, **terms of service URL** (`https://curvi.ai/terms`) and privacy policy URL (`https://curvi.ai/privacy`). Checkout requires the terms URL because every session sets `consent_collection.terms_of_service = required`.
- Settings, Checkout: optionally show the legal policies and support contact.
- Promotion codes are accepted on every session (`allow_promotion_codes`). Create coupons and codes in the Dashboard.
- Every session, tier or top up, is opened for the workspace's one Stripe customer. When `workspaces.stripe_customer_id` is empty the checkout route creates the customer first (with the signed in email and `workspaceId` metadata) and stores it, so Checkout never gets `customer_email` or `customer_creation` and never makes a customer of its own (section 9). Top ups also create an invoice, so business buyers get a document.
- Metadata on every session: `workspaceId`, `priceId`, `kind`, `plan`, `cadence`, `source`. Subscriptions carry `workspaceId`, `plan`, `cadence` and `source`. A plan session also carries `userId` (the signed in buyer), `disclosure_version` and `disclosure_sha256` (PHASE_20 P20-07).
- Renewal terms (PHASE_20 P20-07): a plan session sets `custom_text.submit.message` to the renewal terms shown beside the buy button (built from the seed, with the date to cancel by) followed by "If you use a promotion code, Checkout shows the discounted price and how long it lasts. After that, your plan renews at $X a month." (or a year), because promotion codes stay on and the terms state the list price; and `custom_text.terms_of_service_acceptance.message` to "I agree that my plan renews automatically at the price above until I cancel, and I agree to the Terms of Service." (each at most 1,200 characters). When the session completes with `consent.terms_of_service = accepted`, the webhook writes one `billing_consents` row with the version and hash from the session metadata, the exact text copied from the session's `custom_text`, the buyer's email and the Stripe customer. A subscriber's upgrade through the portal started on /app/billing writes a `billing_consents` row too, keyed by the portal session, with the renewal terms that sat beside the button. The first paid invoice (`billing_reason = subscription_create`) sends the plan activation email from `BILLING_EMAIL_FROM`, and a paid upgrade (`subscription_update`) sends the same acknowledgment for the new plan, each once per invoice; both state the renewal price from the seed (and "less any discount that still applies" when the invoice had one). Top ups keep the plain terms checkbox.

## 5. Customer Portal and next-renewal plan changes

Settings, Billing, Customer portal:

- Business information: headline, terms/privacy links and return link `https://curvi.ai/app/billing`.
- Customer information: name, email, billing address and tax id updates.
- Payment methods and invoice history: on.
- Cancellation: at the end of the billing period, with cancellation reasons available.
- **Switch plan: off in the default configuration.** Curvi uses explicit upgrade-only configurations and its own next-renewal schedule flow. This setting remains required after P20-06's P1 implementation.

Create one upgrade-only portal configuration per source plan/cadence. Keep the same business, payment, invoice and cancellation settings. Each configuration lists only the permitted upgrades:

| Configuration for subscribers on | Switch plan prices it lists | Env var with its `bpc_...` id |
|---|---|---|
| Starter monthly | Starter yearly; Growth monthly and yearly; Pro monthly and yearly | `STRIPE_PORTAL_UPGRADE_CONFIG_STARTER` |
| Starter yearly | Growth yearly; Pro yearly | `STRIPE_PORTAL_UPGRADE_CONFIG_STARTER_ANNUAL` |
| Growth monthly | Growth yearly; Pro monthly and yearly | `STRIPE_PORTAL_UPGRADE_CONFIG_GROWTH` |
| Growth yearly | Pro yearly | `STRIPE_PORTAL_UPGRADE_CONFIG_GROWTH_ANNUAL` |
| Pro monthly | Pro yearly | `STRIPE_PORTAL_UPGRADE_CONFIG_PRO` |

Annual configurations do not list monthly prices, including monthly prices of larger plans. Pro yearly needs no configuration because there is no higher self-serve plan; Agency is never listed. Enable proration and immediate invoicing (`always_invoice`) for these upgrade configurations. Missing configuration ids produce `stripe_portal_upgrade_config_missing` and safely fall back to the default portal without plan switching.

**Upgrades.** The chosen price opens `subscription_update_confirm` using the current plan/cadence configuration. Existing subscribers never start another tier Checkout. If a pending schedule would block the upgrade, Curvi first asks the subscriber to confirm cancellation of that scheduled move, releases it and records the release.

**Scheduled changes (P20-06 P1, implemented locally).** The billing picker and cancel-flow smaller-plan offer POST to `/api/billing/schedule`. Owners and admins can schedule a smaller tier or a change from yearly to monthly at the current paid period end. The service verifies the Stripe customer, current price, single subscription item, pending status and target direction, creates a two-phase subscription schedule without proration, and persists `pending_tier`, `pending_cadence`, `pending_at` and `pending_schedule_id` only after Stripe accepts it. A failed database write releases the newly created schedule. No credits change when scheduling. The billing page shows the pending plan/date and **Keep current plan**, which releases that exact schedule and clears its pending fields. A second concurrent schedule request is refused. On a later Billing read or schedule action, Curvi verifies an attached schedule against the same Stripe customer/subscription and repairs missing pending fields after an interrupted response. An empty or unknown attachment is shown with Keep current plan rather than hidden or assigned an invented target. A failed Stripe refresh is shown as unconfirmed.

A pause, discount, cancellation or confirmed upgrade that releases a pending schedule records `billing:schedule_released:<schedule id>` and its reason, clears the matching pending fields and notifies the founder through the existing release notifier. If a later Stripe operation fails, the notice says the scheduled move was already canceled. The cancel flow's smaller-plan offer is now available only with a database-backed schedule writer; it never changes the paid price immediately. Schedule released/canceled/completed events clear only their own pending schedule. A subscription event showing the new plan/cadence clears the completed pending display.

**Credits.** An immediate paid upgrade grants the new minus old allowance for the time left. A scheduled downgrade leaves the current allowance unchanged until the next paid renewal grants the target allowance. A manually applied immediate downgrade in Stripe can still take back the unused allowance and leave a negative balance; avoid immediate manual downgrades and use the next-renewal flow. Packs cannot reserve a short balance. Verify monthly and annual schedule transitions with Stripe test clocks and inspect the actual boundary invoice billing reason before live acceptance.

The schedules API and UI are separate from the legacy checkout route's downgrade refusal. Consumers should use `/api/billing/schedule`, not retry a downgrade through Checkout. The app requires owner/admin billing permission throughout; editors and clients cannot change billing or fetch invoices. A workspace without a Stripe customer receives a notice to start a plan rather than an empty portal session.

## 6. Failed payments (dunning)

Settings, Billing, Revenue recovery:

- Smart Retries: on, the recommended policy (8 tries within 2 weeks).
- When all retries fail: cancel the subscription. The `customer.subscription.deleted` event then moves the workspace to Free. While retries run, the subscription is `past_due`, the workspace keeps its plan, every app page shows a "Your last payment did not go through" banner that links to Billing, and /app/billing shows the same notice with an Update card button.
- Emails (Settings, Customer emails): failed payment emails with the link to update the card, expiring card reminders and successful payment receipts. Send customers a 3D Secure confirmation email when a payment needs action. Keep **"Send emails about upcoming renewals" off** (docs/phases/PHASE_20.md founder decision 4, P20-07): Stripe has one account wide day setting for monthly and yearly plans alike, so Curvi sends its own transactional renewal notices and plan activation email through the shared sender.
- Automatic card updater: on (Settings, Payment methods).
- Radar: default rules, with 3D Secure requested when Radar sees risk.
- Statement descriptor: `CURVI.AI` or similar, so customers recognize the charge.

### Curvi renewal and price-change notices

The daily `renewal-notices` tick task sends yearly renewal notices in the seeded 30–45-day window and a once-yearly reminder to monthly subscribers. Deterministic `renewal_notice:`, `yearly_notice:` and `price_notice:` keys dedupe retries through `email_sends`; marketing unsubscribe does not suppress transactional billing notices, but bounce/complaint suppression does. The sender uses `BILLING_EMAIL_FROM` and `RESEND_API_KEY`. Billing notice records are retained for `renewalNotices.consentRecordYears` (three years), including after workspace deletion; billing consent records are not purged by routine retention.

Dry-run the renewal route with the normal cron authorization and `?dryRun=1`. For an approved price change, prepare and inspect a dry run first:

```sh
pnpm billing:price-notice --tier starter --cadence monthly --new-usd <new-period-price> --effective <YYYY-MM-DD> --dry-run
```

The effective date must be 7–30 days ahead. The amount is the full price for the selected cadence, so an annual amount is the annual total. Removing `--dry-run` sends transactional notices to the matching active subscribers; this is a deliberate operational action requiring authorization to send. The script does not change Stripe prices or schedules. Test real mailbox delivery and all dedupe paths before enabling the recurring sender in production.

## 7. Tax

Stripe Tax is off in code until `STRIPE_TAX_ENABLED=1`. Before turning it on: add registrations for each state or country where Curvi must collect tax, set the product tax codes and price tax behavior, then set the env var. /pricing does not add "plus tax" wording today; add it if prices are tax exclusive.

## 8. Before launch

1. Create everything above in test mode first. Exercise monthly/annual start, top up, immediate upgrade through its configured portal, next-renewal downgrade through `/app/billing`, annual-to-monthly scheduling, Keep current plan, and a pending schedule followed by upgrade/pause/discount/cancel. Advance test clocks across each renewal and confirm exactly one allowance grant, correct pending-field clearing and unchanged credits at schedule creation. Then run duplicate protection (two checkout tabs and a manually created duplicate subscription), refunds, won/lost disputes, and check the ledger and `workspaces.plan` after each. The default portal must not offer a plan switch. Test activation, annual-renewal, monthly-anniversary and approved price-change notices without duplicates.
   Run it on the laptop (PHASE_20 P20-03): `stripe listen --forward-to localhost:3000/api/webhooks/stripe`, with the `whsec_` secret the CLI prints as `STRIPE_WEBHOOK_SECRET` and test keys and test prices in `.env.local`. After each step run `pnpm billing:verify --workspace <workspace id>` with `DATABASE_URL` set in the shell: it prints the plan, the subscription rows, the ledger by reason, the balance and the last 10 billing events, so each check is read off one screen. Save each event's JSON from the CLI (`stripe events retrieve <id>`) for the flow suite fixtures in `apps/web/src/lib/billing/fixtures/` (PHASE_20 "Do before the phase" item 11).
2. Repeat the product, price, webhook and portal setup in live mode and put the live values in Render.
3. Follow up on requests collected while payments were closed:

```sql
select at, workspace_id, props->>'tier' as tier, props->>'cadence' as cadence, props->>'email' as email
from events
where name = 'upgrade_requested'
order by at desc;
```

## 9. Duplicate subscription protection

A workspace must never pay for two subscriptions at once. Two tabs or a double click used to be able to open two tier Checkouts, each making its own customer; if both were paid, the webhook marked the older row superseded while Stripe kept billing it, and the portal and cancel flow lost sight of it. Three layers now stop that, each with tests in `apps/web/src/lib/billing` (`checkout-guard.test.ts`, `routes.test.ts`, `stripe-webhook.test.ts`, `db-store.test.ts`, `stripe.test.ts`).

1. **One customer per workspace, made before Checkout** (`lib/billing/checkout-guard.ts` `ensureStripeCustomer`). When `workspaces.stripe_customer_id` is empty, the checkout route creates the customer with the idempotency key `curvi-customer-<workspaceId>` and stores it only while the column is still empty, then uses whatever is stored. Two racing requests get the same customer from Stripe, and if they ever got two, the first one stored wins for both. Every Checkout Session, tier or top up, passes `customer`. `linkCustomer` (run on `checkout.session.completed`) also keeps the first customer and logs `billing: workspace already has another Stripe customer, kept the first` instead of overwriting it.
2. **One open tier checkout at a time, checked live** (`openTierCheckout`, `withCheckoutLock`). A tier purchase takes a transaction scoped advisory lock on `checkout:<workspaceId>` (waits at most 30 seconds; skipped in demo mode), then lists the customer's subscriptions in Stripe (`status: all`). If any is `active`, `trialing`, `past_due`, `incomplete`, `unpaid` or `paused`, the buyer goes to the plan change portal even when our row has not arrived yet. Otherwise it lists the customer's open Checkout Sessions, expires every one in subscription mode, and only then creates the new session. An older tab's session is therefore expired, and paying in it fails at Stripe. If an expire fails (for example that session was paid a moment ago), the request answers "Stripe could not open checkout just now" rather than opening a second session. Top ups skip this layer.
3. **Backstop in the webhook** (`stripe-webhook.ts` `retireDuplicateSubscriptions`). On every `customer.subscription.created` or `.updated`, with Stripe configured, the webhook lists the subscriptions of the event's customer and of the customer stored on the workspace. If more than one is `active`, `trialing` or `past_due`, the oldest is kept; each newer one has every paid payment on its latest invoice refunded in full (`reason: duplicate`, idempotency key `curvi-dup-refund-<subscriptionId>`) and is canceled at once (`invoice_now: false`, `prorate: false`). The refund comes before the cancel, so a failure in between leaves the duplicate live and Stripe's retry finishes the job; a recorded duplicate is never refunded again, and a payment already refunded counts as done. The existing `charge.refunded` handler then takes back the credits that invoice granted. A row for a subscription Stripe still bills is never marked superseded: if that would happen the delivery fails and Stripe retries.

The founder sees each case in two places: a log line `billing: duplicate subscription refunded and canceled`, and an events row:

```sql
select at, workspace_id, props->>'keptSubscriptionId' as kept, props->>'duplicateSubscriptionId' as duplicate,
       props->>'amount' as amount_cents, props->>'currency' as currency
from events
where name = 'billing_duplicate_subscription_refunded'
order by at desc;
```

Without `STRIPE_SECRET_KEY` (payload only mode) nothing can be checked in Stripe, so the webhook keeps the old behavior: the newest active row wins and the older row is marked superseded, with the log `billing: second active subscription in payload only mode, retiring the older row without a Stripe check`.

Known limits: the webhook reads at most 20 subscriptions per customer and the checkout guard at most 100 open sessions, far above anything a workspace should have. A subscription made by hand in the Dashboard for a customer that already has a live one counts as a duplicate and is refunded and canceled; give it to a separate customer (and workspace) if that is really wanted.
