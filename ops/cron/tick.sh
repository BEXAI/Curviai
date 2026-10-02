#!/usr/bin/env bash
# One HTTP tick, every ten minutes. Credentials stay in protected temporary
# files, never curl's argument list. No retry of the work POST: the next cron
# can retry due jobs, protected by the server lease and per-job idempotency.
set -Eeuo pipefail
umask 077

work=""
log() { printf '%s\n' "tick: $*" >&2; }
ping() {
  if [ -z "${HEALTHCHECKS_TICK_URL:-}" ]; then return 0; fi
  printf 'url = "%s%s"\n' "${HEALTHCHECKS_TICK_URL%/}" "$1" > "$work/ping.conf"
  curl --silent --fail --connect-timeout 5 --max-time 10 --output /dev/null --config "$work/ping.conf"
}
finish() {
  result=$?
  trap - EXIT
  if [ "$result" -ne 0 ] && [ -n "$work" ]; then
    ping /fail || log "failure heartbeat did not reach the monitor"
  fi
  if [ -n "$work" ]; then rm -rf "$work"; fi
  exit "$result"
}
trap finish EXIT

for name in NEXT_PUBLIC_SITE_URL CRON_SECRET; do
  if [ -z "${!name:-}" ]; then log "$name is required"; exit 2; fi
done
# Origin-only HTTPS destination, with no credentials/query/fragment. These
# checks also stop newline injection into curl's header/config files.
case "$NEXT_PUBLIC_SITE_URL" in *$'\r'*|*$'\n'*) log "NEXT_PUBLIC_SITE_URL must be one line"; exit 2 ;; esac
if ! printf '%s' "$NEXT_PUBLIC_SITE_URL" | LC_ALL=C grep -Eq '^https://[A-Za-z0-9.-]+(:[0-9]+)?/?$'; then
  log "NEXT_PUBLIC_SITE_URL must be an HTTPS origin"; exit 2
fi
case "$CRON_SECRET" in *$'\r'*|*$'\n'*) log "CRON_SECRET must be one line"; exit 2 ;; esac
if [ -n "${HEALTHCHECKS_TICK_URL:-}" ]; then
  case "$HEALTHCHECKS_TICK_URL" in https://*) ;; *) log "HEALTHCHECKS_TICK_URL must use HTTPS"; exit 2 ;; esac
  case "$HEALTHCHECKS_TICK_URL" in *$'\r'*|*$'\n'*|*'"'*|*'\'*) log "HEALTHCHECKS_TICK_URL is invalid"; exit 2 ;; esac
fi
work="$(mktemp -d "${TMPDIR:-/tmp}/curvi-tick.XXXXXX")"
printf 'authorization: Bearer %s\n' "$CRON_SECRET" > "$work/headers"
ping /start || log "start heartbeat did not reach the monitor"
if ! curl --silent --fail --connect-timeout 10 --max-time 300 --output /dev/null \
  --request POST --header "@$work/headers" "${NEXT_PUBLIC_SITE_URL%/}/api/cron/tick"; then
  log "scheduled work failed"; exit 1
fi
if ! ping ""; then log "success heartbeat did not reach the monitor"; exit 1; fi
log "scheduled work completed"
