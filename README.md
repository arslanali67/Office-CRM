# Office Automation CRM

EspoCRM + our extension + a small Node automation service. The project plan, scope and progress tracking (`PROJECT.md`, `PROGRESS.md`) are kept privately, outside this repository.

## Layout
- `docker-compose.yml` production stack (only Caddy is public); `docker-compose.local.yml` local override (EspoCRM on :8080, GreenMail test mail server, mock Meta API)
- `espocrm-extension/` EspoCRM extension (entities, hooks, jobs, dashlets); built/installed by `scripts/install-extension.sh`
- `automation/` Node service (TypeScript run directly, no build): email AI, DMs, proposals, nightly reports; `npm test` = `node --test "test/*.test.ts"`
- `scripts/` setup (`setup-m1/m3/m4/m5/m6.mjs`, run in that order), tests (`test-m1..m6.mjs`), `import-leads.mjs`, `load-test.mjs`, `backup.sh`, `harden-server.sh`
- `docs/JOINT-TEST-INPUTS.md` everything the owner must provide for the joint test
- `docs/META-APP-REVIEW.md` Meta App Review kit; `site/` privacy and data-deletion page templates (rendered by `deploy.sh`)
- `docs/` go-live and rollback, upgrade, owner and employee guides; `samples/` sample lead CSV

## Deploy on a server (Ubuntu VPS)
```
sh scripts/harden-server.sh                       # once, as root: firewall, automatic updates, SSH keys only
cp .env.example .env && nano .env                 # real domain, passwords, mailbox, keys (the script refuses placeholders)
sh scripts/deploy.sh install                      # stack + extension + setup + nightly backup + checks
sh scripts/deploy.sh add-employee <user> "<First>" "<Last>" <email>
sh scripts/deploy.sh update                       # later: backup, new code/images, setup, checks
sh scripts/deploy.sh rollback                     # back to before the last update
sh scripts/deploy.sh check                        # PASS / WARN / FAIL report
```
Staging and production are the same commands with different `.env` files. `--local` rehearses on a dev machine, `--dry-run` shows the steps.

## Run locally
```
cp .env.example .env            # then fill in test values (see PROJECT.md)
export COMPOSE_PATH_SEPARATOR=: COMPOSE_FILE=docker-compose.yml:docker-compose.local.yml
docker compose up -d
LOCAL_MAILSERVER=1 sh scripts/install-extension.sh
for s in m1 m3 m4 m5 m6; do node --env-file=.env scripts/setup-$s.mjs; done
docker compose up -d automation  # picks up the generated secrets
node --env-file=.env scripts/test-m1.mjs   # ... test-m6.mjs
```
Open http://localhost:8080 (user `admin`). `AI_MODE=stub` in `.env` uses a keyword stub instead of Claude.

## Windows note
In Git Bash prefix docker commands that pass `/var/...` paths with `MSYS_NO_PATHCONV=1`.
