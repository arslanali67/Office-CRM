#!/bin/sh
# Restore a backup made by backup.sh. Usage:
#   sh scripts/restore.sh <timestamp>            e.g. 2026-10-01_0215  (files in ./backups; add --from-remote to fetch them first)
# The database is restored into $MYSQL_DATABASE. DESTRUCTIVE: it replaces the live data, so the script asks first.
# For a rehearsal (staging, or "does my backup work?"): RESTORE_DB=restore_check RESTORE_FILES=0 sh scripts/restore.sh <timestamp> --yes
#   restores only the database into a scratch database and leaves the live data alone.
set -eu
set -a; . ./.env; set +a
TS="${1:?usage: restore.sh <timestamp> [--from-remote] [--yes]}"; shift
DIR="${BACKUP_DIR:-./backups}"; DB="${RESTORE_DB:-$MYSQL_DATABASE}"; YES=0; REMOTE=0
for a in "$@"; do [ "$a" = "--yes" ] && YES=1; [ "$a" = "--from-remote" ] && REMOTE=1; done

if [ "$REMOTE" = 1 ]; then
  : "${BACKUP_REMOTE:?BACKUP_REMOTE is not set}"
  mkdir -p "$DIR"; ENVFILE="$DIR/.rclone-env.$$"; : > "$ENVFILE"; chmod 600 "$ENVFILE"; trap 'rm -f "$ENVFILE"' EXIT; env | grep '^RCLONE_' > "$ENVFILE" || true
  MOUNT=""; [ -n "${BACKUP_REMOTE_MOUNT:-}" ] && MOUNT="-v $BACKUP_REMOTE_MOUNT"
  mkdir -p "$DIR"
  docker run --rm --env-file "$ENVFILE" -v "$(pwd)/$DIR:/data" $MOUNT rclone/rclone:latest copy "$BACKUP_REMOTE" /data --include "*_$TS*"
fi

DBFILE="$DIR/db_$TS.sql.gz"; FILES="$DIR/files_$TS.tar.gz"
[ -s "$DBFILE" ] || { echo "missing $DBFILE" >&2; exit 1; }
if [ "$YES" != 1 ]; then
  printf "This REPLACES database '%s' (and the CRM files) with the backup %s. Type RESTORE to continue: " "$DB" "$TS"
  read -r answer; [ "$answer" = RESTORE ] || { echo "cancelled"; exit 1; }
fi

docker compose up -d mysql
docker compose exec -T mysql sh -c "mysql -uroot -p\"\$MYSQL_ROOT_PASSWORD\" -e 'CREATE DATABASE IF NOT EXISTS \`$DB\`'"
gzip -dc "$DBFILE" | docker compose exec -T mysql sh -c "mysql -uroot -p\"\$MYSQL_ROOT_PASSWORD\" '$DB'"
TABLES=$(docker compose exec -T mysql sh -c "mysql -uroot -p\"\$MYSQL_ROOT_PASSWORD\" -N -e \"SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='$DB'\"")
echo "database restored into '$DB': $TABLES tables"

if [ "${RESTORE_FILES:-1}" = 1 ]; then
  [ -s "$FILES" ] || { echo "missing $FILES" >&2; exit 1; }
  docker compose run --rm --no-deps -T -v "$(pwd)/$DIR:/backup" --entrypoint tar espocrm xzf "/backup/files_$TS.tar.gz" -C /var/www/html
  docker compose up -d
  echo "files restored; CRM restarted"
fi
