# The image for Curvi's cron jobs on Render (docs/phases/PHASE_20.md P20-10;
# P20-38's tick runs from the same image with its own command).
#
# Build context: the repository root (Render's default), Dockerfile path
# ./ops/cron/Dockerfile. The default command runs the nightly backup.
#
# pg_dump refuses to dump a server newer than its own major version. Keep
# PG_MAJOR at the production server's major or newer: run
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
CMD ["/usr/local/bin/curvi-backup"]
