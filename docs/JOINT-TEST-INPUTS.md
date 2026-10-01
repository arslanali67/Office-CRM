# Joint test: what the owner has to provide

Everything below is something only the owner can get or decide. Nothing here is a secret to send to anyone: values go into the server's `.env` file (you type them yourself), never into chat, email or the git repository. Items are in the order they block the work; **start 1 and 2 today**, they take the longest.

| # | What | Takes | Blocks |
|---|---|---|---|
| 1 | Meta Business Verification | 1-3 weeks | Instagram/Facebook DMs for real customers |
| 2 | Server + domain (DNS) | 1 day | everything real: HTTPS, staging, deliverability |
| 3 | Anthropic API key | 10 minutes | real AI replies, proposals, the accuracy check |
| 4 | Company mailbox | 1 hour | real email in the CRM, proposal campaigns |
| 5 | Business facts for the AI | 2-3 hours | correct answers (the AI only knows what you write) |
| 6 | Staff and office details | 30 minutes | accounts, attendance rules |
| 7 | Company branding | 15 minutes | name, logo, PDF footer, email footer |
| 8 | Backup storage | 20 minutes | off-server backups |

## 1. Meta (Instagram + Facebook)
- Needed: admin access to the **Facebook Page**, the **Instagram Business account** (linked to that Page) and **Meta Business Manager**.
- Do: Business Manager > Settings > Security Center > **Start verification** (company legal name, address, phone, website, a business document such as registration or utility bill).
- Then: create a Meta developer app (type *Business*), add *Messenger* and *Instagram* products, link the Page and the Instagram account. Create a **System User** with a long-lived token and permissions `pages_messaging`, `instagram_manage_messages`, `pages_manage_metadata`, `instagram_basic`.
- Values for `.env` on the server: `META_APP_SECRET` (app dashboard > Settings > Basic), `META_PAGE_TOKEN` (the System User token), `META_VERIFY_TOKEN` (you invent a long random string and type the same one in the Meta webhook settings).
- Webhook callback URL (after the domain works): `https://crm.<your-domain>/webhooks/meta`, subscribe to **messages**.
- Before App Review is approved only people with a role in the app (testers) can message the Page: add 2-3 team members as testers to test early.

## 2. Server and domain
- **Server**: a VPS, Ubuntu 24.04 LTS, 2 vCPU / 4 GB RAM / 40 GB disk (about USD 12-24 a month; Hetzner, DigitalOcean, Vultr, ...). Give me: the server's public IP and SSH access with **key login** (I do not need your provider password).
- **Domain**: DNS access for your company domain. Create an `A` record `crm.<your-domain>` pointing to the server IP.
- **Email deliverability** (for proposal campaigns), on the sending domain:
  - **SPF** (TXT on the domain): `v=spf1 include:<your mail provider's SPF> ~all` (Google Workspace: `include:_spf.google.com`).
  - **DKIM**: generate the key in your mail provider's admin console and publish the TXT it shows.
  - **DMARC** (TXT on `_dmarc`): `v=DMARC1; p=none; rua=mailto:<owner email>` to start, tighten later.
- Values for `.env`: `CRM_DOMAIN=crm.<your-domain>`.

## 3. Anthropic (Claude)
- Create an account at console.anthropic.com with the company card, then **set a monthly spend limit** (Settings > Limits; USD 50 is plenty to start).
- Create an API key. Value for `.env`: `ANTHROPIC_API_KEY=...` (leave `AI_MODE` empty).
- Expected cost: about USD 20-50 a month at launch (PDF section 12).

## 4. Company mailbox (shared inbox + sending)
- A dedicated address such as `support@<your-domain>` (not a personal inbox).
- Google Workspace: enable 2-step verification on that account, then create an **App password** (Google Account > Security > App passwords). Other providers: the normal password or app password.
- Values for `.env`:
  `MAILBOX_ADDRESS`, `MAILBOX_USER` (usually the full address), `MAILBOX_PASSWORD`,
  `MAILBOX_IMAP_HOST` (Gmail: `imap.gmail.com`), `MAILBOX_IMAP_PORT=993`, `MAILBOX_IMAP_SECURITY=SSL`,
  `MAILBOX_SMTP_HOST` (Gmail: `smtp.gmail.com`), `MAILBOX_SMTP_PORT=465`, `MAILBOX_SMTP_SECURITY=SSL`, `MAILBOX_SMTP_AUTH=true`, `MAILBOX_FROM_NAME="Your Company"`.
- Note: a brand-new mailbox needs 2-4 weeks of gradual warm-up before large campaigns (the CRM starts at 50 emails/hour).
- For bounce handling, a second mailbox `bounces@<your-domain>` (optional, can be added later).

## 5. Business facts for the AI (the Knowledge Base)
The AI may only use facts you write. Fill this once; I load it, or you type it into the Knowledge Base tab. One short paragraph per topic is enough. **Prices must be written exactly, with currency**, because any price the AI says that is not in the Knowledge Base is blocked.

| Topic | Write down |
|---|---|
| Services | each service in 1-2 sentences, who it is for |
| Prices | each package/service, exact price and currency, what is included, delivery time, discounts |
| Hours and contact | opening hours, time zone, phone, address, holidays |
| Booking | how to book a call/appointment, what you need from the customer, how long it takes |
| Policies | refunds, cancellation, payment, warranty (the AI never promises these: it hands them to a person) |
| Top 30 questions | the 30 questions customers ask most, with your answers |
| Tone | formal or friendly, languages you reply in, how to sign |
| Escalation | which messages must always go to the owner |

**For the accuracy check** (PDF target: 90% of 100 real emails categorised correctly, zero invented prices): export 100 real past emails into a CSV with columns `subject,body,expected_category` where the category is one of `inquiry, pricing, booking, complaint, refund_legal, lead_reply, spam, other` (template: `samples/eval-emails.csv`). Remove names, phone numbers and card details first. Keep this file out of git.

**For the first campaign**: a CSV of leads (`samples/leads-template.csv`: email, first_name, last_name, company, industry, city, interest, notes), the offer and price you want to send, a sample proposal email you like, and your confirmation that the contacts are legitimately obtained business contacts.

## 6. Staff and office
- **Employees**: name, work email, and which of them handle emails/DMs/leads (CSV: `userName,first name,last name,email`). I create them with `sh scripts/deploy.sh add-employee ...`; each gets a one-time password.
- **Owner**: your work email (`OWNER_EMAIL`, receives the daily summary at 07:30).
- **Attendance**: the office's **public IP** (ask the ISP for a static one; check with "what is my IP" from the office network) for `ATTENDANCE_ALLOWED_IPS`, the **start time** for the "late" flag (`ATTENDANCE_OFFICE_START`, for example `09:00`), and the **time zone**, currency and language of the company.
- **Tell staff in advance** that their network address is recorded at check-in and check-out.
- **Auto-reply decision** (can wait until the end of the draft-only trial, week 2-3): which categories may be answered without a person.
- Two employees + yourself for the 3-day user acceptance test.

## 7. Branding
- Company name, postal address (appears in every campaign email footer and the proposal PDF), logo file (PNG/SVG, at least 300 px wide), brand colour (optional).
- Values for `.env`: `COMPANY_NAME`, `COMPANY_ADDRESS`.

## 8. Backup storage
- Any S3-compatible bucket (Backblaze B2, Wasabi, AWS S3, ...) or Google Drive/SFTP. A **separate account or key used only for backups**, with permission to write and list only.
- Values for `.env`: `BACKUP_REMOTE` and the `RCLONE_CONFIG_OFFSITE_*` lines shown as a comment in `.env.example`.

## When you have these
1. Fill the real values into `.env` on the server (copy `.env.example`); do not send them to anyone.
2. `sh scripts/harden-server.sh` (once), then `sh scripts/deploy.sh install`. It refuses to start while any required value is missing or still a placeholder, and ends with a PASS/WARN/FAIL report.
3. Run the accuracy check: `docker compose exec -T automation node src/eval-cli.ts emails - < my-100-emails.csv`.
4. Follow `docs/GO-LIVE.md` (UAT, training, the AI draft-only trial, rollback plan).
