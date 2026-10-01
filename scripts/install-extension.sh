#!/bin/sh
# Build and install/upgrade the extension into the running espocrm container (dev/staging/prod).
# Bump "version" in espocrm-extension/manifest.json before re-installing.
set -eu
cd "$(dirname "$0")/.."
sh scripts/build-extension.sh
docker compose cp dist/office-automation.zip espocrm:/var/www/html/oa.zip >/dev/null
docker compose exec -T espocrm chown www-data oa.zip
docker compose exec -T -u www-data espocrm php command.php extension --file=oa.zip
docker compose exec -T espocrm rm -f oa.zip
# EspoCRM blocks webhooks to internal hosts unless listed as host:port; allow our automation service.
docker compose exec -T -u www-data espocrm php command.php config:set webhookAllowedAddressList '["automation:3000"]' --type=json
# Local dev only (docker-compose.local.yml): allow the GreenMail test mail server.
if [ -n "${LOCAL_MAILSERVER:-}" ]; then
  docker compose exec -T -u www-data espocrm php command.php config:set emailServerAllowedAddressList '["greenmail:3143","greenmail:3025"]' --type=json
fi
# Brute-force protection (config-only settings): lock a login after 5 failed attempts within 60 seconds.
docker compose exec -T -u www-data espocrm php command.php config:set authMaxFailedAttemptNumber 5 --type=int
docker compose exec -T -u www-data espocrm php command.php config:set authFailedAttemptsPeriod '60 seconds'
