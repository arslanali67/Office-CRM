#!/bin/sh
# Nightly backup: DB dump + EspoCRM files, kept 14 days locally and (optionally) copied off the server. Run from cron in the repo dir.
#
# Off-server copy uses rclone (any provider: S3, Backblaze B2, Google Drive, SFTP, ...), run from a container, configured only by
# environment variables in .env, for example for S3-compatible storage:
#   BACKUP_REMOTE=offsite:my-bucket/office-crm
#   RCLONE_CONFIG_OFFSITE_TYPE=s3
#   RCLONE_CONFIG_OFFSITE_PROVIDER=Other
#   RCLONE_CONFIG_OFFSITE_ACCESS_KEY_ID=...        RCLONE_CONFIG_OFFSITE_SECRET_ACCESS_KEY=...
#   RCLONE_CONFIG_OFFSITE_ENDPOINT=https://s3.example.com
# The backups contain customer data: use a provider account for backups only, and preferably an encrypted (rclone "crypt") remote.
# Without BACKUP_REMOTE only the local copy is made, and the script says so.
# For tests: BACKUP_REMOTE_MOUNT=/host/dir:/container/dir mounts a folder for a "local"-type remote.
set -eu
set -a; . ./.env; set +a
DIR="${BACKUP_DIR:-./backups}"; TS=$(date +%F_%H%M)
mkdir -p "$DIR"

docker compose exec -T mysql mysqldump -u root -p"$MYSQL_ROOT_PASSWORD" --single-transaction "$MYSQL_DATABASE" | gzip > "$DIR/db_$TS.sql.gz"
docker compose run --rm --no-deps -T -v "$(pwd)/$DIR:/backup" --entrypoint tar espocrm czf "/backup/files_$TS.tar.gz" -C /var/www/html data custom client/custom
# an empty dump means mysqldump failed: never keep (or upload) it as if it were a backup
[ "$(gzip -dc "$DIR/db_$TS.sql.gz" | wc -c)" -gt 1000 ] || { echo "backup FAILED: database dump is empty" >&2; rm -f "$DIR/db_$TS.sql.gz"; exit 1; }
find "$DIR" -type f \( -name 'db_*' -o -name 'files_*' \) -mtime +14 -delete

if [ -z "${BACKUP_REMOTE:-}" ]; then
  echo "backup done (LOCAL ONLY: set BACKUP_REMOTE in .env to also copy it off the server): $DIR/*_$TS*"
  exit 0
fi

# rclone only gets the RCLONE_* variables, not the other secrets in .env
ENVFILE="$DIR/.rclone-env.$$"; : > "$ENVFILE"; chmod 600 "$ENVFILE"; trap 'rm -f "$ENVFILE"' EXIT
env | grep '^RCLONE_' > "$ENVFILE" || true
MOUNT=""; [ -n "${BACKUP_REMOTE_MOUNT:-}" ] && MOUNT="-v $BACKUP_REMOTE_MOUNT"
rclone() { docker run --rm --env-file "$ENVFILE" -v "$(pwd)/$DIR:/data:ro" $MOUNT rclone/rclone:latest "$@"; }

rclone copy /data "$BACKUP_REMOTE" --include "*_$TS*" --checksum
# verify what arrived: names and sizes must match
rclone check /data "$BACKUP_REMOTE" --include "*_$TS*" --one-way
rclone delete "$BACKUP_REMOTE" --min-age 14d --include 'db_*' --include 'files_*'
echo "backup done and copied to $BACKUP_REMOTE: $DIR/*_$TS*"
