# Phase 11, workstream b2/trust

Date: 2026-09-28. Parent plan: docs/phases/PHASE_11.md. Migration: 0015_trust.

## Scope

1. Self serve account deletion in /app/settings. Typed confirmation (DELETE). Refused while a pack runs, while a Stripe subscription is open, and when the owned workspace has other members. Deletes the owned workspace (every tenant row cascades), the user's other seats, their terms records and every object under `ws/{id}/`; signs out; removes the Supabase auth user with `SUPABASE_SERVICE_ROLE_KEY`, or logs it for a manual removal when the key is unset. Keeps `signup_grants` so a new signup cannot farm a second grant.
2. Data export: `GET /api/account/export`, one JSON file with the workspace, brand kit, products with photos, packs with files and the credit history. Each object carries a signed link valid for 24 hours; pack files also carry their in app download path. Owners and admins only.
3. 30 day source purge: `purgeStaleSourceMedia` and `POST /api/cron/purge-source-media` behind `CRON_SECRET`. Deletes source rows and objects older than 30 days whose product had no pack in the last 30 days, keeps anything behind a running pack or a share link, and sweeps old orphan uploads. Scheduling in docs/LAUNCH_CHECKLIST.md.
4. Server side upload ingest: every upload is read back before it becomes a source_media row (createJob, registerSourceMedia) or a brand kit logo. Magic bytes decide the format (JPEG, PNG, WebP, GIF, TIFF; HEIC recognized and refused), 25 MB and 80 MP caps, metadata stripped with the orientation applied (lossless for upright JPEG, PNG and WebP), server sha256 and upright size recorded. Videos: MP4 or MOV magic bytes, 200 MB, 60 seconds read from the movie header through range requests.
5. Server side terms record: `terms_acceptances` (user, workspace, version, time, IP, user agent, source), written at the signup confirmation callback or the first signed in /app visit, only when the user has no record yet.

## Files

- packages/db: `terms_acceptances` table and `source_media_created_at_idx` (schema.ts, 0015_trust.sql), RLS test.
- packages/pipeline/src/ingest: format detection, image check and metadata strip, movie duration reader.
- apps/web/src/lib/trust: storage, ingest, account, export, purge, terms, cron secret, auth admin, confirmation.
- apps/web: settings "Your data" card, delete account form, /account-deleted page, export and cron routes, DbService ingest hooks, auth callback and app layout terms hooks.

## Left for later

- Video metadata (GPS in udta) is not stripped; that needs a remux.
- A new TERMS_VERSION needs an accept prompt before it can be recorded for existing users.
- Workspace ownership transfer, so an owner of a shared workspace can delete their account without email.
