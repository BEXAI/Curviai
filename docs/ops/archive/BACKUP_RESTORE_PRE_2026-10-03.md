# Historical backup and restore procedure (retired 2026-10-03)

Updated 2026-10-03: the user retired encrypted-backup planning and its release gates. Local disk and GitHub preserve source code, not live database rows, Auth state or stored objects. No database recovery capability is claimed. Existing backup data and security controls remain untouched; no backup service, key or credential is to be provisioned under this plan.

This is a verbatim historical procedure apart from this notice and corrected relative links. Its commands, setup tasks, schedules, cost estimates and acceptance gates are not current instructions. Retained tooling is an optional archival reference only; do not execute or provision it as part of the current rollout. See [current policy](../BACKUP_RESTORE.md).

---

# Backups and restores

Updated 2026-10-02. Items P20-10 (nightly backup) and P20-11 (restore drill) of docs/phases/PHASE_20.md. Supabase Free keeps no restorable backup, so this nightly copy is the only way back from lost data until the founder chooses Supabase Pro (decision 11), and it stays as the off platform copy after that.

Implementation is locally tested. Bucket/cron setup, completed backup/decryption and timed isolated recovery remain external acceptance gates unless separately recorded in [verification.md](../../verification.md). User-authorized account operations can be carried out through the approved session; the founder retains private-key custody.

## Targets

| | Target | How it is met |
| --- | --- | --- |
| Recovery point (RPO) | 24 hours | One backup a day at 09:15 UTC. Health warns `cron_overdue:backup` once the newest recorded backup is older than the seeded `backup.maxAgeHours` (26 hours, packages/pipeline/src/seed/operations.ts). |
| Recovery time (RTO) | 2 hours | The restore drill measures it each month and reports whether it finished inside the seeded `restoreDrill.rtoTargetMinutes` (120). |

## What a backup holds

Each night the `curvi-backup` Render cron runs ops/cron/backup.sh in the image built from ops/cron/Dockerfile. One encrypted file, `curvi-YYYYMMDDTHHMMSSZ.tar.age`, holds:

| File | What | How |
| --- | --- | --- |
| public.dump | The `public` and `drizzle` schemas, schema and data | `pg_dump --format=custom --no-owner --no-privileges --schema=public --schema=drizzle` |
| auth.dump | The rows of `auth.users`, `auth.identities` and `auth.mfa_factors`, data only | `pg_dump --format=custom --data-only --no-owner --no-privileges --table=...`. Sessions, refresh tokens, MFA challenges, flow state and one time tokens are never dumped: a restored project signs everyone in again. |
| manifest.json | Rows per table, the credit ledger total in tenths of a credit, the newest migration, the server and pg_dump versions, and the size and sha256 of the two dumps | Read from the dump files themselves (the COPY blocks `pg_restore --data-only` prints), so the drill compares exactly, whatever was written while the dump ran. |

The two dumps are separate runs, a few seconds apart. The auth dump runs second, so a person who signs up in between can be in the auth dump without a workspace; the app provisions one at the next sign in. The drill compares each dump with its own counts, never one against the other.

The tar is encrypted with age to the founder's public key (`BACKUP_AGE_RECIPIENT`) as it is written; no plain copy leaves the container, and the container's temporary folder is removed on every exit. The private key exists only in the founder's password manager. Without it nobody, including Render, Cloudflare or anyone holding the bucket token, can read a backup.

Where it goes, in the separate bucket `curvi-backups` (never the app's bucket):

| Prefix | When | Kept | Locked |
| --- | --- | --- | --- |
| `daily/YYYY/MM/DD/` | every night | 35 days (`backup.dailyKeepDays`) | the newest 7 days (`backup.lockDays`): no token can delete or overwrite them |
| `monthly/YYYY-MM/` | a second copy on the 1st of each month | 180 days (`backup.monthlyKeepDays`) | no |

Incomplete multipart uploads are aborted after 1 day (`backup.abortMultipartDays`). ops/r2/backups-lifecycle.json and ops/r2/backups-lock.json hold these rules, and apps/web/scripts/backup-bucket.test.ts fails when they differ from the seed. Cloudflare deletes expired objects within about 24 hours of expiry. The privacy page states the longest window, 180 days, from the seed (P20-23).

After the upload the script posts the key, size, sha256, row counts and ledger total to `POST /api/cron/backup-report` (bearer `CRON_SECRET`), which stores them as `platform_settings` `backup:last` and records the run for health. Then it pings healthchecks.io. Any failure exits non zero and pings `/fail`, so the founder hears about a failed night by email within minutes, and health turns degraded (`cron_overdue:backup`) once 26 hours pass without a recorded backup.

## The schema comes from migrations, only the data from a backup

`--no-privileges` drops every GRANT and REVOKE from the dump. The ledger and provisioning functions (`reserve_credits`, `charge_credits`, `release_credits`, `credit_balance`, `provision_workspace` and the signup grant functions) are protected only by `REVOKE EXECUTE` in migrations 0002, 0004, 0007, 0009 and 0012. A schema restored from this dump would let anyone with the anon key call them through the Data API. So every restore, the drill included:

1. creates the schema with `pnpm db:migrate` at the commit production runs;
2. loads only the data from the backup (`pg_restore --data-only`), with `session_replication_role = replica` so triggers and foreign key checks do not run while rows arrive in any order;
3. checks the grants afterwards (the drill's `acl_unchanged` and `ledger_functions_locked` checks).

## Setting it up

Use the authorized account/session for setup. Private key material and secret values stay in their credential store and never enter documentation or logs.

1. **Server version.** In the Supabase SQL editor run `SHOW server_version;`. If the major is not 17, change `ARG PG_MAJOR=17` in ops/cron/Dockerfile to that major (or newer) and record the value in docs/verification.md. pg_dump refuses a server newer than itself.
2. **Key pair.** On the laptop: `brew install age`, then `age-keygen -o curvi-backup.key`. The file holds the private key (`AGE-SECRET-KEY-1...`) and prints the public key (`age1...`). Put the whole file in the password manager, then delete it from the disk. The public key is `BACKUP_AGE_RECIPIENT`.
3. **Bucket.** In Cloudflare R2 create the bucket `curvi-backups` (Standard storage, which the free tier covers).
4. **Tokens.** Create an R2 API token with Object Read and Write on `curvi-backups` only, for the cron. For the restore drill create a second token with Object Read only on the same bucket, and keep it on the laptop.
5. **Lifecycle and lock.** In the bucket's settings add the rules in ops/r2/backups-lifecycle.json and ops/r2/backups-lock.json. With wrangler, the same rules are:

   ```
   npx wrangler r2 bucket lifecycle add curvi-backups daily-copies-35-days daily/ --expire-days 35
   npx wrangler r2 bucket lifecycle add curvi-backups monthly-copies-180-days monthly/ --expire-days 180
   npx wrangler r2 bucket lifecycle add curvi-backups abort-multipart-1-day --abort-multipart-days 1
   npx wrangler r2 bucket lock add curvi-backups daily-copies-locked-7-days daily/ --retention-days 7
   ```

   Leave the prefix empty for the multipart rule when wrangler asks, so it covers the whole bucket. The lock can also be set by sending ops/r2/backups-lock.json to `PUT https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/r2/buckets/curvi-backups/lock` with an API token that may edit R2. A bucket with a lock cannot be emptied, and a locked copy cannot be deleted early by anyone.
6. **healthchecks.io.** Create a check named `curvi-backup`, period 1 day, grace 2 hours, with email alerts. Open the check in its dashboard after the first run and confirm it shows "up": a wrong check id still answers HTTP 200.
7. **The cron service.** In Render: New, Cron Job, this repository, runtime Docker, Dockerfile path `./ops/cron/Dockerfile`, build context `.` (the repository root), schedule `15 9 * * *`, the smallest instance (0.5 CPU and 512 MB, `0.5c-512mb` in render.yaml terms; about $1 a month, Render's minimum for a cron). Give it only these variables, never the web service's secrets:

   | Variable | Value |
   | --- | --- |
   | `BACKUP_DATABASE_URL` | The session pooler string from Supabase, Connect: `postgresql://postgres.<ref>:<password>@aws-<n>-<region>.pooler.supabase.com:5432/postgres`. Not port 6543, not `db.<ref>.supabase.co`. |
   | `BACKUP_AGE_RECIPIENT` | The `age1...` public key |
   | `BACKUP_R2_ACCOUNT_ID` | The Cloudflare account id |
   | `BACKUP_R2_BUCKET` | `curvi-backups` |
   | `BACKUP_R2_ACCESS_KEY_ID`, `BACKUP_R2_SECRET_ACCESS_KEY` | The read and write token from step 4 |
   | `NEXT_PUBLIC_SITE_URL` | `https://curvi.ai` |
   | `CRON_SECRET` | The same value the web service has |
   | `HEALTHCHECKS_BACKUP_URL` | The check's ping URL from step 6 |

8. **First run.** Trigger a run from the cron's page, read its log, then check: the file is in the bucket under `daily/`; `/api/health` no longer lists `cron_never_ran:backup`; the healthchecks.io check is up. The first live run also settles one open fact: that the pooler's `postgres.<ref>` user may read `auth.mfa_factors` (docs/verification.md).
9. **Decrypt once.** Download the file and run `age --decrypt --identity <key file> --output backup.tar <file>` and `tar -tf backup.tar`. It lists manifest.json, public.dump and auth.dump. Delete both files afterwards. This is the acceptance check of P20-10: a backup recorded within 24 hours that decrypts with the founder's key.

## When a backup fails

The healthchecks.io email names the check. Open the cron's latest run log in Render; every line starts with the UTC time and `backup:`.

| Log line | Meaning | First action |
| --- | --- | --- |
| `missing variables: ...` | The cron service lacks a variable | Add it in the cron's Environment, run again |
| pg_dump `server version mismatch` | The server's major is newer than the image's pg_dump | Raise `PG_MAJOR` in ops/cron/Dockerfile |
| pg_dump connection errors | Wrong pooler string, a paused project, or the direct host | Use the session pooler on port 5432 |
| rclone `403` or `AccessDenied` | The token lacks write on the bucket, or the bucket name is wrong | Fix the token's scope |
| curl `(22)` on `backup-report` | The site refused the report: wrong `CRON_SECRET`, or the site was down | The file is already in the bucket; fix the secret and run again so health records it |

## The restore drill

A backup nobody has restored is a guess. Once a month (and once before Release 2's gate) the founder restores the newest backup into an isolated database, checks it, and records how long it took. `/api/health` shows `restore_drill_overdue` (info, never degraded) until the first drill is recorded and again once the last one is older than the seeded `restoreDrill.maxAgeDays` (35).

### Where a drill may restore

Only into a database nothing else connects to:

- **Default: a local Supabase stack** on the laptop (`supabase start`, which needs Docker). It runs Supabase Auth's own migrations, so `auth.users`, `auth.identities` and `auth.mfa_factors` exist and the signup triggers of migrations 0004 and 0012 install. Plain Postgres or the test PGlite would not.
- **Fallback: a throwaway Supabase Free project** in a separate organization, created for the drill and deleted right after it.
- **Never staging, production or any database an app instance, a cron or an email sender connects to.** A restored copy holds customer data, password hashes and TOTP secrets, and a booting app instance would pick up every restored live job (P20-32) and run it again on real provider keys.

`pnpm ops:restore-drill` enforces this before it fetches or decrypts anything. It refuses a target that is the database `DATABASE_URL`, `BACKUP_DATABASE_URL` or `STAGING_DATABASE_URL` points at (however the URL is spelled), any database of the Supabase project those variables, `NEXT_PUBLIC_SUPABASE_URL` or `STAGING_SUPABASE_URL` name, any URL whose host hides in its query string, and any remote host except the throwaway project named with `--throwaway-project <ref>` (and that only while production is named in the shell, so the two can be told apart). It also refuses a target that is not fresh: one that already has tables in `public` or any user in `auth.users`. So it never clears data that was there before it started.

### One time setup

1. Install Docker Desktop, the Supabase CLI, age and the PostgreSQL client tools of the production major: `brew install supabase/tap/supabase age postgresql@17` (or the major recorded in docs/verification.md).
2. Make an empty folder for the drill stack outside the repository, for example `~/curvi-drill`, and run `supabase init` in it. In its `supabase/config.toml` set `[db] major_version` to the production major.
3. Keep the read only bucket token from "Setting it up" step 4 at hand, or download the newest file from the bucket by hand and pass it with `--backup`.

### Running it

```
cd ~/curvi-drill && supabase start
cd <the Curvi repository, at the commit production runs>
export CRON_SECRET=<the site's value>
export BACKUP_R2_ACCOUNT_ID=<account id> BACKUP_R2_BUCKET=curvi-backups
export BACKUP_R2_ACCESS_KEY_ID=<read only token id> BACKUP_R2_SECRET_ACCESS_KEY=<read only token secret>
# Save the age key from the password manager to a file only for the drill.
pnpm ops:restore-drill \
  --target postgresql://postgres:postgres@127.0.0.1:54322/postgres \
  --identity ~/curvi-backup.key \
  --supabase-workdir ~/curvi-drill \
  --report-to https://curvi.ai
rm ~/curvi-backup.key
```

If `DATABASE_URL` in the shell points at the same local stack (a local dev setup), the drill refuses: unset it for the drill, or use a second stack on other ports.

What it does, timing each step:

1. **Fetch** the backup the site recorded (`GET /api/cron/backup-report` with `CRON_SECRET`, from `--report-to` or `NEXT_PUBLIC_SITE_URL`, even with `--no-report`) through the read only token, and refuse it unless its size and sha256 match what the backup cron reported, it is in the bucket, and it is not dated in the future. The nightly cron's token can write to the bucket, so a newer object the site never recorded is never restored (the drill names it on stderr). Or use `--backup <file>`.
2. **Decrypt** it with the age key into a private temporary folder and check each dump's size and sha256 against manifest.json. pg_restore must be at least the major that wrote the dump, and carry the CVE-2025-8714 fix (17.6 or later on 17; 16.10, 15.14, 14.19, 13.22 on older majors), because the drill turns the dumps into plain SQL for psql.
3. **Check the target**: its Postgres major equals production's, `auth.users` exists, and it is fresh.
4. **Migrate**: `pnpm db:migrate` against the drill database, so the schema, grants and policies come from the repository, never from the dump. Then it loads ops/cron/verify-restore.sql and takes a baseline of every grant, RLS switch and policy.
5. **Load**: it clears the rows the migrations wrote, turns the dumps into SQL with `pg_restore --data-only`, and loads the auth and public data in one psql transaction with `SET session_replication_role = replica` (Supabase's own restore command). In the same transaction it fails every generation job that was live when the backup was taken and clears any stored run payload, so nothing restored can run again.
6. **Check**, with one line per check:

   | Check | Passes when |
   | --- | --- |
   | `tables_present` | Every table in the backup exists in the drill database |
   | `row_counts` | Every table holds exactly the rows the manifest lists |
   | `latest_migration` | The drill's newest migration is at least the backup's (an older checkout fails) |
   | `ledger_total` | The credit ledger adds up to the manifest's total |
   | `ledger_balances` | `credit_balance` over every workspace adds up to the ledger, and no job holds a negative amount |
   | `foreign_keys` | No row points at a missing row (the load skipped those checks) |
   | `acl_unchanged` | Grants, RLS switches and policies equal the fresh migrate's |
   | `ledger_functions_locked` | anon and authenticated cannot run the ledger and provisioning functions |
   | `live_jobs_reset` | No generation job is live |

7. **Record**: when every check passed, it posts the backup key, the time of each step, the total and whether it finished inside the 120 minute target to `POST /api/cron/restore-drill-report` (bearer `CRON_SECRET`), which stores `restore_drill:last` and clears `restore_drill_overdue`. Add the dated line it prints to docs/verification.md.
8. **Destroy**, whatever happened: it closes the connection, deletes the temporary folder with the decrypted files, and runs `supabase stop --no-backup` (which deletes the stack's data volumes). For a throwaway project it prints a reminder to delete the project at once.

### When the drill fails

| Line | Meaning | First action |
| --- | --- | --- |
| A refusal before anything ran | The target, the report or the backup source is not allowed or not set | Read the sentence; nothing was fetched or written |
| `The backup is damaged` | A dump differs from its manifest | Try the previous day's file with `--backup`; then look at the bucket and the backup log |
| `runs Postgres 15 and production 17` (or similar) | The stack's major differs | Set `[db] major_version` in the stack's config.toml, `supabase stop --no-backup`, `supabase start` |
| psql errors on `auth.users` columns | The local Supabase Auth version differs from the hosted one | Update the Supabase CLI (`brew upgrade supabase`) and run again; record the versions in docs/verification.md |
| `FAIL  latest_migration` | The checkout is older than production | Check out the commit production runs |
| `FAIL  row_counts` or `FAIL  ledger_total` | The data did not load completely | Read the psql output above it; keep the backup file for a second try |
| `FAIL  acl_unchanged` or `FAIL  ledger_functions_locked` | Something changed grants after the migrate | Treat as a bug in the restore steps; never restore that way in an emergency |

A failed drill records nothing, so health keeps showing `restore_drill_overdue`.

## After a real restore

A real disaster restore follows the same order: the schema from `pnpm db:migrate` at production's commit, then only the data (step 5 above, with the live jobs failed in the same transaction), then the checks. A new Supabase project also needs these settings applied again, since none of them live in the database dump:

- Auth: Site URL and redirect URLs; email templates; custom SMTP through Resend (docs/LAUNCH_CHECKLIST.md step 3); email confirmation on; secure email change; Google sign in client id and secret (PHASE_18); CAPTCHA (P20-29, once on); MFA settings.
- Keys: the new project's URL, anon key, service role key and database strings go into Render (`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `DATABASE_URL`) and into the backup cron (`BACKUP_DATABASE_URL`).
- Everyone signs in again: sessions and refresh tokens are never backed up.

The full interruption and recovery sequence is in [DISASTER_RECOVERY.md](../DISASTER_RECOVERY.md). It includes the order for restoring schema, data, grants and account configuration before reconnecting the app.
