#!/bin/sh
# Deploy the Office CRM on a server. Run from the repo directory.
#   sh scripts/deploy.sh install             first installation (after harden-server.sh and a filled-in .env)
#   sh scripts/deploy.sh update              backup, pull new code/images, upgrade, re-apply setup, check
#   sh scripts/deploy.sh rollback            go back to the state before the last update (code, version, database)
#   sh scripts/deploy.sh render-site         (re)create the public privacy / data-deletion pages from site/ and .env
#   sh scripts/deploy.sh check               post-deploy checks only (PASS / WARN / FAIL)
#   sh scripts/deploy.sh add-employee <userName> "<First>" "<Last>" <email>
# Flags: --local (rehearse on a dev machine with docker-compose.local.yml; relaxes the production checks)
#        --dry-run (print the steps, change nothing)   --yes (do not ask for confirmation)
# Staging and production are the same script with different .env files.
set -eu
cd "$(dirname "$0")/.."

CMD="${1:-}"; [ $# -gt 0 ] && shift
LOCAL=0; DRY=0; YES=0; ARGS=""
for a in "$@"; do
  case "$a" in --local) LOCAL=1;; --dry-run) DRY=1;; --yes) YES=1;; *) ARGS="$ARGS|$a";; esac
done

[ -f .env ] || { echo "No .env: copy .env.example to .env and fill it in first." >&2; exit 1; }
chmod 600 .env 2>/dev/null || true # it holds every secret
trap 'rm -f .deploy-env' EXIT INT TERM
set -a; . ./.env; set +a
if [ "$LOCAL" = 1 ]; then
  export COMPOSE_PATH_SEPARATOR=: COMPOSE_FILE=docker-compose.yml:docker-compose.local.yml LOCAL_MAILSERVER=1
  URL="http://localhost:${ESPO_PORT:-8080}"
else
  URL="${DEPLOY_URL:-https://${CRM_DOMAIN:-}}"
fi
export MSYS_NO_PATHCONV=1 # Git Bash on Windows: do not mangle container paths

# ---------------- helpers ----------------
OK=0; WARN=0; FAIL=0
pass() { OK=$((OK+1)); echo "PASS  $*"; }
warn() { WARN=$((WARN+1)); echo "WARN  $*"; }
bad()  { FAIL=$((FAIL+1)); echo "FAIL  $*"; }
step() { echo; echo "== $*"; }
x()    { if [ "$DRY" = 1 ]; then echo "  + $*"; else "$@"; fi; }
confirm() { [ "$YES" = 1 ] || [ "$DRY" = 1 ] && return 0; printf "%s Type yes to continue: " "$1"; read -r a; [ "$a" = yes ]; }

bad_value() { # $1 = name; true if empty or still a placeholder
  eval "v=\${$1:-}"
  [ -z "$v" ] || case "$v" in *change-me*|*example.com*|*PLACEHOLDER*|*Your\ Company*|*Example\ Street*) return 0;; esac; return 1
}

preflight() {
  step "Pre-flight checks"
  command -v docker >/dev/null || { echo "docker is not installed" >&2; exit 1; }
  docker compose version >/dev/null 2>&1 || { echo "docker compose is not available" >&2; exit 1; }
  for v in MYSQL_ROOT_PASSWORD MYSQL_PASSWORD ESPOCRM_ADMIN_PASSWORD ESPOCRM_VERSION; do bad_value $v && bad "$v is empty or still a placeholder"; done
  [ "${ESPOCRM_ADMIN_USERNAME:-admin}" = admin ] || bad "ESPOCRM_ADMIN_USERNAME must stay 'admin' (the EspoCRM installer only supports it)"
  [ "$LOCAL" = 1 ] && { [ "$FAIL" = 0 ] || exit 1; return 0; }
  [ ${#ESPOCRM_ADMIN_PASSWORD} -ge 12 ] || bad "ESPOCRM_ADMIN_PASSWORD needs at least 12 characters"
  case "${CRM_DOMAIN:-}" in ""|localhost|*example.com) bad "CRM_DOMAIN must be the real domain (crm.<your-domain>)";; esac
  case "${AI_PROVIDER:-}" in gemini) AIKEY=GEMINI_API_KEY;; openrouter) AIKEY=OPENROUTER_API_KEY;; *) AIKEY=ANTHROPIC_API_KEY;; esac
  for v in $AIKEY MAILBOX_ADDRESS MAILBOX_IMAP_HOST MAILBOX_USER MAILBOX_PASSWORD MAILBOX_SMTP_HOST OWNER_EMAIL COMPANY_NAME COMPANY_ADDRESS; do bad_value $v && bad "$v is not set (needed for production)"; done
  [ "${AI_MODE:-}" != stub ] || bad "AI_MODE=stub is for local testing only: leave it empty in production"
  case "${MAILBOX_IMAP_HOST:-}" in greenmail*) bad "MAILBOX_IMAP_HOST still points at the local test mail server";; esac
  [ "${ATTENDANCE_TRUST_PROXY:-}" = true ] || bad "ATTENDANCE_TRUST_PROXY must be true behind Caddy (otherwise attendance records the proxy's address)"
  [ -n "${META_APP_SECRET:-}" ] && [ "${META_APP_SECRET}" != local-meta-app-secret ] || warn "META_APP_SECRET not set: Instagram/Facebook stays off until Meta is connected"
  [ -n "${ATTENDANCE_ALLOWED_IPS:-}" ] || warn "ATTENDANCE_ALLOWED_IPS is empty: check-in works from any network"
  [ -n "${BACKUP_REMOTE:-}" ] || warn "BACKUP_REMOTE is empty: backups stay on this server only"
  [ "$FAIL" = 0 ] || { echo; echo "Fix the FAIL items in .env and run again."; exit 1; }
}

# runs a Node script from this repo inside the Docker network (EspoCRM has no public port in production)
runnode() {
  NET=$(docker inspect "$(docker compose ps -q espocrm)" --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}' | awk '{print $1}')
  # docker's --env-file does not understand quotes or trailing comments the way .env files do
  sed -e 's/[[:space:]]\{1,\}#.*$//' -e '/^[[:space:]]*#/d' -e '/^[[:space:]]*$/d' -e 's/^\([A-Za-z_][A-Za-z0-9_]*\)="\(.*\)"$/\1=\2/' .env > .deploy-env
  chmod 600 .deploy-env
  SKIP=""; [ "$LOCAL" = 1 ] || SKIP=1
  docker run --rm --network "$NET" --env-file .deploy-env -e BASE_URL=http://espocrm -e SKIP_PLACEHOLDER_USERS="$SKIP" \
    -e "AUTOMATION_IP=${AUTOMATION_IP:-}" -v "$(pwd -W 2>/dev/null || pwd)":/repo -w /repo node:24-alpine node "$@" || { rm -f .deploy-env; return 1; }
  rm -f .deploy-env
}

wait_healthy() {
  step "Waiting for EspoCRM"
  [ "$DRY" = 1 ] && { echo "  + wait until EspoCRM answers"; return 0; }
  i=0
  until docker compose exec -T automation wget -S --spider -q http://espocrm/api/v1/App/user 2>&1 | grep -q "HTTP/1.1 401"; do
    i=$((i+1)); [ $i -le 90 ] || { echo "EspoCRM did not come up in 7 minutes: docker compose logs espocrm" >&2; exit 1; }
    sleep 5
  done
  echo "EspoCRM is up"
}

apply_setup() {
  step "Installing the extension and applying the setup (safe to repeat)"
  x sh scripts/install-extension.sh
  for s in m1 m3 m4 m5 m6; do
    [ "$DRY" = 1 ] && { echo "  + node scripts/setup-$s.mjs (in a container)"; continue; }
    # up to 3 tries (Docker's internal DNS can briefly fail for a new container); a failure stops the deploy
    i=0; until out=$(runnode scripts/setup-$s.mjs 2>&1); do
      i=$((i+1)); [ $i -lt 3 ] || { echo "$out" >&2; echo "setup-$s.mjs failed: deploy stopped" >&2; exit 1; }
      echo "setup-$s.mjs failed, retrying..."; sleep 5
    done
    echo "$out" | tail -1
  done
  x docker compose up -d automation # reload the secrets the setup scripts generated
}

# Public pages Meta requires (privacy policy, data deletion), filled with the company's details from .env
render_site() {
  step "Rendering the public pages (privacy policy, data deletion)"
  [ "$DRY" = 1 ] && { echo "  + site/*.html -> site-rendered/"; return 0; }
  mkdir -p site-rendered
  esc() { printf '%s' "$1" | sed -e 's/[&|\]/\&/g'; }
  for f in site/*.html; do
    sed -e "s|__COMPANY_NAME__|$(esc "${COMPANY_NAME:-Your Company}")|g" -e "s|__COMPANY_ADDRESS__|$(esc "${COMPANY_ADDRESS:-}")|g"         -e "s|__CONTACT_EMAIL__|$(esc "${CONTACT_EMAIL:-${OWNER_EMAIL:-}}")|g" -e "s|__DOMAIN__|$(esc "${CRM_DOMAIN:-localhost}")|g" "$f" > "site-rendered/$(basename "$f")"
  done
  echo "wrote site-rendered/: $(ls site-rendered | tr '
' ' ')"
}

# ---------------- checks ----------------
run_checks() {
  step "Checks against $URL"
  [ "$DRY" = 1 ] && { echo "  + (checks skipped in dry run)"; return 0; }
  WANT="mysql espocrm espocrm-daemon espocrm-websocket automation"; [ "$LOCAL" = 1 ] || WANT="$WANT caddy"
  RUNNING=$(docker compose ps --status running --format '{{.Service}}')
  for s in $WANT; do echo "$RUNNING" | grep -qx "$s" && pass "service $s is running" || bad "service $s is NOT running"; done

  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 --retry 2 --retry-delay 5 --retry-all-errors "$URL/api/v1/App/user" || true)
  [ "$code" = 401 ] && pass "CRM answers at $URL" || bad "CRM at $URL answered '$code' (expected 401 without login)"
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 --retry 2 --retry-delay 5 --retry-all-errors -u "admin:$ESPOCRM_ADMIN_PASSWORD" "$URL/api/v1/App/user" || true)
  [ "$code" = 200 ] && pass "owner login works" || bad "owner login answered '$code'"
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 --retry 2 --retry-delay 5 --retry-all-errors -u "admin:$ESPOCRM_ADMIN_PASSWORD" "$URL/api/v1/Attendance/action/status" || true)
  [ "$code" = 200 ] && pass "our extension is installed" || bad "extension endpoint answered '$code'"

  if [ "$LOCAL" = 0 ]; then
    curl -sSf -o /dev/null --max-time 20 "$URL/" 2>/dev/null && pass "HTTPS certificate is valid" || bad "HTTPS failed (DNS pointing at this server? ports 80/443 open?)"
    curl -sI --max-time 20 "$URL/" | grep -qi '^strict-transport-security' && pass "HSTS header is sent" || bad "no HSTS header"
    for page in privacy data-deletion; do
      body=$(curl -s --max-time 20 "$URL/$page" || true)
      echo "$body" | grep -qi '<h1>' && ! echo "$body" | grep -q '__COMPANY' && pass "public page /$page is served and filled in" || bad "public page /$page is missing or still has placeholders (sh scripts/deploy.sh render-site)"
    done
    PUB=$(docker compose ps --format '{{.Service}} {{.Ports}}' | grep -E '0\.0\.0\.0:|:::' | grep -v '^caddy ' || true)
    [ -z "$PUB" ] && pass "only Caddy is reachable from outside" || bad "other services publish ports: $PUB"
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 -H 'X-Api-Key: probe' "$URL/api/v1/App/user" || true)
    [ "$code" = 403 ] && pass "API-key requests from the internet are refused" || bad "an API key request from outside answered '$code' (expected 403 from Caddy)"
    crontab -l 2>/dev/null | grep -q 'scripts/backup.sh' && pass "nightly backup is scheduled" || warn "nightly backup is not scheduled: sh scripts/install-cron.sh"
  fi
  if [ -n "${META_VERIFY_TOKEN:-}" ]; then
    ch="ok$$"; got=$(curl -s --max-time 20 "$URL/webhooks/meta?hub.mode=subscribe&hub.verify_token=$META_VERIFY_TOKEN&hub.challenge=$ch" || true)
    [ "$got" = "$ch" ] && pass "Meta webhook URL answers the handshake" || { [ "$LOCAL" = 1 ] && pass "Meta webhook not exposed locally (served on :${AUTOMATION_PORT:-3100} only)" || bad "Meta webhook URL did not answer the handshake"; }
  fi
  [ "$(docker compose exec -T automation wget -qO- http://localhost:3000/health 2>/dev/null)" = ok ] && pass "automation service is healthy" || bad "automation service health check failed"
  find backups -name 'db_*' -mmin -1560 2>/dev/null | grep -q . && pass "a backup from the last 26 hours exists" || warn "no backup from the last 26 hours"
  [ "${AI_MODE:-}" = stub ] && warn "AI_MODE=stub: replies come from a keyword stub, not Claude"
  echo; echo "Result: $OK passed, $WARN warnings, $FAIL failed"
  [ "$FAIL" = 0 ]
}

# ---------------- commands ----------------
case "$CMD" in
install)
  preflight
  confirm "Install the Office CRM here?" || exit 1
  render_site
  step "Starting the stack"
  [ "$LOCAL" = 1 ] || { grep -q '^AUTOMATION_IP=' .env || { [ "$DRY" = 1 ] || echo "AUTOMATION_IP=10.77.77.10" >> .env; AUTOMATION_IP=10.77.77.10; export AUTOMATION_IP; }; }
  x mkdir -p backups
  x docker compose pull --ignore-buildable
  x docker compose up -d --build
  wait_healthy
  apply_setup
  [ "$LOCAL" = 1 ] || { step "Nightly backup"; x sh scripts/install-cron.sh; }
  run_checks || true
  cat <<'EOF'

Next (by hand):
  1. Log in as admin at your CRM address; enrol two-factor: top right menu > Preferences > Security.
  2. Replace the (TEST) knowledge base facts with your real ones: docs/KNOWLEDGE-BASE.md, then node --env-file=.env scripts/load-kb.mjs
  3. Add staff:  sh scripts/deploy.sh add-employee <userName> "<First>" "<Last>" <email>
  4. Meta: set the webhook callback to https://<your-domain>/webhooks/meta with the verify token from .env.
  5. Keep draft-only mode on for the first two weeks (dashboard > AI control).
EOF
  ;;
update)
  preflight
  confirm "Update the running system? A backup is taken first." || exit 1
  step "Backup before the update"
  x sh scripts/backup.sh
  TS=$(ls -t backups/db_*.sql.gz 2>/dev/null | head -1 | sed 's#.*/db_##; s#\.sql\.gz##')
  [ "$DRY" = 1 ] || [ -n "$TS" ] || { echo "No backup found: not updating." >&2; exit 1; }
  COMMIT=$(git rev-parse HEAD 2>/dev/null || echo none)
  [ "$DRY" = 1 ] || printf 'PREV_COMMIT=%s\nPREV_VERSION=%s\nBACKUP_TS=%s\n' "$COMMIT" "$ESPOCRM_VERSION" "$TS" > .deploy-state
  render_site
  step "New code and images"
  [ -d .git ] && [ "$LOCAL" = 0 ] && x git pull --ff-only
  x docker compose pull --ignore-buildable
  x docker compose up -d --build
  wait_healthy
  apply_setup
  if run_checks; then echo; echo "Update finished."; else echo; echo "Checks failed. To go back: sh scripts/deploy.sh rollback"; exit 1; fi
  ;;
rollback)
  [ -f .deploy-state ] || { echo "No .deploy-state: nothing to roll back to (an update has not been run here)." >&2; exit 1; }
  . ./.deploy-state
  echo "Rolls back to: code $PREV_COMMIT, EspoCRM $PREV_VERSION, database/files from backup $BACKUP_TS."
  echo "Everything entered since that backup is LOST."
  confirm "Roll back?" || exit 1
  if [ "$PREV_COMMIT" != none ] && [ -d .git ] && [ "$PREV_COMMIT" != "$(git rev-parse HEAD)" ]; then
    x git checkout --detach "$PREV_COMMIT"
    echo "Code is now at the old version (detached). To move forward again later: git checkout main && sh scripts/deploy.sh update"
  fi
  x sed -i "s/^ESPOCRM_VERSION=.*/ESPOCRM_VERSION=$PREV_VERSION/" .env
  export ESPOCRM_VERSION="$PREV_VERSION"
  x sh scripts/restore.sh "$BACKUP_TS" --yes
  x docker compose up -d --build
  wait_healthy
  run_checks && echo "Rolled back."
  ;;
check)
  run_checks
  ;;
render-site)
  render_site
  ;;
add-employee)
  OLDIFS=$IFS; IFS='|'; set -- $ARGS; IFS=$OLDIFS; shift # first element is empty
  [ $# -eq 4 ] || { echo 'Usage: sh scripts/deploy.sh add-employee <userName> "<First>" "<Last>" <email>' >&2; exit 1; }
  runnode scripts/add-employee.mjs "$@"
  ;;
*)
  sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'
  exit 1
  ;;
esac
