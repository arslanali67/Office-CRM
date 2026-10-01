// Edited-draft ratio (PDF KPI "AI replies corrected by a human") end to end: email Send AI draft + DM chat, then the daily report.
// Usage: COMPOSE_PATH_SEPARATOR=: COMPOSE_FILE=docker-compose.yml:docker-compose.local.yml node --env-file=.env scripts/test-edited.mjs
import { createHmac } from 'node:crypto';
import { execSync } from 'node:child_process';
import net from 'node:net';

const BASE = 'http://localhost:8080/api/v1/';
const admin = { Authorization: 'Basic ' + Buffer.from(`admin:${process.env.ESPOCRM_ADMIN_PASSWORD}`).toString('base64') };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const q = o => new URLSearchParams(o).toString();
const sh = cmd => execSync(cmd, { env: { ...process.env, MSYS_NO_PATHCONV: '1' }, stdio: 'pipe' }).toString();
const call = async (method, path, body) => {
  let r;
  for (let i = 0; ; i++) {
    try { r = await fetch(BASE + path, { method, headers: { ...admin, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); break; }
    catch (e) { if (i >= 3) throw e; await sleep(1500); }
  }
  const t = await r.text();
  return { s: r.status, j: t.startsWith('{') || t.startsWith('[') ? JSON.parse(t) : t };
};
const waitFor = async (fn, ms = 20_000, step = 500) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return null; await sleep(step); } };
let fails = 0;
const ok = (name, cond, extra = '') => { console.log(cond ? 'PASS' : 'FAIL', name, cond ? '' : String(extra).slice(0, 300)); if (!cond) fails++; };
const job = (name, opts = '') => sh(`docker compose exec -T -u www-data espocrm php command.php run-job ${name} ${opts}`);
const stamp = Date.now().toString(36);
let seq = 0;

await call('PUT', 'Settings', { aiDraftOnly: true, aiAutoReplyPaused: false });
const tz = (await call('GET', 'Settings')).j.timeZone || 'UTC';
const today = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
const report = () => { const { id } = JSON.parse(sh(`docker compose exec -T automation node src/reports.ts ${today}`).trim().split('\n').pop()); return call('GET', `DailyReport/${id}`).then(r => r.j); };
const before = await report();

// ---------- email ----------
const smtp = (from, to, subject, body) => new Promise((resolve, reject) => {
  const s = net.connect(3025, 'localhost');
  const msg = `From: ${from}\r\nTo: ${to}\r\nSubject: ${subject}\r\nMessage-ID: <${Date.now()}.${Math.random().toString(36).slice(2)}@ed.test>\r\nDate: ${new Date().toUTCString()}\r\nContent-Type: text/plain\r\n\r\n${body}\r\n.\r\n`;
  const steps = ['HELO t', `MAIL FROM:<${from}>`, `RCPT TO:<${to}>`, 'DATA', msg, 'QUIT']; let i = -1, buf = '';
  s.on('data', x => { buf += x; if (!/\r?\n$/.test(buf) || /^\d{3}-/m.test(buf.split(/\r?\n/).filter(Boolean).pop() ?? '')) return; buf = ''; i++; if (i < steps.length) s.write(steps[i] + (i === 4 ? '' : '\r\n')); else { s.end(); resolve(); } });
  s.on('error', reject);
});
const inbox = (await call('GET', 'InboundEmail?maxSize=1')).j.list[0];
async function ingestEmail(label) {
  const subject = `Edit test ${label} ${stamp}`;
  await smtp(`ed-${label}-${stamp}@customer.test`, 'support@crm.test', subject, 'Hello, how much is the Website package?');
  job('CheckInboundEmails', `--targetType=InboundEmail --targetId=${inbox.id}`); job('ProcessWebhookQueue');
  return waitFor(async () => { const e = (await call('GET', `Email?${q({ 'where[0][type]': 'equals', 'where[0][attribute]': 'name', 'where[0][value]': subject, maxSize: '1' })}`)).j.list?.[0]; return e?.aiStatus ? e : null; }, 30_000);
}
const e1 = await ingestEmail('same'), e2 = await ingestEmail('changed');
ok('the AI keeps its original draft next to the editable one', !!e1?.aiDraftOriginal && e1.aiDraftOriginal === e1.aiDraft, JSON.stringify(e1 && [e1.aiDraftOriginal?.slice(0, 40)]));
const s1 = await call('POST', 'Email/action/sendAiDraft', { id: e1.id, body: e1.aiDraft });
// a person edits the draft in the CRM first: the editable draft changes, the original must not
await call('PUT', `Email/${e2.id}`, { aiDraft: `${e2.aiDraft}\n\nP.S. Happy to call you tomorrow.` });
const e2b = (await call('GET', `Email/${e2.id}`)).j;
const s2 = await call('POST', 'Email/action/sendAiDraft', { id: e2.id, body: e2b.aiDraft });
ok('both emails were sent by a person', s1.s === 200 && s2.s === 200, JSON.stringify([s1.s, s2.s]));
ok('editing the draft does not touch the original', e2b.aiDraftOriginal === e2.aiDraftOriginal && e2b.aiDraft !== e2b.aiDraftOriginal);
const r1 = (await call('GET', `Email/${e1.id}`)).j, r2 = (await call('GET', `Email/${e2.id}`)).j;
ok('sent unchanged (even with different line breaks) = not edited', r1.aiEdited === false && r1.aiStatus === 'sent', JSON.stringify([r1.aiEdited, r1.aiStatus]));
ok('sent changed = edited', r2.aiEdited === true && r2.aiStatus === 'sent', JSON.stringify([r2.aiEdited, r2.aiStatus]));

// ---------- DMs ----------
async function dm(label) {
  const mid = `ed_${stamp}_${++seq}`, cust = `psid-${stamp}-${label}`;
  const body = JSON.stringify({ object: 'page', entry: [{ id: 'PAGE', messaging: [{ sender: { id: cust }, recipient: { id: 'PAGE' }, timestamp: Date.now(), message: { mid, text: 'What is the price of the Website package?' } }] }] });
  await fetch('http://localhost:3100/webhooks/meta', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': 'sha256=' + createHmac('sha256', process.env.META_APP_SECRET).update(body).digest('hex') }, body });
  const m = await waitFor(async () => { const x = (await call('GET', `SocialMessage?${q({ 'where[0][type]': 'equals', 'where[0][attribute]': 'externalId', 'where[0][value]': mid, maxSize: '1' })}`)).j.list?.[0]; return x?.aiCategory ? x : null; }, 15_000, 300);
  return m;
}
const d1 = await dm('a'), d2 = await dm('b'), d3 = await dm('c');
const reply = (m, text, used) => call('POST', 'SocialMessage', { conversationId: m.conversationId, direction: 'out', text, status: 'new', aiDraftUsed: used });
const o1 = (await reply(d1, d1.aiDraft, true)).j, o2 = (await reply(d2, `${d2.aiDraft} See you soon!`, true)).j, o3 = (await reply(d3, 'My own wording, not from the draft.', false)).j;
job('ProcessWebhookQueue');
const done = async o => waitFor(async () => { const x = (await call('GET', `SocialMessage/${o.id}`)).j; return x.status !== 'new' ? x : null; }, 20_000);
const [x1, x2, x3] = [await done(o1), await done(o2), await done(o3)];
ok('DM sent from the draft unchanged = not edited', x1?.status === 'sent' && x1.aiEdited === false, JSON.stringify(x1 && [x1.status, x1.aiEdited]));
ok('DM sent from the draft but changed = edited', x2?.status === 'sent' && x2.aiEdited === true, JSON.stringify(x2 && [x2.status, x2.aiEdited]));
ok('DM written from scratch is not counted as a draft', x3?.status === 'sent' && !x3.aiEdited && !x3.aiDraftUsed);

// ---------- report ----------
const after = await report();
ok('daily report: 4 drafts sent by a person, 2 of them edited', after.draftsUsed - before.draftsUsed === 4 && after.draftsEdited - before.draftsEdited === 2, JSON.stringify([after.draftsUsed - before.draftsUsed, after.draftsEdited - before.draftsEdited]));
ok('daily report: the rate is edited / used', Math.abs(after.editedDraftRate - (after.draftsEdited / after.draftsUsed) * 100) < 0.06, after.editedDraftRate);

// ---------- cleanup ----------
for (const d of [d1, d2, d3]) {
  for (const m of (await call('GET', `Conversation/${d.conversationId}/messages?maxSize=100`)).j.list ?? []) await call('DELETE', `SocialMessage/${m.id}`);
  await call('DELETE', `Conversation/${d.conversationId}`);
}
console.log(fails ? `${fails} FAILED` : 'ALL PASS');
process.exit(fails ? 1 : 0);
