# Upgrading EspoCRM (and rolling back)

We never edit EspoCRM's core. Everything of ours is the extension (`espocrm-extension/`), the automation service and configuration, so an upgrade is: **test on staging, then change one version number**.
Apply EspoCRM *security* releases within 2 weeks of publication (watch https://github.com/espocrm/espocrm/releases).

## Upgrade steps

1. **Back up production first**: `sh scripts/backup.sh` and copy the files off the server.
2. **Staging**: copy the production backup to staging (restore, below), then set the new version in staging's `.env`:
   `ESPOCRM_VERSION=<new version>` and run:
   ```
   docker compose pull
   docker compose up -d
   ```
   The image upgrades the database automatically on start (it migrates; check `docker compose logs espocrm`).
3. Reinstall our extension for that version: `sh scripts/install-extension.sh` (the version in `espocrm-extension/manifest.json` must be higher than the installed one; bump it if you re-install without changes).
4. **Test on staging**: run `scripts/test-m1.mjs` ... `test-m6.mjs` (or the go-live checklist). Click through: dashboards, an email, a DM, a brief, attendance.
   If an EspoCRM release breaks our extension, stay on the old version and fix the extension on staging first.
5. **Production**: set the same `ESPOCRM_VERSION` in production's `.env`, then `docker compose pull && docker compose up -d` and `sh scripts/install-extension.sh`. Check `https://crm.<domain>` and send one real test email.
6. Write the new version in `PROJECT.md` (section 12) and note the date.

## Roll back

If anything fails after an upgrade:
```
docker compose down
# set ESPOCRM_VERSION back to the old value in .env
# restore the backup taken in step 1 (below)
docker compose up -d
```
Do not roll back by only changing the version: the database was already migrated. Always restore the backup that was made before the upgrade.

## Restore from a backup

`scripts/backup.sh` writes `backups/db_<time>.sql.gz` and `backups/files_<time>.tar.gz` (14 days kept, copied off the server when `BACKUP_REMOTE` is set).
```
sh scripts/restore.sh <time>                # from ./backups; asks you to type RESTORE
sh scripts/restore.sh <time> --from-remote  # fetches that backup from the off-site storage first (e.g. after losing the server)
```
`<time>` is the part of the file name after `db_`, e.g. `2026-10-01_0215`. Rehearse without touching live data: `RESTORE_DB=restore_check RESTORE_FILES=0 sh scripts/restore.sh <time> --yes` (restores only the database into a scratch database).
Test a restore on staging at least once before go-live, and after every major change of the setup.

## Staging on the same machine (R10 / M0.6)
Staging is a second copy of this folder with its own `.env`, so it gets its own containers, volumes and database (the Compose project is named after the folder).
1. Copy the code (not `.env`, `.git`, `backups`, `dist`, `site-rendered`) to a sibling folder, e.g. `../office-crm-staging`.
2. In its `.env` use new passwords, empty `ESPO_API_KEY` / `WEBHOOK_SECRET*` (the setup fills them) and different ports and network:
   `ESPO_PORT=8180 WS_PORT=8181 AUTOMATION_PORT=3200 MOCK_META_PORT=4111 GREENMAIL_SMTP_PORT=3125 GREENMAIL_IMAP_PORT=3243 INTERNAL_SUBNET=10.78.78.0/24 AUTOMATION_IP=10.78.78.10` (one per line).
3. In the staging folder: `sh scripts/deploy.sh install --local --yes` (CRM at http://localhost:8180). The test scripts read the same ports from `.env`.
4. To try new code: copy the changed files into the staging folder, then `sh scripts/deploy.sh update --local --yes` (backs up first); if it goes wrong, `sh scripts/deploy.sh rollback --local --yes`.
On a server, staging is the same thing on its own VM or folder with `CRM_DOMAIN=staging.<domain>`, without `--local`.

## Other updates
- **Operating system**: automatic security updates are on (`scripts/harden-server.sh`); reboot in a quiet hour when the server says it is needed (`/var/run/reboot-required`).
- **Containers** (mysql, caddy, node): `docker compose pull && docker compose up -d` monthly; same staging-first rule.
- **Claude models / Meta Graph API version**: set by `AI_CLASSIFY_MODEL`, `AI_DRAFT_MODEL` and `GRAPH_URL` in `.env`; test on staging before changing.
