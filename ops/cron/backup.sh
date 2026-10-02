#!/usr/bin/env bash
#
# Nightly encrypted database backup to Cloudflare R2.
# docs/phases/PHASE_20.md P20-10; the runbook is docs/ops/BACKUP_RESTORE.md.
#
# Runs as the curvi-backup Render cron job (Docker, ops/cron/Dockerfile,
# schedule "15 9 * * *", 09:15 UTC). The service holds only these
# variables, never the web service's secrets:
#
#   BACKUP_DATABASE_URL          the Supabase session pooler string (port
#                                5432, user postgres.<ref>). Not the
#                                transaction pooler on 6543, and not the
#                                direct host, which is IPv6 only on Free.
#   BACKUP_AGE_RECIPIENT         the founder's age public key (age1...). The
#                                private key stays in the password manager.
#   BACKUP_R2_ACCOUNT_ID         the Cloudflare account id
#   BACKUP_R2_BUCKET             the backup bucket (curvi-backups)
#   BACKUP_R2_ACCESS_KEY_ID      an R2 token scoped to that bucket only,
#   BACKUP_R2_SECRET_ACCESS_KEY  with object read and write
#   NEXT_PUBLIC_SITE_URL         the site, for POST /api/cron/backup-report
#   CRON_SECRET                  the bearer secret for that route
#   HEALTHCHECKS_BACKUP_URL      optional healthchecks.io ping URL
#
# Steps; any failure exits non zero and pings healthchecks.io /fail:
#   1. pg_dump the public and drizzle schemas (custom format, no owners, no
#      privileges), then a data only dump of auth.users, auth.identities and
#      auth.mfa_factors. Sessions and refresh tokens are never dumped.
#   2. manifest.json: rows per table, the credit ledger total and the newest
#      migration, read from the dump files themselves so a restore compares
#      exactly, plus the size and sha256 of each dump.
#   3. tar the three files and encrypt the stream with age.
#   4. upload to daily/YYYY/MM/DD/ and, on the 1st, monthly/YYYY-MM/. The
#      bucket's lifecycle and lock (ops/r2/) handle retention.
#   5. report the key, size, sha256 and counts to the site.
#   6. ping healthchecks.io.
#
# The dump is for data only. --no-privileges drops every GRANT and REVOKE,
# and the ledger and provisioning functions are protected only by REVOKE
# EXECUTE, so a restore always takes the schema from pnpm db:migrate and only
# the data from this file (docs/ops/BACKUP_RESTORE.md).
#
# apps/web/scripts/backup-script.test.ts runs this with fake pg_dump,
# pg_restore, age, rclone and curl on PATH; BACKUP_TIMESTAMP fixes the clock
# for those tests. Written for bash 3.2 as well, so the tests run on macOS.

set -Eeuo pipefail
umask 077

WORK=""

log() {
  printf '%s backup: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2
}

# $1: "" for success, "/start" or "/fail". A failed ping is logged, never fatal.
ping_healthchecks() {
  if [ -z "${HEALTHCHECKS_BACKUP_URL:-}" ]; then
    return 0
  fi
  if ! curl -fsS -m 10 --retry 3 -o /dev/null "${HEALTHCHECKS_BACKUP_URL%/}$1"; then
    log "the healthchecks.io ping $1 failed"
  fi
}

finish() {
  status=$?
  if [ -n "$WORK" ] && [ -d "$WORK" ]; then
    rm -rf "$WORK"
  fi
  if [ "$status" -ne 0 ]; then
    log "failed with exit code $status"
    ping_healthchecks /fail
  fi
  exit "$status"
}
trap finish EXIT
trap 'exit 143' TERM
trap 'exit 130' INT

require_env() {
  missing=""
  for name in "$@"; do
    if [ -z "${!name:-}" ]; then
      missing="$missing $name"
    fi
  done
  if [ -n "$missing" ]; then
    log "missing variables:$missing"
    exit 2
  fi
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{ print $1 }'
  else
    shasum -a 256 "$1" | awk '{ print $1 }'
  fi
}

bytes_of() {
  wc -c < "$1" | tr -d ' \t'
}

# One line of `pg_restore --list` output, such as
# ";     Dumped from database version: 17.6", without the label and with
# anything that could break the JSON removed.
toc_value() {
  sed -n "s/^;[[:space:]]*$1:[[:space:]]*//p" "$2" | sed -n '1p' | tr -cd 'A-Za-z0-9 .()+~_:-'
}

# Reads the plain SQL pg_restore prints for data only archives and writes,
# into the directory `out`: counts.json (rows per schema.table, from the COPY
# blocks), ledger (the sum of public.credit_ledger.delta in tenths of a
# credit) and latest (the largest drizzle.__drizzle_migrations.created_at).
MANIFEST_AWK='
BEGIN { FS = "\t"; inblock = 0; ntables = 0; ledger = 0; latest = ""; latestnum = -1; bad = "" }
function tenths(v,    neg, n, parts, whole, frac) {
  neg = 0
  if (substr(v, 1, 1) == "-") { neg = 1; v = substr(v, 2) }
  n = split(v, parts, ".")
  whole = parts[1] + 0
  frac = 0
  if (n > 1 && length(parts[2]) > 0) { frac = substr(parts[2], 1, 1) + 0 }
  whole = whole * 10 + frac
  return neg ? -whole : whole
}
inblock == 0 && /^COPY / {
  table = $0
  sub(/^COPY /, "", table)
  sub(/ .*$/, "", table)
  if (table !~ /^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/) { bad = table; exit 3 }
  cols = $0
  sub(/^[^(]*\(/, "", cols)
  sub(/\) FROM stdin;$/, "", cols)
  ncols = split(cols, names, ", ")
  deltacol = 0
  createdcol = 0
  for (i = 1; i <= ncols; i++) {
    if (table == "public.credit_ledger" && names[i] == "delta") deltacol = i
    if (table == "drizzle.__drizzle_migrations" && names[i] == "created_at") createdcol = i
  }
  rows = 0
  inblock = 1
  next
}
inblock == 1 && $0 == "\\." {
  if (!(table in counts)) { ntables++; order[ntables] = table }
  counts[table] = rows
  inblock = 0
  next
}
inblock == 1 {
  rows++
  if (deltacol > 0 && $deltacol != "\\N") ledger += tenths($deltacol)
  if (createdcol > 0 && $createdcol != "\\N" && ($createdcol + 0) > latestnum) { latestnum = $createdcol + 0; latest = $createdcol }
  next
}
END {
  if (bad != "") { print "unexpected table name in the dump: " bad > "/dev/stderr"; exit 3 }
  if (inblock == 1) { print "the dump ended inside the rows of " table > "/dev/stderr"; exit 3 }
  printf "{" > (out "/counts.json")
  for (i = 1; i <= ntables; i++) printf "%s\"%s\": %.0f", (i > 1 ? ", " : ""), order[i], counts[order[i]] > (out "/counts.json")
  printf "}" > (out "/counts.json")
  printf "%.0f", ledger > (out "/ledger")
  printf "%s", latest > (out "/latest")
}
'

main() {
  require_env BACKUP_DATABASE_URL BACKUP_AGE_RECIPIENT BACKUP_R2_ACCOUNT_ID BACKUP_R2_BUCKET \
    BACKUP_R2_ACCESS_KEY_ID BACKUP_R2_SECRET_ACCESS_KEY NEXT_PUBLIC_SITE_URL CRON_SECRET
  case "$BACKUP_AGE_RECIPIENT" in
    age1*) ;;
    *) log "BACKUP_AGE_RECIPIENT must be an age public key (age1...)"; exit 2 ;;
  esac
  case "$BACKUP_R2_ACCOUNT_ID" in
    *[!A-Za-z0-9]*) log "BACKUP_R2_ACCOUNT_ID must be letters and digits only"; exit 2 ;;
  esac

  stamp="${BACKUP_TIMESTAMP:-$(date -u +%Y%m%dT%H%M%SZ)}"
  if ! printf '%s' "$stamp" | grep -Eq '^[0-9]{8}T[0-9]{6}Z$'; then
    log "BACKUP_TIMESTAMP must look like 20261001T091500Z"
    exit 2
  fi
  year="${stamp:0:4}"
  month="${stamp:4:2}"
  day="${stamp:6:2}"
  started_at="${year}-${month}-${day}T${stamp:9:2}:${stamp:11:2}:${stamp:13:2}Z"
  name="curvi-${stamp}.tar.age"
  daily_key="daily/${year}/${month}/${day}/${name}"
  monthly_key=""
  if [ "$day" = "01" ]; then
    monthly_key="monthly/${year}-${month}/${name}"
  fi

  ping_healthchecks /start

  WORK="$(mktemp -d "${TMPDIR:-/tmp}/curvi-backup.XXXXXX")"
  archive="$WORK/archive"
  mkdir "$archive"

  log "dumping the public and drizzle schemas"
  pg_dump --dbname="$BACKUP_DATABASE_URL" --format=custom --no-owner --no-privileges \
    --schema=public --schema=drizzle --file="$archive/public.dump"

  # After the public dump, so a user who signs up in between is in the auth
  # dump without a workspace (provisioned on first sign in) rather than the
  # reverse.
  log "dumping auth users, identities and factors, data only"
  pg_dump --dbname="$BACKUP_DATABASE_URL" --format=custom --data-only --no-owner --no-privileges \
    --table=auth.users --table=auth.identities --table=auth.mfa_factors --file="$archive/auth.dump"

  log "reading the manifest from the dumps"
  pg_restore --list "$archive/public.dump" > "$WORK/public.toc"
  server_version="$(toc_value 'Dumped from database version' "$WORK/public.toc")"
  pg_dump_version="$(toc_value 'Dumped by pg_dump version' "$WORK/public.toc")"
  if [ -z "$server_version" ] || [ -z "$pg_dump_version" ]; then
    log "pg_restore --list did not show the server and pg_dump versions"
    exit 3
  fi
  pg_restore --data-only --file="$WORK/public.sql" "$archive/public.dump"
  pg_restore --data-only --file="$WORK/auth.sql" "$archive/auth.dump"
  awk -v out="$WORK" "$MANIFEST_AWK" "$WORK/public.sql" "$WORK/auth.sql"
  rm -f "$WORK/public.sql" "$WORK/auth.sql"

  counts_json="$(cat "$WORK/counts.json")"
  ledger_tenths="$(cat "$WORK/ledger")"
  latest="$(cat "$WORK/latest")"
  case "$latest" in
    *[!0-9]*) log "the newest migration mark is not a number"; exit 3 ;;
  esac
  latest_json="null"
  if [ -n "$latest" ]; then
    latest_json="\"$latest\""
  fi
  case "$counts_json" in
    *'"public.credit_ledger"'*) ;;
    *) log "the public dump has no credit_ledger rows block"; exit 3 ;;
  esac

  cat > "$archive/manifest.json" <<EOF
{
  "format": 1,
  "createdAt": "$started_at",
  "serverVersion": "$server_version",
  "pgDumpVersion": "$pg_dump_version",
  "latestMigration": $latest_json,
  "ledgerTotalTenths": $ledger_tenths,
  "counts": $counts_json,
  "files": {
    "public.dump": { "bytes": $(bytes_of "$archive/public.dump"), "sha256": "$(sha256_of "$archive/public.dump")" },
    "auth.dump": { "bytes": $(bytes_of "$archive/auth.dump"), "sha256": "$(sha256_of "$archive/auth.dump")" }
  }
}
EOF

  log "encrypting"
  tar -cf - -C "$archive" manifest.json public.dump auth.dump \
    | age --encrypt --recipient "$BACKUP_AGE_RECIPIENT" --output "$WORK/$name"
  rm -rf "$archive"
  bytes="$(bytes_of "$WORK/$name")"
  sha256="$(sha256_of "$WORK/$name")"
  if [ "$bytes" -le 0 ]; then
    log "the encrypted file is empty"
    exit 3
  fi

  # rclone reads the remote from RCLONE_CONFIG_<NAME>_<OPTION> variables.
  # no_check_bucket: the token can write objects but not create buckets.
  export RCLONE_CONFIG_CURVIBACKUP_TYPE=s3
  export RCLONE_CONFIG_CURVIBACKUP_PROVIDER=Cloudflare
  export RCLONE_CONFIG_CURVIBACKUP_ACCESS_KEY_ID="$BACKUP_R2_ACCESS_KEY_ID"
  export RCLONE_CONFIG_CURVIBACKUP_SECRET_ACCESS_KEY="$BACKUP_R2_SECRET_ACCESS_KEY"
  export RCLONE_CONFIG_CURVIBACKUP_ENDPOINT="https://${BACKUP_R2_ACCOUNT_ID}.r2.cloudflarestorage.com"
  export RCLONE_CONFIG_CURVIBACKUP_ACL=private
  export RCLONE_CONFIG_CURVIBACKUP_NO_CHECK_BUCKET=true

  log "uploading ${daily_key} (${bytes} bytes)"
  rclone copyto "$WORK/$name" "curvibackup:${BACKUP_R2_BUCKET}/${daily_key}"
  monthly_json="null"
  if [ -n "$monthly_key" ]; then
    log "uploading ${monthly_key}"
    rclone copyto "$WORK/$name" "curvibackup:${BACKUP_R2_BUCKET}/${monthly_key}"
    monthly_json="\"$monthly_key\""
  fi

  finished_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  cat > "$WORK/report.json" <<EOF
{
  "key": "$daily_key",
  "monthlyKey": $monthly_json,
  "bytes": $bytes,
  "sha256": "$sha256",
  "counts": $counts_json,
  "ledgerTotalTenths": $ledger_tenths,
  "latestMigration": $latest_json,
  "serverVersion": "$server_version",
  "pgDumpVersion": "$pg_dump_version",
  "startedAt": "$started_at",
  "finishedAt": "$finished_at"
}
EOF
  # The secret goes in a header file, not on the command line.
  printf 'authorization: Bearer %s\n' "$CRON_SECRET" > "$WORK/report.headers"
  log "reporting to the site"
  curl -fsS -m 30 --retry 3 -o /dev/null -X POST \
    -H "@$WORK/report.headers" -H 'content-type: application/json' \
    --data-binary "@$WORK/report.json" "${NEXT_PUBLIC_SITE_URL%/}/api/cron/backup-report"

  ping_healthchecks ""
  log "done: ${daily_key}"
}

main "$@"
