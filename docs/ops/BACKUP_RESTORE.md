# Backup planning retired

Updated 2026-10-03: the user retired encrypted-backup planning and its release gates. Local disk and GitHub preserve source code, not live database rows, Auth state or stored objects. No database recovery capability is claimed. Existing backup data and security controls remain untouched; no backup service, key or credential is to be provisioned under this plan.

P20-10 nightly backup and P20-11 recurring restore drill are retired, not failed or pending acceptance. A fresh encrypted backup is no longer a prerequisite for migrations, deployment, billing launch or phase completion. Each migration still needs review of its actual data effects, compatible application and worker versions, writer isolation where needed, and rollback or forward-repair limits. Report an irreversible action and its consequence before executing it.

The [historical procedure](archive/BACKUP_RESTORE_PRE_2026-10-03.md), existing scripts, report records and tests remain available for understanding old releases. They do not authorize generating keys, collecting credentials, transmitting a dump, deleting existing backups, changing retention or restoring production. Never commit live database dumps, private keys or secrets to GitHub.

Use [RUNBOOK.md](RUNBOOK.md) for current migration/release controls and [DISASTER_RECOVERY.md](DISASTER_RECOVERY.md) for source/configuration recovery and incident containment.
