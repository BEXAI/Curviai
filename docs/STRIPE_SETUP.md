# Stripe setup

What the code expects from the Stripe account before paid plans can be sold. Every price below is derived from the seed in `packages/pipeline/src/seed/credits.ts` (CLAUDE.md rule 2). If the seed changes, change Stripe to match, then update this file; `apps/web/src/lib/billing/plans.test.ts` fails when this file stops listing a seed price, an env var or a webhook event the code uses.

Stripe docs checked on 2026-09-28: Checkout terms of service consent (docs.stripe.com/payments/checkout/custom-components), Stripe Tax in Checkout (docs.stripe.com/tax/checkout/page), portal deep links (docs.stripe.com/customer-management/portal-deep-links), portal configuration (docs.stripe.com/customer-management/configure-portal and the billing_portal configuration API reference). Smart Retries, discounts and Stripe pricing were checked the same day during discovery (docs.stripe.com/billing/revenue-recovery/smart-retries, docs.stripe.com/payments/checkout/discounts, stripe.com/billing/pricing). Record the dates in docs/verification.md when this setup is carried out.

## 1. Products and prices

Create one product per paid tier, each with a monthly and a yearly recurring price in USD, plus one product per top up with a one time price. Put the price ids in the env vars named in the last column.

| Product | Price | Amount (unit_amount in cents) | Credits granted | Env var |
|---|---|---|---|---|
| Curvi Starter | Monthly | $29 (2900) | 200 on each paid monthly invoice | `STRIPE_PRICE_STARTER_MONTHLY` |
| Curvi Starter | Yearly | $288 (28800), shown as $24 per month | 2,400 on each paid annual invoice | `STRIPE_PRICE_STARTER_ANNUAL` |
| Curvi Growth | Monthly | $79 (7900) | 600 | `STRIPE_PRICE_GROWTH_MONTHLY` |
| Curvi Growth | Yearly | $792 (79200), shown as $66 per month | 7,200 | `STRIPE_PRICE_GROWTH_ANNUAL` |
| Curvi Pro | Monthly | $149 (14900) | 1,300 | `STRIPE_PRICE_PRO_MONTHLY` |
| Curvi Pro | Yearly | $1,488 (148800), shown as $124 per month | 15,600 | `STRIPE_PRICE_PRO_ANNUAL` |
| Curvi Agency | Monthly | $349 (34900) | 3,500 | `STRIPE_PRICE_AGENCY_MONTHLY` |
| Curvi Agency | Yearly | $3,480 (348000), shown as $290 per month | 42,000 | `STRIPE_PRICE_AGENCY_ANNUAL` |
| Curvi 100 credits | One time | $15 (1500) | 100, lasting 12 months | `STRIPE_PRICE_TOPUP_100` |
| Curvi 500 credits | One time | $60 (6000) | 500, lasting 12 months | `STRIPE_PRICE_TOPUP_500` |

Notes:

- Annual plans grant the whole year of credits when the annual invoice is paid (Phase 10 decision 2). There is no monthly drip for annual plans.
- The yearly amount is `annualUsdPerMonth x 12` from the seed. The saving shown on /pricing is computed from the same numbers, rounded down.
- A price whose env var is unset simply cannot be bought; the billing page shows "This option cannot be bought online yet" for it.
- No free trials are configured. A trial's first invoice is $0 and would still grant a full period of credits, so add trial handling to the webhook before offering one.
- The founding member offer in the seed ($19 per month, $190 per year, 50 seats) is not wired to checkout and is not shown on /pricing. Do not create prices for it until the seat counter and its end date exist.
- Tax behavior: if the founder turns on Stripe Tax, decide whether prices are tax exclusive (tax added on top, the usual choice for US B2B) and set the same tax behavior on every price. Product tax code for AI generated images sold to businesses: check the current Stripe tax code list before choosing.

## 2. Environment variables

| Name | Required | What it does |
|---|---|---|
| `STRIPE_SECRET_KEY` | Yes | Turns card payments on. Without it the billing page shows "Card payments are not open yet" and a Request button that stores an `upgrade_requested` event. |
| `STRIPE_WEBHOOK_SECRET` | Yes | Signing secret of the webhook endpoint below. Without it the endpoint answers 503. |
| `STRIPE_PRICE_*` | Yes, one per row above | Price ids from section 1. |
| `STRIPE_TAX_ENABLED` | No | Set to `1` only after Stripe Tax registrations exist. Turns on automatic tax, required billing address and tax id collection in Checkout. Any other value leaves tax off. |
| `NEXT_PUBLIC_SITE_URL` | Yes | Base of the Checkout success, cancel and portal return URLs, and of the terms link shown in Checkout. |

`STRIPE_TAX_ENABLED` is new in Phase 10 and still needs adding to `.env.example` and `render.yaml` (both outside the billing package).

## 3. Webhook endpoint

- URL: `https://curvi.ai/api/webhooks/stripe` (that is `NEXT_PUBLIC_SITE_URL` plus `/api/webhooks/stripe`).
- API version: `2025-08-27.basil`. The code pins the same version in `apps/web/src/lib/billing/stripe.ts`; the webhook parser reads basil shapes (invoice line `pricing.price_details`, `parent.subscription_details`, item `current_period_end`).
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
  - `charge.refunded`
  - `charge.dispute.created`

What each one does:

| Event | Effect |
|---|---|
| `checkout.session.completed` | Links the Stripe customer to the workspace. Grants a top up only when `payment_status` is `paid` (or `no_payment_required`). |
| `checkout.session.async_payment_succeeded` | Grants a delayed top up once it clears. |
| `checkout.session.async_payment_failed` | Records a note; no credits. |
| `invoice.paid` | `subscription_create` and `subscription_cycle` grant one period of the tier (12 months for a yearly price). A plan change grants the difference for the time covered; a downgrade takes the difference back, never below a zero balance. Keyed on the invoice id, so it grants once. |
| `invoice.payment_failed`, `invoice.payment_action_required` | Records a note with the attempt count for the churn signal. Stripe emails the customer (section 5). |
| `customer.subscription.*` | Upserts the subscription and sets `workspaces.plan`: the tier while active, trialing or past due, free once canceled, unpaid or expired. Writes a `plan_changed` event. |
| `charge.refunded` | Takes back the credits that payment granted, in proportion to the amount refunded, never below a zero balance (decision 3). |
| `charge.dispute.created` | Takes back all the credits that payment granted, never below a zero balance. |

Errors: any processing error answers 500 so Stripe retries for up to three days; every handler is idempotent. An event with no `workspaceId` metadata whose customer is not linked to a workspace is logged as `stripe webhook: unroutable event` and retried. To fix one, set `workspaces.stripe_customer_id` for the right workspace (owner connection), then use "Resend" on the event in the Stripe Dashboard if the retries ran out. Subscriptions created by hand in the Dashboard need `workspaceId` in their metadata or a linked customer for the same reason.

## 4. Checkout requirements

Set these in the Dashboard before the first checkout, or session creation fails and the billing page shows "Stripe could not open checkout just now":

- Settings, Public details: business name, support email, **terms of service URL** (`https://curvi.ai/terms`) and privacy policy URL (`https://curvi.ai/privacy`). Checkout requires the terms URL because every session sets `consent_collection.terms_of_service = required`.
- Settings, Checkout: optionally show the legal policies and support contact.
- Promotion codes are accepted on every session (`allow_promotion_codes`). Create coupons and codes in the Dashboard; restrict agency offers to the Agency prices.
- Sessions reuse `workspaces.stripe_customer_id` when the workspace has one, otherwise prefill the signed in email. Top ups create a customer and an invoice, so business buyers get a document.
- Metadata on every session: `workspaceId`, `priceId`, `kind`, `plan`, `cadence`, `source`. Subscriptions carry `workspaceId`, `plan`, `cadence` and `source`.

## 5. Customer Portal

Settings, Billing, Customer portal:

- Business information: headline, terms and privacy links, default return link `https://curvi.ai/app/billing`.
- Customer information: allow name, email, billing address and tax id updates.
- Payment methods: on.
- Invoice history: on.
- Cancel subscriptions: on, at the end of the billing period, with cancellation reasons on. A retention coupon is optional.
- Switch plan: on. Add the four tier products with both their monthly and yearly prices.
- Prorate subscription updates: on, **invoice immediately** (`always_invoice`). The webhook grants the upgrade difference from that invoice right away; with prorations left for the next invoice the difference is still granted, only later.
- Manage downgrades: "update immediately". Stripe can only schedule a downgrade at period end between prices of the same product, and each tier is its own product. When a downgrade returns money for unused time, the webhook takes the matching credits back.
- Promotion codes on plan changes: optional.

Existing subscribers who pick another plan on /app/billing are sent to the portal's `subscription_update_confirm` flow for the chosen price, never to a second Checkout. If the portal rejects that flow (for example plan switching is off), the code falls back to the plan picker, then to the portal home.

## 6. Failed payments (dunning)

Settings, Billing, Revenue recovery:

- Smart Retries: on, the recommended policy (8 tries within 2 weeks).
- When all retries fail: cancel the subscription. The `customer.subscription.deleted` event then moves the workspace to Free. While retries run, the subscription is `past_due`, the workspace keeps its plan and /app/billing shows a "Your last payment did not go through" banner with an Update card button.
- Emails (Settings, Customer emails): failed payment emails with the link to update the card, expiring card reminders, successful payment receipts, and renewal reminders for annual plans. Send customers a 3D Secure confirmation email when a payment needs action.
- Automatic card updater: on (Settings, Payment methods).
- Radar: default rules, with 3D Secure requested when Radar sees risk.
- Statement descriptor: `CURVI.AI` or similar, so customers recognize the charge.

## 7. Tax

Stripe Tax is off in code until `STRIPE_TAX_ENABLED=1`. Before turning it on: add registrations for each state or country where Curvi must collect tax, set the product tax codes and price tax behavior, then set the env var. /pricing does not add "plus tax" wording today; add it if prices are tax exclusive.

## 8. Before launch

1. Create everything above in test mode first. Run a monthly checkout, an annual checkout, a top up, an upgrade and a downgrade through the portal, a refund and a test dispute, and check the ledger and `workspaces.plan` after each.
2. Repeat the product, price, webhook and portal setup in live mode and put the live values in Render.
3. Follow up on requests collected while payments were closed:

```sql
select at, workspace_id, props->>'tier' as tier, props->>'cadence' as cadence, props->>'email' as email
from events
where name = 'upgrade_requested'
order by at desc;
```
