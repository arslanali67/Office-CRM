# Owner guide (one page)

**Dashboard** (home): tasks per employee, overdue tasks, who is checked in, late arrivals, monthly hours, **Needs human** (emails, Instagram/Facebook), campaign results, **AI control**, **Daily reports**. Every morning at 07:30 you also get the **daily summary email**.

**People**: Administration > Users (add staff: role *Employee*, team *Staff*). Two-factor: Preferences > Security. Tasks: assign from the Tasks tab; staff see only theirs.

**Attendance**: tab *Attendance* (filters: Checked in now / Today / Late arrivals), export to Excel/CSV, correct a record by editing it (changes are logged). Office start time, allowed network: settings `attendanceOfficeStart`, `attendanceAllowedIps` (ask the developer to change them).

**Email and messages**
- New emails and DMs are classified by the AI. **Assign** an email or conversation to an employee (field *Assigned user* / *Assigned to*): staff only see what is assigned to them.
- *Knowledge Base* is what the AI is allowed to say (services, prices, hours, policies). **Keep it accurate**: the AI never invents a price that is not there.
- *Auto Reply Rules*: which categories may be answered automatically (per channel). Complaints, refunds/legal, lead replies and "other" always stay with people.
- **AI control** panel: **Pause all AI auto-replies** (emergency, instant), **End draft-only trial** (turn automation on after the first two weeks), **Back to draft-only**.

**Lead campaigns** (about 30 minutes for any number of leads)
1. Prepare a CSV like `samples/leads-template.csv` (email, first_name, last_name, company, industry, city, interest, notes). Import: `node scripts/import-leads.mjs file.csv "Name of list"` (or Import in the menu); you get created / duplicates / invalid rows.
2. *Proposal Briefs* > New: instructions (offer, prices, discount, tone, who signs), choose the target list, word limit.
3. Press **Generate**: the AI writes one email per lead (progress shown). Review the **Leads** list (subject and body are columns; edit in place). **Send test** mails one to yourself. **Regenerate** rewrites everything (your edits are lost).
4. *Campaigns* > Mass Email: template **Lead proposal (AI)**, the target list, the company mailbox as sender, a start time. Sending is throttled (start 50/hour). Unsubscribe link and tracking are automatic.
5. Replies come into the inbox linked to the lead; the AI tags them (interested, not interested, question, out of office). "Interested" creates a task. For follow-ups create **Mass Email 2/3** in the same campaign and put the list **Proposal replies and opt-outs** under *Excluding target lists*.

**Reports**: dashboard panel *Daily reports* (tasks, attendance, messages per channel, first-response time, AI automation rate, campaign totals) and the *Daily Reports* tab for each day. Campaign details are inside each Campaign.

**Safety nets**: AI pause switch (above); set a Campaign to *Inactive* to stop its sending; backups run nightly; the rollback plan is in `docs/GO-LIVE.md`, upgrades in `docs/UPGRADE.md`.
