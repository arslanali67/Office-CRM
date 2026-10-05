// M6 checks: nightly report numbers, daily summary email, AI pause switch, security settings.
// Usage: COMPOSE_PATH_SEPARATOR=: COMPOSE_FILE=docker-compose.yml:docker-compose.local.yml node --env-file=.env scripts/test-m6.mjs
import { createHmac } from 'node:crypto';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import net from 'node:net';

const BASE = `http://localhost:${process.env.ESPO_PORT ?? 8080}/api/v1/`;
const basic = (u, p) => ({ Authorization: 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64') });
const admin = basic('admin', process.env.ESPOCRM_ADMIN_PASSWORD);
const emp = n => basic(`emp${n}`, process.env.EMPLOYEE_PASSWORD);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const q = o => new URLSearchParams(o).toString();
const sh = cmd => execSync(cmd, { env: { ...process.env, MSYS_NO_PATHCONV: '1' }, stdio: 'pipe', maxBuffer: 64 << 20 }).toString();
const call = async (who, method, path, body) => {
  let r;
  for (let i = 0; ; i++) {
    try { r = await fetch(BASE + path, { method, headers: { ...who, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); break; }
    catch (e) { if (i >= 3) throw e; await sleep(1500); }
  }
  const t = await r.text();
  return { s: r.status, reason: r.headers.get('x-status-reason') ?? '', j: t.startsWith('{') || t.startsWith('[') ? JSON.parse(t) : t };
};
const waitFor = async (fn, ms = 20_000, step = 500) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return null; await sleep(step); } };
let fails = 0;
const ok = (name, cond, extra = '') => { console.log(cond ? 'PASS' : 'FAIL', name, cond ? '' : String(extra).slice(0, 400)); if (!cond) fails++; };
const job = (name, opts = '') => sh(`docker compose exec -T -u www-data espocrm php command.php run-job ${name} ${opts}`);

// ---- helpers: fake Meta DMs (mock Graph API on :4011, automation on :3100) ----
const stamp = Date.now().toString(36);
let seq = 0;
async function dmPost(object, cust, text) {
  const body = { object, entry: [{ id: 'PAGE', messaging: [{ sender: { id: cust }, recipient: { id: 'PAGE' }, timestamp: Date.now(), message: { mid: `m6_${stamp}_${++seq}`, text } }] }] };
  const raw = JSON.stringify(body);
  await fetch(`http://localhost:${process.env.AUTOMATION_PORT ?? 3100}/webhooks/meta`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': 'sha256=' + createHmac('sha256', process.env.META_APP_SECRET).update(raw).digest('hex') }, body: raw });
  return body.entry[0].messaging[0].message.mid;
}
const msgByExt = async ext => (await call(admin, 'GET', `SocialMessage?${q({ 'where[0][type]': 'equals', 'where[0][attribute]': 'externalId', 'where[0][value]': ext, maxSize: '1' })}`)).j.list?.[0];
const settled = async mid => { const m = await waitFor(async () => (await msgByExt(mid))?.aiCategory ? msgByExt(mid) : null, 15_000, 300); await sleep(1500); return m ? msgByExt(mid) : null; };
const mockSent = async () => (await fetch(`http://localhost:${process.env.MOCK_META_PORT ?? 4011}/_sent`)).json();

const runReport = date => JSON.parse(sh(`docker compose exec -T automation node src/reports.ts ${date}`).trim().split('\n').pop());
const getReport = async id => (await call(admin, 'GET', `DailyReport/${id}`)).j;
const tz = (await call(admin, 'GET', 'Settings')).j.timeZone || 'UTC';
const today = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
const yesterday = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date(Date.now() - 24 * 3600e3));
const uid = async n => (await call(admin, 'GET', `User?${q({ 'where[0][type]': 'equals', 'where[0][attribute]': 'userName', 'where[0][value]': `emp${n}` })}`)).j.list[0].id;
const fmt = d => d.toISOString().slice(0, 19).replace('T', ' ');

await call(admin, 'PUT', 'Settings', { aiDraftOnly: false, aiAutoReplyPaused: false });
await fetch(`http://localhost:${process.env.MOCK_META_PORT ?? 4011}/_reset`, { method: 'POST', body: '{}' });

// =============== A. report numbers (deltas around known fixtures) ===============
const before = await getReport(runReport(today).id);
const e1 = await uid(1), e2 = await uid(2);
const now = Date.now();
const mk = async (name, extra) => (await call(admin, 'POST', 'Task', { name, assignedUserId: e1, ...extra })).j;
const tasks = [
  await mk(`open overdue ${stamp}`, { dateEnd: fmt(new Date(now - 2 * 3600e3)) }),
  await mk(`open future ${stamp}`, { dateEnd: fmt(new Date(now + 48 * 3600e3)) }),
  await mk(`done on time ${stamp}`, { dateEnd: fmt(new Date(now + 3600e3)) }),
  await mk(`done late ${stamp}`, { dateEnd: fmt(new Date(now - 3600e3)) }),
];
for (const t of tasks.slice(2)) await call(admin, 'PUT', `Task/${t.id}`, { status: 'Completed' });
const shift = (await call(admin, 'POST', 'Attendance', { assignedUserId: e2, checkIn: fmt(new Date(now - 3 * 3600e3)), checkOut: fmt(new Date(now - 3600e3)), isLate: true })).j;
const auto = await dmPost('page', `psid-${stamp}-auto`, 'What is the price of the Website package?');
const hard = await dmPost('instagram', `psid-${stamp}-hard`, 'My order arrived damaged and I am very disappointed. Terrible service.');
const mAuto = await settled(auto), mHard = await settled(hard);
ok('fixtures: pricing DM auto-replied, complaint DM waits for a human', mAuto?.status === 'auto_replied' && mHard?.status === 'needs_human', JSON.stringify([mAuto?.status, mHard?.status]));

const rec = runReport(today);
const after = await getReport(rec.id);
const d = k => after[k] - before[k];
ok('one report record per day (re-running updates it)', rec.id === (await call(admin, 'GET', `DailyReport?${q({ 'where[0][type]': 'equals', 'where[0][attribute]': 'date', 'where[0][value]': today, maxSize: '5' })}`)).j.list[0].id && (await call(admin, 'GET', `DailyReport?${q({ 'where[0][type]': 'equals', 'where[0][attribute]': 'date', 'where[0][value]': today })}`)).j.list.length === 1);
ok('open tasks +2, overdue +1', d('tasksOpen') === 2 && d('tasksOverdue') === 1, JSON.stringify([before.tasksOpen, after.tasksOpen, before.tasksOverdue, after.tasksOverdue]));
ok('completed +2 (1 on time, 1 late)', d('tasksCompleted') === 2 && d('tasksCompletedOnTime') === 1, JSON.stringify([d('tasksCompleted'), d('tasksCompletedOnTime')]));
ok('attendance hours +2 and late arrivals +1', Math.abs(d('attendanceHours') - 2) < 0.06 && d('lateArrivals') === 1, JSON.stringify([d('attendanceHours'), d('lateArrivals')]));
ok('Facebook +1, Instagram +1 DMs', d('facebookIn') === 1 && d('instagramIn') === 1, JSON.stringify([d('facebookIn'), d('instagramIn')]));
ok('AI: handled +2, auto-replied +1, rate recomputed', d('aiHandled') === 2 && d('aiAutoReplied') === 1 && Math.abs(after.aiAutomationRate - (after.aiAutoReplied / after.aiHandled) * 100) < 0.06, JSON.stringify([d('aiHandled'), d('aiAutoReplied'), after.aiAutomationRate]));
const per = JSON.parse(after.details).perEmployee;
const p1 = per.find(x => x.name === 'Employee 1'), p2 = per.find(x => x.name === 'Employee 2');
ok('per-employee breakdown (tasks for Employee 1, hours for Employee 2)', p1?.overdue >= 1 && p1.completed >= 2 && p2?.hours >= 1.9, JSON.stringify([p1, p2]));
ok('only the owner can open reports', (await call(emp(1), 'GET', 'DailyReport')).s === 403 && (await call(admin, 'GET', 'DailyReport')).s === 200);
const campaignTotals = (await call(admin, 'GET', 'Campaign?maxSize=100&select=sentCount')).j.list.reduce((n, c) => n + (c.sentCount ?? 0), 0);
ok('campaign totals match the Campaign records', after.campaignSent === campaignTotals, JSON.stringify([after.campaignSent, campaignTotals]));

// =============== B. AI pause switch ===============
await call(admin, 'PUT', 'Settings', { aiAutoReplyPaused: true });
const sentBefore = (await mockSent()).length;
const pausedMid = await dmPost('page', `psid-${stamp}-paused`, 'What is the price of the Website package?');
const mPaused = await settled(pausedMid);
ok('paused: a confident pricing DM is NOT sent, it waits for a person', mPaused?.status === 'needs_human' && mPaused.aiDraft && (await mockSent()).length === sentBefore, JSON.stringify([mPaused?.status]));
// email path uses the same switch
const smtp = (from, to, subject, body) => new Promise((resolve, reject) => {
  const s = net.connect(Number(process.env.GREENMAIL_SMTP_PORT ?? 3025), 'localhost');
  const msg = `From: ${from}\r\nTo: ${to}\r\nSubject: ${subject}\r\nMessage-ID: <${Date.now()}.${Math.random().toString(36).slice(2)}@m6.test>\r\nDate: ${new Date().toUTCString()}\r\nContent-Type: text/plain\r\n\r\n${body}\r\n.\r\n`;
  const steps = ['HELO t', `MAIL FROM:<${from}>`, `RCPT TO:<${to}>`, 'DATA', msg, 'QUIT']; let i = -1, buf = '';
  s.on('data', x => { buf += x; if (!/\r?\n$/.test(buf) || /^\d{3}-/m.test(buf.split(/\r?\n/).filter(Boolean).pop() ?? '')) return; buf = ''; i++; if (i < steps.length) s.write(steps[i] + (i === 4 ? '' : '\r\n')); else { s.end(); resolve(); } });
  s.on('error', reject);
});
const subj = `Pause test ${stamp}`;
await smtp(`paused-${stamp}@customer.test`, 'support@crm.test', subj, 'Hello, how much is the Website package?');
const inbox = (await call(admin, 'GET', 'InboundEmail?maxSize=1')).j.list[0];
job('CheckInboundEmails', `--targetType=InboundEmail --targetId=${inbox.id}`); job('ProcessWebhookQueue');
const em = await waitFor(async () => { const r = (await call(admin, 'GET', `Email?${q({ 'where[0][type]': 'equals', 'where[0][attribute]': 'name', 'where[0][value]': subj, maxSize: '1' })}`)).j.list?.[0]; return r?.aiStatus ? r : null; }, 25_000);
ok('paused: a confident pricing EMAIL is not sent either', em?.aiStatus === 'needs_human' && em.aiCategory === 'pricing', JSON.stringify(em && [em.aiStatus, em.aiCategory]));
await call(admin, 'PUT', 'Settings', { aiAutoReplyPaused: false });
const resumedMid = await dmPost('page', `psid-${stamp}-resumed`, 'What is the price of the Website package?');
const mRes = await waitFor(async () => { const m = await msgByExt(resumedMid); return m?.status === 'auto_replied' ? m : null; }, 15_000, 400);
ok('resumed: automatic replies work again', mRes?.status === 'auto_replied');

// =============== C. daily summary email ===============
const yRec = runReport(yesterday);
const owner = (await call(admin, 'GET', 'User?where[0][type]=equals&where[0][attribute]=userName&where[0][value]=admin')).j.list[0];
ok('owner has an email address for the summary', !!owner.emailAddress, owner.emailAddress);
job('SendDailySummary');
const mails = await waitFor(() => { try { const m = JSON.parse(sh(`python scripts/read-mailbox.py ${owner.emailAddress}`)).filter(x => x.subject === `Daily summary ${yesterday}`); return m.length ? m : null; } catch { return null; } }, 15_000, 1000);
ok('the owner receives "Daily summary <yesterday>"', !!mails, `no mail for ${yesterday}`);
ok('it contains the numbers', /TASKS/.test(mails?.[0]?.body) && /Open: \d+, overdue: \d+/.test(mails?.[0]?.body) && /AI answered on its own/.test(mails?.[0]?.body), mails?.[0]?.body);

// =============== D. security settings ===============
const s = (await call(admin, 'GET', 'Settings')).j;
ok('password policy: min 10 chars, letters + digits + both cases', s.passwordStrengthLength === 10 && s.passwordStrengthNumberCount >= 1 && s.passwordStrengthBothCases === true, JSON.stringify([s.passwordStrengthLength, s.passwordStrengthNumberCount, s.passwordStrengthBothCases]));
ok('sessions expire (12 h max, 4 h idle) and failed logins are limited', s.authTokenLifetime === 12 && s.authTokenMaxIdleTime === 4 && sh('docker compose exec -T -u www-data espocrm php command.php config:get authMaxFailedAttemptNumber').trim() === '5', JSON.stringify([s.authTokenLifetime, s.authTokenMaxIdleTime]));
ok('two-factor (TOTP) is available for the owner', s.auth2FA === true && (s.auth2FAMethodList ?? []).includes('Totp'));
const weak = await call(admin, 'POST', 'User', { userName: `weak${stamp}`, lastName: 'Weak', password: 'abc', passwordConfirm: 'abc', type: 'regular' });
ok('a weak password is refused', weak.s >= 400, JSON.stringify(weak.s));
const strong = await call(admin, 'POST', 'User', { userName: `strong${stamp}`, lastName: 'Strong', password: `Str0ng-${stamp}-pw`, passwordConfirm: `Str0ng-${stamp}-pw`, type: 'regular' });
ok('a strong password is accepted', strong.s === 200, JSON.stringify([strong.s, strong.reason]));
if (strong.s === 200) await call(admin, 'DELETE', `User/${strong.j.id}`);

// production compose: only the reverse proxy is reachable from outside
const cfg = JSON.parse(sh('docker compose -f docker-compose.yml config --format json'));
const published = Object.entries(cfg.services).filter(([, v]) => (v.ports ?? []).length).map(([k, v]) => [k, v.ports.map(p => p.published).join(',')]);
ok('production exposes only Caddy on ports 80/443 (no database, no app port)', published.length === 1 && published[0][0] === 'caddy' && published[0][1] === '80,443', JSON.stringify(published));
const caddyfile = readFileSync('Caddyfile', 'utf8');
ok('Caddy sends security headers (HSTS, nosniff, frame protection)', /Strict-Transport-Security/.test(caddyfile) && /X-Content-Type-Options/.test(caddyfile) && /X-Frame-Options|frame-ancestors/.test(caddyfile));

// cleanup
for (const cust of ['auto', 'hard', 'paused', 'resumed']) {
  for (const ch of ['facebook', 'instagram']) {
    const c = (await call(admin, 'GET', `Conversation?${q({ 'where[0][type]': 'equals', 'where[0][attribute]': 'customerId', 'where[0][value]': `psid-${stamp}-${cust}`, 'where[1][type]': 'equals', 'where[1][attribute]': 'channel', 'where[1][value]': ch, maxSize: '1' })}`)).j.list?.[0];
    if (!c) continue;
    for (const m of (await call(admin, 'GET', `Conversation/${c.id}/messages?maxSize=100`)).j.list ?? []) await call(admin, 'DELETE', `SocialMessage/${m.id}`);
    await call(admin, 'DELETE', `Conversation/${c.id}`);
  }
}
for (const t of tasks) await call(admin, 'DELETE', `Task/${t.id}`);
await call(admin, 'DELETE', `Attendance/${shift.id}`);
await call(admin, 'PUT', 'Settings', { aiDraftOnly: true, aiAutoReplyPaused: false });
console.log(fails ? `${fails} FAILED` : 'ALL PASS');
process.exit(fails ? 1 : 0);
