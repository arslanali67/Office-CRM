# Security review (2026-10-01) and how the system is protected

Scope: the extension, the automation service, the Docker/Caddy configuration, the scripts. Method: read the code against a threat list, then **probe the running system** for each claim instead of trusting the design. Every fix below has a regression check in `scripts/test-security.mjs`, `scripts/test-pdf.mjs` or the unit tests.

## Findings fixed

| # | Severity | What was wrong | Fix | Checked by |
|---|---|---|---|---|
| 1 | High | **The API user's "IP restriction" did not exist.** The field I wrote to does not exist in EspoCRM (silently ignored) and docs claimed otherwise. A stolen API key would have worked from anywhere. | Caddy now refuses every request carrying `X-Api-Key` / `X-Hmac-Authorization` from the internet (the automation service talks to EspoCRM inside the Docker network, not through Caddy). `deploy.sh check` probes this on the real server. Docs corrected. | test-security (proxy), deploy check |
| 2 | High | **HTML injection into the proposal PDF.** The PDF template printed the AI-written proposal unescaped; text from a lead's notes could become HTML (headings, images, remote resources) in a PDF sent under the company's name. | The body is escaped in PHP and passed as a safe variable; the service refuses to run if the template ever prints the raw field again. | test-pdf |
| 3 | Medium | **Employees could read internal settings** (office IP allow-list, proxy trust flag, internal host lists) through the Settings API. | Marked admin-only; the automation user still reads the few settings it needs. | test-security |
| 4 | Medium | **Prompt injection could put an attacker's link, email address or phone number into an automatic reply or proposal.** | Any link, address or phone number in an AI reply or proposal must already exist in the knowledge base (or the brief), otherwise a person reviews it (same rule as the invented-price guard). | unit tests |
| 5 | Medium | **Mail-bomb / robot ping-pong**: unlimited automatic replies to one sender (cost, sender reputation). | At most 5 automatic replies per sender (per conversation for DMs) in 24 hours, then a person (`AUTO_REPLY_DAILY_CAP`). | test-security, unit tests |
| 6 | Low | Sender names could carry markup into confirmation dialogs. | Escaped before display. | review |
| 7 | Low | Server script could lock the owner out (SSH passwords off with no key installed). | `harden-server.sh` refuses unless an SSH key exists. | review |
| 8 | Low | `.env` (all secrets) not forced to owner-only; temp env files could outlive an aborted run. | `deploy.sh` sets `chmod 600 .env` and always removes its temp file; restore validates the database name; backup tool image pinned. | review |
| 9 | Low | The public Meta webhook accepted any body size; a crash in a request handler could stop the service. | 1 MB limit at Caddy; handler errors are caught and logged. | review |
| 10 | Low | Automation container had more rights than needed. | Read-only filesystem, no Linux capabilities, no privilege escalation, non-root. | runtime check |

## What was verified as already sound
- Employees cannot: read others' tasks/emails/conversations/leads, use manager-only actions (AI pause, settings, export, webhooks, reports, proposal test send, user creation), or send a lead's PDF for a lead that is not theirs. (test-security, test-m1, test-m3, test-m5)
- Meta and EspoCRM webhooks: signature checked in constant time over the raw body; each EspoCRM webhook has its own secret; Meta retries cannot create duplicates; echoes of our own messages are ignored.
- Auto-reply safety layers stack: draft-only trial, emergency pause, per-category rules, "complaint / refund / legal / lead reply / other are never automatic", confidence, invented-price guard, contact-detail guard, daily cap, loop guards (no-reply senders, auto-replies, own addresses).
- Only Caddy publishes ports in production (database, CRM, automation have none); HTTPS + HSTS; security headers; password policy, session expiry, login lock-out, optional 2FA.
- No secrets in the repository (scanned); `.env`, backups and local state are git-ignored.

## Residual risks (known, accepted or for the owner)
- **A model can still write something wrong that passes the guards** (for example an unwanted promise such as "we guarantee a refund"). That is why the first two weeks are draft-only and complaints/refunds never go automatic. Review the edited-draft rate and the daily summary.
- **Forged "From" addresses**: an attacker can email the company pretending to be someone else; an automatic reply then goes to that third party. Capped and mostly limited to pricing/inquiry/booking; enable DMARC on your own domain, keep auto-send to the categories you really need.
- **Anyone with an employee login can see the leads and conversations assigned to them**: use strong passwords, enrol 2FA for the owner, remove accounts of people who leave (Administration > Users > deactivate).
- **EspoCRM CSV export** is owner-only, but spreadsheet programs run formulas in cells beginning with `=`/`+`/`-`/`@`: open exports in "text" mode or sanitise before sharing.
- **The server itself** is as secure as its patching: automatic security updates are on, but reboot when asked (`/var/run/reboot-required`) and update the containers monthly (`docs/UPGRADE.md`).
- **Not tested against the real services**: real Meta payloads, real Claude output, real TLS. Re-run `scripts/test-security.mjs` and `deploy.sh check` on staging.

## Reporting a problem
Tell the owner immediately; if a customer message or credential may have leaked: pause AI auto-replies (dashboard > AI control), rotate the affected key (`.env`), `docker compose up -d`, and note what happened.
