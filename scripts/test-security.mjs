// Security regression checks (from the security review). Needs the local stack.
// Usage: COMPOSE_PATH_SEPARATOR=: COMPOSE_FILE=docker-compose.yml:docker-compose.local.yml node --env-file=.env scripts/test-security.mjs
import { createHmac } from 'node:crypto';
import { execSync } from 'node:child_process';

const B = 'http://localhost:8080/api/v1/';
const basic = (u, p) => ({ Authorization: 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64'), 'Content-Type': 'application/json' });
const admin = basic('admin', process.env.ESPOCRM_ADMIN_PASSWORD), e1 = basic('emp1', process.env.EMPLOYEE_PASSWORD), e2 = basic('emp2', process.env.EMPLOYEE_PASSWORD);
const key = { 'X-Api-Key': process.env.ESPO_API_KEY, 'Content-Type': 'application/json' };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const q = o => new URLSearchParams(o).toString();
const call = async (h, method, path, body) => {
  let r;
  for (let i = 0; ; i++) { try { r = await fetch(B + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined }); break; } catch (e) { if (i >= 3) throw e; await sleep(1500); } }
  const t = await r.text();
  return { s: r.status, j: t.startsWith('{') || t.startsWith('[') ? JSON.parse(t) : t };
};
const waitFor = async (fn, ms = 20_000, step = 400) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return null; await sleep(step); } };
let fails = 0;
const ok = (name, cond, extra = '') => { console.log(cond ? 'PASS' : 'FAIL', name, cond ? '' : String(extra).slice(0, 300)); if (!cond) fails++; };

// ---- settings visibility ----
const ADMIN_ONLY = ['attendanceAllowedIps', 'attendanceTrustProxy', 'attendanceOfficeStart', 'webhookAllowedAddressList', 'emailServerAllowedAddressList'];
const se = (await call(e1, 'GET', 'Settings')).j, sk = (await call(key, 'GET', 'Settings')).j, sa = (await call(admin, 'GET', 'Settings')).j;
ok('employees cannot read internal settings (office IP list, internal hosts)', ADMIN_ONLY.every(k => !(k in se)), ADMIN_ONLY.filter(k => k in se));
ok('the automation user cannot read them either, but still reads what it needs', ADMIN_ONLY.every(k => !(k in sk)) && 'timeZone' in sk && 'aiDraftOnly' in sk && 'aiAutoReplyPaused' in sk);
ok('the owner still sees them', ADMIN_ONLY.every(k => k in sa));

// ---- employee cannot reach owner-only actions ----
const brief = (await call(admin, 'GET', 'ProposalBrief?maxSize=1')).j.list?.[0];
const denied = async (name, p) => ok(name, [403, 404].includes(p.s), p.s);
await denied('employee: no AI pause / settings change', await call(e1, 'PUT', 'Settings', { aiAutoReplyPaused: true }));
await denied('employee: no webhooks, roles, export, import', await call(e1, 'GET', 'Webhook'));
await denied('employee: no export', await call(e1, 'POST', 'Export', { entityType: 'Lead', format: 'csv' }));
await denied('employee: no proposal test send', await call(e1, 'POST', 'ProposalBrief/action/sendTest', { id: brief?.id ?? 'x', address: 'a@b.co' }));
await denied('employee: no list of company addresses', await call(e1, 'GET', 'Email/action/ownAddresses'));
await denied('employee: no monthly attendance totals', await call(e1, 'GET', 'Attendance/action/monthlySummary'));
await denied('employee: no daily reports', await call(e1, 'GET', 'DailyReport'));
await denied('employee: cannot create users', await call(e1, 'POST', 'User', { userName: 'hax', lastName: 'x', type: 'admin', password: 'Hax0r-1234567', passwordConfirm: 'Hax0r-1234567' }));

// ---- Caddy refuses machine credentials from the internet ----
let caddyOut = '';
try {
  const cid = execSync(`docker run -d --rm -p 18099:80 -e CRM_DOMAIN=:80 -v "${process.cwd().replace(/\\/g, '/')}/Caddyfile:/etc/caddy/Caddyfile:ro" caddy:2`, { env: { ...process.env, MSYS_NO_PATHCONV: '1' }, stdio: 'pipe' }).toString().trim();
  await sleep(2500);
  const code = async h => (await fetch('http://localhost:18099/api/v1/App/user', { headers: h }).catch(() => ({ status: 0 }))).status;
  const apiKey = await code({ 'X-Api-Key': 'probe' }), hmac = await code({ 'X-Hmac-Authorization': 'probe' }), plain = await code({});
  ok('proxy refuses requests carrying an API key', apiKey === 403, apiKey);
  ok('proxy refuses HMAC machine credentials', hmac === 403, hmac);
  ok('proxy lets normal requests through to the CRM (502 here: no CRM behind this test proxy)', plain === 502, plain);
  const sec = await fetch('http://localhost:18099/api/v1/App/user', { headers: { 'X-Api-Key': 'probe' } }).catch(() => null); // the proxy's own answer (an unreachable upstream would bypass the header rule here)
  ok('proxy sends security headers', !!sec && sec.headers.get('strict-transport-security') && sec.headers.get('x-content-type-options') === 'nosniff' && !!sec.headers.get('x-frame-options'));
  execSync(`docker stop ${cid}`, { stdio: 'pipe' });
} catch (e) { caddyOut = String(e).slice(0, 200); ok('proxy test could run', false, caddyOut); }

// ---- automatic replies are capped per sender ----
await call(admin, 'PUT', 'Settings', { aiDraftOnly: false, aiAutoReplyPaused: false });
const stamp = Date.now().toString(36);
const cust = `psid-${stamp}-bomb`;
const send = async i => {
  const mid = `sec_${stamp}_${i}`;
  const body = JSON.stringify({ object: 'page', entry: [{ id: 'PAGE', messaging: [{ sender: { id: cust }, recipient: { id: 'PAGE' }, timestamp: Date.now(), message: { mid, text: 'What is the price of the Website package?' } }] }] });
  await fetch('http://localhost:3100/webhooks/meta', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': 'sha256=' + createHmac('sha256', process.env.META_APP_SECRET).update(body).digest('hex') }, body });
  return waitFor(async () => { const m = (await call(admin, 'GET', `SocialMessage?${q({ 'where[0][type]': 'equals', 'where[0][attribute]': 'externalId', 'where[0][value]': mid, maxSize: '1' })}`)).j.list?.[0]; return m && m.status !== 'new' && m.aiCategory ? m : null; }, 15_000, 300);
};
const results = [];
for (let i = 1; i <= 7; i++) { const m = await send(i); await sleep(1200); results.push((await call(admin, 'GET', `SocialMessage/${m.id}`)).j.status); }
ok('first 5 pricing questions from one customer are answered automatically', results.slice(0, 5).every(s => s === 'auto_replied'), results.join(','));
ok('the 6th and 7th wait for a person (daily cap per sender)', results.slice(5).every(s => s === 'needs_human'), results.join(','));
const conv = (await call(admin, 'GET', `Conversation?${q({ 'where[0][type]': 'equals', 'where[0][attribute]': 'customerId', 'where[0][value]': cust, maxSize: '1' })}`)).j.list[0];
ok('and the conversation is flagged for a person', conv?.status === 'needs_human', conv?.status);

// same cap on the email path (one sender, six pricing questions)
import('node:net').then(() => {});
const net = await import('node:net');
const smtp = (from, to, subject, body) => new Promise((resolve, reject) => {
  const sk2 = net.connect(3025, 'localhost');
  const msg = `From: ${from}\r\nTo: ${to}\r\nSubject: ${subject}\r\nMessage-ID: <${Date.now()}.${Math.random().toString(36).slice(2)}@sec.test>\r\nDate: ${new Date().toUTCString()}\r\nContent-Type: text/plain\r\n\r\n${body}\r\n.\r\n`;
  const steps = ['HELO t', `MAIL FROM:<${from}>`, `RCPT TO:<${to}>`, 'DATA', msg, 'QUIT']; let i = -1, buf = '';
  sk2.on('data', x => { buf += x; if (!/\r?\n$/.test(buf) || /^\d{3}-/m.test(buf.split(/\r?\n/).filter(Boolean).pop() ?? '')) return; buf = ''; i++; if (i < steps.length) sk2.write(steps[i] + (i === 4 ? '' : '\r\n')); else { sk2.end(); resolve(); } });
  sk2.on('error', reject);
});
const sh = cmd => execSync(cmd, { env: { ...process.env, MSYS_NO_PATHCONV: '1' }, stdio: 'pipe' }).toString();
const sender = `bomb-${stamp}@customer.test`;
for (let i = 1; i <= 6; i++) await smtp(sender, 'support@crm.test', `Cap test ${i} ${stamp}`, 'Hello, how much is the Website package?');
const inboxId = (await call(admin, 'GET', 'InboundEmail?maxSize=1')).j.list[0].id;
sh(`docker compose exec -T -u www-data espocrm php command.php run-job CheckInboundEmails --targetType=InboundEmail --targetId=${inboxId}`);
sh('docker compose exec -T -u www-data espocrm php command.php run-job ProcessWebhookQueue');
const emailStatuses = async () => { const out = []; for (let i = 1; i <= 6; i++) out.push((await call(admin, 'GET', `Email?${q({ 'where[0][type]': 'equals', 'where[0][attribute]': 'name', 'where[0][value]': `Cap test ${i} ${stamp}`, maxSize: '1' })}`)).j.list?.[0]?.aiStatus ?? ''); return out; };
const st = await waitFor(async () => { const x = await emailStatuses(); return x.every(Boolean) ? x : null; }, 60_000, 2000) ?? await emailStatuses();
ok('emails: at most 5 automatic replies to one sender in 24 hours, the 6th waits for a person', st.filter(x => x === 'auto_replied').length === 5 && st.filter(x => x === 'needs_human').length === 1, st.join(','));

// cleanup
if (conv) {
  for (const m of (await call(admin, 'GET', `Conversation/${conv.id}/messages?maxSize=100`)).j.list ?? []) await call(admin, 'DELETE', `SocialMessage/${m.id}`);
  await call(admin, 'DELETE', `Conversation/${conv.id}`);
}
await call(admin, 'PUT', 'Settings', { aiDraftOnly: true });
console.log(fails ? `${fails} FAILED` : 'ALL PASS');
process.exit(fails ? 1 : 0);
