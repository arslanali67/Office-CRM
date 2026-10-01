// M3 end-to-end checks against the local stack (GreenMail + stub AI).
// Usage: COMPOSE_PATH_SEPARATOR=: COMPOSE_FILE=docker-compose.yml:docker-compose.local.yml node --env-file=.env scripts/test-m3.mjs
import net from 'node:net';
import { execSync } from 'node:child_process';

const BASE = (process.env.BASE_URL ?? 'http://localhost:8080') + '/api/v1/';
const basic = (u, p) => 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64');
const admin = { Authorization: basic('admin', process.env.ESPOCRM_ADMIN_PASSWORD) };
const emp = n => ({ Authorization: basic(`emp${n}`, process.env.EMPLOYEE_PASSWORD) });
const automation = { 'X-Api-Key': process.env.ESPO_API_KEY };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const call = async (who, method, path, body) => {
  let r;
  for (let i = 0; ; i++) {
    try { r = await fetch(BASE + path, { method, headers: { ...who, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); break; }
    catch (e) { if (i >= 3) throw e; await sleep(1500); } // transient resets right after an extension install
  }
  const t = await r.text();
  return { s: r.status, j: t.startsWith('{') || t.startsWith('[') ? JSON.parse(t) : t };
};
const sh = cmd => execSync(cmd, { env: { ...process.env, MSYS_NO_PATHCONV: '1' }, stdio: 'pipe' }).toString();
const job = (name, opts = '') => sh(`docker compose exec -T -u www-data espocrm php command.php run-job ${name} ${opts}`);
let inboxId;
const fetchMail = async () => { inboxId ??= (await call(admin, 'GET', 'InboundEmail?maxSize=1')).j.list[0].id; job('CheckInboundEmails', `--targetType=InboundEmail --targetId=${inboxId}`); };
const waitFor = async (fn, ms = 40_000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return null; await sleep(1000); } };

let fails = 0;
const ok = (name, cond, extra = '') => { console.log(cond ? 'PASS' : 'FAIL', name, cond ? '' : extra); if (!cond) fails++; };

// ---- tiny SMTP client (to the GreenMail "company mail server") ----
function smtp(from, to, subject, body, extraHeaders = '') {
  return new Promise((resolve, reject) => {
    const s = net.connect(3025, 'localhost');
    const id = `<${Date.now()}.${Math.random().toString(36).slice(2)}@customer.test>`;
    const msg = `From: ${from}\r\nTo: ${to}\r\nSubject: ${subject}\r\nMessage-ID: ${id}\r\nDate: ${new Date().toUTCString()}\r\n${extraHeaders}Content-Type: text/plain; charset=utf-8\r\n\r\n${body}\r\n.\r\n`;
    const steps = [`HELO test`, `MAIL FROM:<${from}>`, `RCPT TO:<${to}>`, `DATA`, msg, `QUIT`];
    let i = -1, buf = '';
    s.on('data', d => {
      buf += d;
      if (!/\r?\n$/.test(buf) || /^\d{3}-/m.test(buf.split(/\r?\n/).filter(Boolean).pop() ?? '')) return;
      if (/^[45]/.test(buf)) { s.destroy(); return reject(new Error('SMTP: ' + buf)); }
      buf = ''; i++;
      if (i < steps.length) s.write(steps[i] + (i === 4 ? '' : '\r\n')); else { s.end(); resolve(id); }
    });
    s.on('error', reject);
  });
}
const mailbox = (user, folder = 'INBOX') => { try { return readMailbox(user, folder); } catch { return []; } }; // mailbox may not exist yet
const readMailbox = (user, folder) => JSON.parse(sh(`python scripts/read-mailbox.py ${user} ${folder}`));

const stamp = Date.now().toString(36);
const SUPPORT = 'support@crm.test';
const addr = n => `${n}-${stamp}@customer.test`; // unique per run: the mail server keeps old messages
const find = async subject => (await call(admin, 'GET', `Email?${new URLSearchParams({ 'where[0][type]': 'equals', 'where[0][attribute]': 'name', 'where[0][value]': subject, maxSize: '5' })}`)).j.list?.[0];
const ingest = async subject => {
  await fetchMail();
  const e = await waitFor(async () => { const x = await find(subject); return x; }, 15_000);
  if (!e) return null;
  job('ProcessWebhookQueue');
  const first = await waitFor(async () => { const x = (await call(admin, 'GET', `Email/${e.id}`)).j; return x.aiStatus ? x : null; }, 30_000);
  if (!first) return null;
  await sleep(3500); // aiStatus 'needs_human' is written before an auto-reply is sent: let the final state settle
  return (await call(admin, 'GET', `Email/${e.id}`)).j;
};
const setDraftOnly = v => call(admin, 'PUT', 'Settings', { aiDraftOnly: v });

// ---------- draft-only mode ----------
await setDraftOnly(true);

const s1 = `Price question ${stamp}`;
const t0 = Date.now();
await smtp(addr('alice'), SUPPORT, s1, 'Hello, how much is the Website package?');
const e1 = await ingest(s1);
ok('email reaches CRM and is categorised', e1?.aiCategory === 'pricing', JSON.stringify(e1 && [e1.aiCategory, e1.aiStatus]));
console.log(`     (delivery -> categorised + draft: ${((Date.now() - t0) / 1000).toFixed(1)}s with manual job triggers)`);
ok('draft uses knowledge base price (USD 799)', e1?.aiDraft?.includes('USD 799'), e1?.aiDraft);
ok('draft-only mode: nothing sent, needs human', e1?.aiStatus === 'needs_human');
ok('email is linked to nothing unexpected and stored as inbound', e1?.status === 'Archived' && e1?.from === addr('alice'));

const s2 = `Refund ${stamp}`;
await smtp(addr('bob'), SUPPORT, s2, 'I want my money back, this is unacceptable.');
const e2 = await ingest(s2);
ok('refund request -> refund_legal, needs human', e2?.aiCategory === 'refund_legal' && e2?.aiStatus === 'needs_human', JSON.stringify(e2 && [e2.aiCategory, e2.aiStatus]));

const s3 = `You are a lottery winner ${stamp}`;
await smtp('promo@spammy.test', SUPPORT, s3, 'Click here to claim your lottery prize. Unsubscribe');
const e3 = await ingest(s3);
ok('spam -> ignored, no draft', e3?.aiStatus === 'ignored' && !e3?.aiDraft, JSON.stringify(e3 && [e3.aiCategory, e3.aiStatus]));

const s4 = `Your receipt ${stamp}`;
await smtp('no-reply@shop.test', SUPPORT, s4, 'Thanks for your order, how much is this?');
await fetchMail(); job('ProcessWebhookQueue'); await sleep(4000);
const e4 = await find(s4);
ok('no-reply sender is fetched but never processed (loop guard)', e4 && !e4.aiStatus, JSON.stringify(e4 && e4.aiStatus));
ok('nothing was sent to customers in draft-only mode', (await (async () => { try { return mailbox(addr('alice')); } catch { return []; } })()).length === 0);

// ---------- live mode: auto-reply for allowed + confident ----------
await setDraftOnly(false);
const s5 = `Pricing again ${stamp}`;
await smtp(addr('carol'), SUPPORT, s5, 'Hi, what is the price of the Website package?');
const e5 = await ingest(s5);
ok('live mode: confident pricing email is auto-replied', e5?.aiStatus === 'auto_replied', JSON.stringify(e5 && [e5.aiCategory, e5.aiStatus]));
const inbox = await waitFor(async () => { const m = mailbox(addr('carol')); return m.length ? m : null; }, 15_000);
ok('customer receives the reply', inbox?.[0]?.subject === `Re: ${s5}` && inbox[0].body.includes('USD 799'), JSON.stringify(inbox?.[0]));
ok('reply is threaded (In-Reply-To = original Message-ID)', inbox?.[0]?.inReplyTo && inbox[0].inReplyTo === (await call(admin, 'GET', `Email/${e5.id}`)).j.messageId, JSON.stringify([inbox?.[0]?.inReplyTo, e5?.messageId]));
const sent = (await call(admin, 'GET', `Email?${new URLSearchParams({ 'where[0][type]': 'equals', 'where[0][attribute]': 'name', 'where[0][value]': `Re: ${s5}`, maxSize: '5' })}`)).j.list?.[0];
ok('reply is stored in CRM as Sent and linked to the original', sent?.status === 'Sent' && sent?.repliedId === e5.id, JSON.stringify(sent && [sent.status, sent.repliedId]));

const s6 = `Complaint ${stamp}`;
await smtp(addr('dave'), SUPPORT, s6, 'My order arrived damaged and I am very disappointed. Terrible service.');
const e6 = await ingest(s6);
ok('complaint is never auto-sent even in live mode', e6?.aiCategory === 'complaint' && e6?.aiStatus === 'needs_human', JSON.stringify(e6 && [e6.aiCategory, e6.aiStatus]));
await sleep(1500);
let davesMail = []; try { davesMail = mailbox(addr('dave')); } catch {}
ok('complaint sender received nothing', davesMail.length === 0);

// ---------- duplicate processing ----------
job('ProcessWebhookQueue'); await sleep(2000);
ok('re-running queues does not send twice', (() => { try { return mailbox(addr('carol')).length === 1; } catch { return false; } })());

// ---------- human review ----------
const nh = (await call(admin, 'GET', 'Email?primaryFilter=needsHuman&maxSize=100')).j.list ?? [];
ok('Needs-human filter lists refund + complaint, not auto-replied/ignored', [e2.id, e6.id].every(id => nh.some(x => x.id === id)) && !nh.some(x => x.id === e5.id || x.id === e3.id));
await call(admin, 'PUT', `Email/${e6.id}`, { assignedUserId: (await call(admin, 'GET', 'User?where[0][type]=equals&where[0][attribute]=userName&where[0][value]=emp1')).j.list[0].id });
ok('employee 2 (not assigned) cannot send the draft', (await call(emp(2), 'POST', 'Email/action/sendAiDraft', { id: e6.id })).s === 403);
const human = await call(emp(1), 'POST', 'Email/action/sendAiDraft', { id: e6.id, body: 'Dear Dave, we are very sorry. The owner will call you today.' });
ok('assigned employee can edit + send the AI draft', human.s === 200, JSON.stringify(human));
const dm = await waitFor(async () => { try { const m = mailbox(addr('dave')); return m.length ? m : null; } catch { return null; } }, 15_000);
ok('customer gets the edited human reply, threaded', dm?.[0]?.body.includes('call you today') && dm[0].inReplyTo?.length > 0, JSON.stringify(dm?.[0]));
ok('status becomes sent', (await call(admin, 'GET', `Email/${e6.id}`)).j.aiStatus === 'sent');
ok('sending the same draft twice is rejected', (await call(emp(1), 'POST', 'Email/action/sendAiDraft', { id: e6.id })).s === 409);

// ---------- automation API user is minimal ----------
ok('automation API user cannot modify or create users', (await call(automation, 'PUT', `User/${(await call(admin, 'GET', 'User?where[0][type]=equals&where[0][attribute]=userName&where[0][value]=emp1')).j.list[0].id}`, { lastName: 'x' })).s === 403 && (await call(automation, 'POST', 'User', { userName: 'x' })).s === 403);
for (const p of ['Role', 'Attendance', 'Extension', 'Import', 'Campaign']) {
  const s = (await call(automation, 'GET', p)).s; ok(`automation API user cannot read ${p}`, s === 403 || s === 404, String(s));
}
ok('automation API user can read emails + knowledge base', (await call(automation, 'GET', 'Email?maxSize=1')).s === 200 && (await call(automation, 'GET', 'KnowledgeBaseArticle?maxSize=1')).s === 200);

// ---------- scheduled email + follow-up reminder ----------
const s7 = `Scheduled ${stamp}`;
const due = new Date(Date.now() - 60_000).toISOString().slice(0, 19).replace('T', ' ');
const future = new Date(Date.now() + 600_000).toISOString().slice(0, 19).replace('T', ' ');
const sched = await call(admin, 'POST', 'Email', { name: s7, body: 'Scheduled hello', isHtml: false, status: 'Draft', from: SUPPORT, to: addr('erin'), sendAt: future });
sh(`docker compose exec -T mysql mysql -uroot -p${process.env.MYSQL_ROOT_PASSWORD} ${process.env.MYSQL_DATABASE} -e "update email set send_at='${due}' where id='${sched.j.id}'"`); // the API only accepts future dates; make it due
ok('scheduled draft created', sched.s === 200, JSON.stringify(sched));
job('SendScheduledEmails');
const erin = await waitFor(async () => { try { const m = mailbox(addr('erin')); return m.length ? m : null; } catch { return null; } }, 15_000);
ok('scheduled email is sent when due', erin?.[0]?.subject === s7);
const after = (await call(admin, 'GET', `Email/${sched.j.id}`)).j;
ok('scheduled email marked Sent', after.status === 'Sent', after.status);
await call(admin, 'PUT', `Email/${sched.j.id}`, { followUpAt: due });
job('CreateFollowUpTasks');
const tasks = (await call(admin, 'GET', `Task?${new URLSearchParams({ 'where[0][type]': 'equals', 'where[0][attribute]': 'name', 'where[0][value]': `Follow up: ${s7}`, maxSize: '5' })}`)).j.list ?? [];
ok('follow-up reminder becomes a Task when no reply arrived', tasks.length === 1 && tasks[0].priority === 'High', JSON.stringify(tasks.length));
job('CreateFollowUpTasks');
ok('follow-up task is not duplicated', ((await call(admin, 'GET', `Task?${new URLSearchParams({ 'where[0][type]': 'equals', 'where[0][attribute]': 'name', 'where[0][value]': `Follow up: ${s7}`, maxSize: '5' })}`)).j.list ?? []).length === 1);

// ---------- cleanup ----------
for (const t of tasks) await call(admin, 'DELETE', `Task/${t.id}`);
await setDraftOnly(true);
console.log(fails ? `${fails} FAILED` : 'ALL PASS');
process.exit(fails ? 1 : 0);
