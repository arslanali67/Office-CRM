# Go-live checklist, UAT and rollback

Source of truth for scope is `PROJECT.md`. This file is the practical runbook for week 9.

## 1. Before go-live (staging first, then production)

**Owner provides** (PROJECT.md section 10, "Owner inputs"): DNS access, company card (server + Anthropic), Meta admin access and documents, real business facts for the knowledge base, employee list, real mailbox, first lead CSV and a proposal the company likes.

**Server** (Ubuntu VPS, 4 GB)
- [ ] `docker` + `docker compose` installed; repo cloned; `.env` created from `.env.example` with **real, strong, unique** secrets (never commit it).
- [ ] `sh scripts/harden-server.sh` run as root (firewall 22/80/443, automatic security updates, key-only SSH, fail2ban).
- [ ] DNS: `crm.<domain>` points to the server; SPF, DKIM, DMARC set for the sending domain.
- [ ] `docker compose up -d` (production, without the local override). Caddy gets the HTTPS certificate automatically.
- [ ] `sh scripts/install-extension.sh` then, in this order: `node --env-file=.env scripts/setup-m1.mjs`, `setup-m3`, `setup-m4`, `setup-m5`, `setup-m6`; then `docker compose up -d automation` (loads the generated secrets).
- [ ] `sh scripts/deploy.sh install` does the whole stack/extension/setup/backup/check run below in one go (it refuses to start while `.env` still has placeholders). Add staff with `sh scripts/deploy.sh add-employee ...`; later updates with `deploy.sh update`, undo with `deploy.sh rollback`, health report with `deploy.sh check`. The detailed items below remain the checklist of what it must have achieved.
- [ ] `.env` for production: `ESPOCRM_ADMIN_PASSWORD` strong, `CRM_DOMAIN`, `MAILBOX_*` (real IMAP/SMTP), `AUTOMATION_IP` (fixed private address of the automation container; leave the default) `ATTENDANCE_TRUST_PROXY=true`, `ATTENDANCE_ALLOWED_IPS=<office public IP>`, `ATTENDANCE_OFFICE_START`, `OWNER_EMAIL`, `COMPANY_ADDRESS`, `ANTHROPIC_API_KEY`, `META_APP_SECRET`, `META_PAGE_TOKEN`, `META_VERIFY_TOKEN`, and **leave `AI_MODE` empty** (stub AI is for local testing only).
- [ ] Settings in EspoCRM: company name, logo, time zone, currency, language; system SMTP for notifications.
- [ ] Nightly backup: set `BACKUP_REMOTE` (+ the `RCLONE_CONFIG_OFFSITE_*` values for your storage provider) in `.env`, run `sh scripts/backup.sh` once by hand (it prints "copied to ..." and checks the upload), then `sh scripts/install-cron.sh` (02:15 daily; 14 days kept locally and off-site). **Restore rehearsal** on staging: `RESTORE_DB=restore_check RESTORE_FILES=0 sh scripts/restore.sh <timestamp> --from-remote --yes`.
- [ ] Meta: webhook callback `https://crm.<domain>/webhooks/meta`, the same verify token as `META_VERIFY_TOKEN`, subscribed to `messages` for the Page and the Instagram account. App Review approved (`pages_messaging`, `instagram_manage_messages`, `pages_manage_metadata`, `instagram_basic`).
- [ ] Owner enrols two-factor authentication: Preferences > Security (authenticator app).
- [ ] Staff accounts created (name + email), assigned to team **Staff** with role **Employee**; each logs in once and changes the password.

**Checks** (run on staging, then repeat the short list on production)
- [ ] `node --env-file=.env scripts/test-m1.mjs`, `test-m2`, `test-m3`, `test-m4`, `test-m5`, `test-m6` (the local test servers are replaced by the real ones, so run only the tests that apply, or read them as a checklist).
- [ ] Load test on staging: `node --env-file=.env scripts/load-test.mjs 1000 5000`.
- [ ] A real email to the company mailbox shows up in the CRM within 1-2 minutes with category and draft.
- [ ] A real DM (team account, before App Review) appears within seconds; a reply from the chat panel reaches the phone.
- [ ] Seed test: send the proposal Mass Email to ~20 internal Gmail/Outlook addresses: it must land in the Inbox, not spam.
- [ ] Unsubscribe link works; a replied lead is not in the next follow-up.

**AI accuracy check (plan M3 acceptance)**: `docker compose exec -T automation node src/eval-cli.ts emails - < my-100-emails.csv` must say PASS (>= 90% correct, 0 invented prices, 0 dangerous mistakes). After the first campaign draft: `docker compose exec -T automation node src/eval-cli.ts proposals "<brief name>" 30`, then read the 5 samples it prints. The inputs are listed in `docs/JOINT-TEST-INPUTS.md`.

## 2. AI rollout (M6.1: owner decision)

1. **Weeks 1-2: draft-only** (the default). The AI writes drafts, people send every reply. Watch the "Needs human" lists and the daily summary email.
2. Watch the **edited-draft rate** (Daily reports panel and the daily summary email; target under 10%): if staff keep rewriting a category, keep it human.
3. Decide which categories may be automatic (PDF Appendix B). Open **Auto Reply Rules** and tick *Send automatically* only for those (Inquiry, Pricing, Booking by default; Complaint, Refund/legal, Lead reply and Other are never automatic, whatever the rule says).
4. On the owner dashboard, panel **AI control**: press **End draft-only trial**. Automatic replies are now on for the ticked categories.
5. Anything goes wrong: press **Pause all AI auto-replies**. It takes effect immediately for email and Instagram/Facebook. Messages keep being stored and classified; people answer them.

## 3. User acceptance test (UAT): owner + two employees, 3 days

| Day | Who | What |
|---|---|---|
| 1 | Employees | Check in/out (also try twice and from outside the office network), receive and complete a task, see only their own tasks/leads/conversations |
| 1 | Owner | Assign tasks, check the overdue alert and the dashboards, correct an attendance record, export attendance |
| 2 | Owner + 1 employee | Real emails: read drafts, edit and send; Instagram/Facebook DMs: chat panel, "Use AI draft", the 24-hour message |
| 2 | Owner | Import a real CSV, write a brief, Generate, review/edit, Send test, launch the first Mass Email to a small list |
| 3 | All | Reply as a lead (interested / not interested), follow-up Mass Email, daily summary email, pause/resume AI, everyone logs in on a phone |
Sign-off = owner confirms in writing, no critical bug open, every employee completed a check-in and a task.

## 4. Training (1 hour per employee)
Use `docs/GUIDE-EMPLOYEE.md` (one page): log in, dashboard, check in/out, tasks, replying to email and DMs, leads. 10 minutes demo, 30 minutes hands-on with real test messages, 20 minutes questions. The owner uses `docs/GUIDE-OWNER.md`.

## 5. Rollback plan (CRM keeps working manually)

| Situation | Do this | Effect |
|---|---|---|
| AI says something wrong | Dashboard > AI control > **Pause all AI auto-replies** | Nothing is sent automatically; people reply |
| A campaign misbehaves | Open the Campaign > Status **Inactive** (or set the Mass Email to *Failed*/delete its pending queue) | Sending stops at once |
| Meta problems / token revoked | Set `META_PAGE_TOKEN` empty and `docker compose up -d automation`, or just pause AI | CRM and email keep working; DMs can be answered in the Meta app |
| Automation service broken | `docker compose stop automation` | Emails and DMs still arrive and are visible; no AI drafts; people work manually |
| Bad EspoCRM upgrade | Follow `docs/UPGRADE.md` "Roll back" | Previous version and database restored |
| Server lost | New VPS, `docker compose up`, restore the latest backup (`docs/UPGRADE.md`) | Back within the hour |

## 6. After go-live
- Week 1: check the daily summary email each morning, the "Needs human" lists twice a day.
- Raise the Mass Email limit gradually (Settings, "Max number of emails per hour": 50 > 100 > 200) while the mailbox warms up and bounces stay under 3%.
- Re-check KPIs after 3 months (PDF section 14) using the Daily reports panel.
