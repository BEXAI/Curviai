# The image for Curvi's active tick on Render (PHASE_20 P20-38).
# Legacy encrypted-backup tooling remains available only by explicit command.
#
# Build context: the repository root (Render's default), Dockerfile path
# ./ops/cron/Dockerfile. The default command runs the tick.
#
# For the retained legacy tooling, pg_dump refuses to dump a server newer
# than its own major version. Keep PG_MAJOR at the production server's
# major or newer: run
# SHOW server_version; in the Supabase SQL editor (17 at the time of
# writing). Debian bookworm ships age 1.1.1 and rclone 1.60.1; R2 needs
# rclone 1.59 or newer.
ARG PG_MAJOR=17
FROM postgres:${PG_MAJOR}-bookworm

RUN apt-get update \
  && apt-get install -y --no-install-recommends age ca-certificates curl rclone \
  && rm -rf /var/lib/apt/lists/*

COPY ops/cron/backup.sh /usr/local/bin/curvi-backup
COPY ops/cron/tick.sh /usr/local/bin/curvi-tick
RUN chmod 0755 /usr/local/bin/curvi-backup /usr/local/bin/curvi-tick

# No database server runs in this image: clear the postgres entrypoint and
# run as the unprivileged postgres user.
ENTRYPOINT []
USER postgres
WORKDIR /tmp
CMD ["/usr/local/bin/curvi-tick"]
