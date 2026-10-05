// Automatic assignment of new emails and conversations (M3.11 / M5.9).
// Usage: COMPOSE_PATH_SEPARATOR=: COMPOSE_FILE=docker-compose.yml:docker-compose.local.yml node --env-file=.env scripts/test-assign.mjs
import { createHmac } from 'node:crypto';
import { execSync } from 'node:child_process';
import net from 'node:net';

const B = `http://localhost:${process.env.ESPO_PORT ?? 8080}/api/v1/`;
const basic = (u, p) => ({ Authorization: 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64'), 'Content-Type': 'application/json' });
const admin = basic('admin', process.env.ESPOCRM_ADMIN_PASSWORD), e1h = basic('emp1', process.env.EMPLOYEE_PASSWORD), e2h = basic('emp2', process.env.EMPLOYEE_PASSWORD);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const q = o => new URLSearchParams(o).toString();
const sh = cmd => execSync(cmd, { env: { ...process.env, MSYS_NO_PATHCONV: '1' }, stdio: 'pipe' }).toString();
const call = async (h, method, path, body) => {
  let r;
  for (let i = 0; ; i++) { try { r = await fetch(B + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined }); break; } catch (e) { if (i >= 3) throw e; await sleep(1500); } }
  const t = await r.text();
  return { s: r.status, j: t.startsWith('{') || t.startsWith('[') ? JSON.parse(t) : t };
};
const waitFor = async (fn, ms = 15_000, step = 300) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return null; await sleep(step); } };
let fails = 0;
const ok = (name, cond, extra = '') => { console.log(cond ? 'PASS' : 'FAIL', name, cond ? '' : String(extra).slice(0, 300)); if (!cond) fails++; };
const stamp = Date.now().toString(36);
let seq = 0;
const uid = async n => (await call(admin, 'GET', `User?${q({ 'where[0][type]': 'equals', 'where[0][attribute]': 'userName', 'where[0][value]': `emp${n}` })}`)).j.list[0].id;
const [e1, e2] = [await uid(1), await uid(2)];
const settings = v => call(admin, 'PUT', 'Settings', v);
const fmt = d => d.toISOString().slice(0, 19).replace('T', ' ');
const shifts = [];
const checkIn = async id => shifts.push((await call(admin, 'POST', 'Attendance', { assignedUserId: id, checkIn: fmt(new Date(Date.now() - 3600e3)) })).j.id);
const checkOutAll = async () => { for (const id of shifts.splice(0)) await call(admin, 'DELETE', `Attendance/${id}`); };

// Start from a clean slate: nobody has open work, nobody is checked in.
for (const t of ['Email', 'Conversation']) for (const x of (await call(admin, 'GET', `${t}?${q({ 'where[0][type]': t === 'Email' ? 'equals' : 'equals', 'where[0][attribute]': t === 'Email' ? 'aiStatus' : 'status', 'where[0][value]': 'needs_human', select: 'id', maxSize: '200' })}`)).j.list ?? []) await call(admin, 'PUT', `${t}/${x.id}`, t === 'Email' ? { aiStatus: 'sent' } : { status: 'closed' });
for (const a of (await call(admin, 'GET', 'Attendance?primaryFilter=open&maxSize=100')).j.list ?? []) await call(admin, 'PUT', `Attendance/${a.id}`, { checkOut: fmt(new Date()) });
await settings({ aiDraftOnly: true, aiAutoReplyPaused: false, autoAssign: true, autoAssignOnlyCheckedIn: true });

async function dm(text, label) {
  const cust = `psid-${stamp}-${label}-${++seq}`, mid = `as_${stamp}_${seq}`;
  const body = JSON.stringify({ object: 'page', entry: [{ id: 'PAGE', messaging: [{ sender: { id: cust }, recipient: { id: 'PAGE' }, timestamp: Date.now(), message: { mid, text } }] }] });
  await fetch(`http://localhost:${process.env.AUTOMATION_PORT ?? 3100}/webhooks/meta`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': 'sha256=' + createHmac('sha256', process.env.META_APP_SECRET).update(body).digest('hex') }, body });
  const m = await waitFor(async () => { const x = (await call(admin, 'GET', `SocialMessage?${q({ 'where[0][type]': 'equals', 'where[0][attribute]': 'externalId', 'where[0][value]': mid, maxSize: '1' })}`)).j.list?.[0]; return x?.aiCategory ? x : null; });
  await sleep(1200); // assignment follows classification
  return (await call(admin, 'GET', `Conversation/${m.conversationId}`)).j;
}
const PRICE = 'What is the price of the Website package?', COMPLAINT = 'My order arrived damaged and I am very disappointed. Terrible service.';
const convs = [];

// 1. only a checked-in employee gets work
await checkIn(e1);
const c1 = [await dm(PRICE, 'a'), await dm(PRICE, 'b'), await dm(PRICE, 'c')]; convs.push(...c1);
ok('only checked-in employees receive messages (emp1 in, emp2 out)', c1.every(c => c.assignedUserId === e1), c1.map(c => c.assignedUserId));
const ownSees = async h => ((await call(h, 'GET', 'Conversation?maxSize=200')).j.list ?? []).map(c => c.id);
ok('the assignee sees them, the other employee does not', c1.every(async c => true) && (await ownSees(e1h)).includes(c1[0].id) && !(await ownSees(e2h)).includes(c1[0].id));

// 2. complaints stay with the owner
const cc = await dm(COMPLAINT, 'complaint'); convs.push(cc);
ok('a complaint is never handed to an employee', !cc.assignedUserId && cc.status === 'needs_human', JSON.stringify([cc.assignedUserId, cc.status]));

// 3. both in: balanced by open work (emp1 already has 3 waiting)
await checkIn(e2);
const c3 = [await dm(PRICE, 'd'), await dm(PRICE, 'e'), await dm(PRICE, 'f')]; convs.push(...c3);
ok('new work goes to the less busy employee until balanced', c3.filter(c => c.assignedUserId === e2).length === 3, c3.map(c => c.assignedUserId === e2 ? 'emp2' : 'emp1'));
const c3b = [await dm(PRICE, 'g'), await dm(PRICE, 'h')]; convs.push(...c3b);
const load = id => [...c1, ...c3, ...c3b].filter(c => c.assignedUserId === id).length;
ok('afterwards the split stays within one message', Math.abs(load(e1) - load(e2)) <= 1, [load(e1), load(e2)]);

// 4. existing assignee is kept for the same customer
const again = await (async () => { const first = c1[0]; const mid = `as_${stamp}_same`;
  const body = JSON.stringify({ object: 'page', entry: [{ id: 'PAGE', messaging: [{ sender: { id: first.customerId }, recipient: { id: 'PAGE' }, timestamp: Date.now(), message: { mid, text: 'Hello again, one more question: what are your hours?' } }] }] });
  await fetch(`http://localhost:${process.env.AUTOMATION_PORT ?? 3100}/webhooks/meta`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': 'sha256=' + createHmac('sha256', process.env.META_APP_SECRET).update(body).digest('hex') }, body });
  await sleep(4000); return (await call(admin, 'GET', `Conversation/${first.id}`)).j; })();
ok('the same customer keeps talking to the same employee', again.assignedUserId === first(c1).assignedUserId);
function first(a) { return a[0]; }

// 5. setting off / nobody checked in
await settings({ autoAssign: false });
const off = await dm(PRICE, 'off'); convs.push(off);
ok('with automatic assignment off, nothing is assigned', !off.assignedUserId, off.assignedUserId);
await settings({ autoAssign: true });
await checkOutAll();
for (const a of (await call(admin, 'GET', 'Attendance?primaryFilter=open&maxSize=100')).j.list ?? []) await call(admin, 'PUT', `Attendance/${a.id}`, { checkOut: fmt(new Date()) });
const nobody = await dm(PRICE, 'nobody'); convs.push(nobody);
ok('nobody checked in: left for the owner', !nobody.assignedUserId, nobody.assignedUserId);
await settings({ autoAssignOnlyCheckedIn: false });
const anyone = await dm(PRICE, 'anyone'); convs.push(anyone);
ok('"only checked-in" switched off: any employee can get it', [e1, e2].includes(anyone.assignedUserId), anyone.assignedUserId);
await settings({ autoAssignOnlyCheckedIn: true });

// 6. email path
const smtp = (from, subject, body) => new Promise((resolve, reject) => {
  const s = net.connect(Number(process.env.GREENMAIL_SMTP_PORT ?? 3025), 'localhost');
  const msg = `From: ${from}\r\nTo: support@crm.test\r\nSubject: ${subject}\r\nMessage-ID: <${Date.now()}.${Math.random().toString(36).slice(2)}@as.test>\r\nDate: ${new Date().toUTCString()}\r\nContent-Type: text/plain\r\n\r\n${body}\r\n.\r\n`;
  const steps = ['HELO t', `MAIL FROM:<${from}>`, 'RCPT TO:<support@crm.test>', 'DATA', msg, 'QUIT']; let i = -1, buf = '';
  s.on('data', x => { buf += x; if (!/\r?\n$/.test(buf) || /^\d{3}-/m.test(buf.split(/\r?\n/).filter(Boolean).pop() ?? '')) return; buf = ''; i++; if (i < steps.length) s.write(steps[i] + (i === 4 ? '' : '\r\n')); else { s.end(); resolve(); } });
  s.on('error', reject);
});
await checkIn(e2);
const brief = (await call(admin, 'POST', 'ProposalBrief', { name: `Assign brief ${stamp}`, instructions: 'Offer USD 799.', targetListId: (await call(admin, 'POST', 'TargetList', { name: `Assign list ${stamp}` })).j.id, wordLimit: 100 })).j;
const lead = (await call(admin, 'POST', 'Lead', { firstName: 'Lena', lastName: `Reply${stamp}`, emailAddress: `lena-${stamp}@customer.test`, assignedUserId: e1, proposalBriefId: brief.id, aiProposalBody: 'x', aiProposalSubject: 'x' })).j;
await smtp(`mia-${stamp}@customer.test`, `Price ${stamp}`, 'Hello, how much is the Website package?');
await smtp(`refund-${stamp}@customer.test`, `Refund ${stamp}`, 'I want my money back, please refund me today.');
await smtp(`lena-${stamp}@customer.test`, `Re: your proposal ${stamp}`, "Thanks for your proposal, we are interested in your offer. Let's talk.");
const inboxId = (await call(admin, 'GET', 'InboundEmail?maxSize=1')).j.list[0].id;
sh(`docker compose exec -T -u www-data espocrm php command.php run-job CheckInboundEmails --targetType=InboundEmail --targetId=${inboxId}`);
sh('docker compose exec -T -u www-data espocrm php command.php run-job ProcessWebhookQueue');
const mail = async s => (await call(admin, 'GET', `Email?${q({ 'where[0][type]': 'equals', 'where[0][attribute]': 'name', 'where[0][value]': `${s} ${stamp}`, maxSize: '1' })}`)).j.list?.[0];
const emp = await waitFor(async () => { const x = await mail('Price'); return x?.aiStatus ? x : null; }, 40_000, 1000);
await sleep(1500);
const price = await mail('Price'), refund = await mail('Refund'), reply = await waitFor(async () => { const x = await mail('Re: your proposal'); return x?.aiCategory ? x : null; }, 30_000, 1000);
ok('an email is assigned to a checked-in employee', price?.assignedUserId === e2, JSON.stringify(price && [price.assignedUserId, price.aiStatus]));
const mine = await call(e2h, 'GET', `Email/${price.id}`), others = await call(e1h, 'GET', `Email/${price.id}`);
ok('that employee can open it, the other cannot', mine.s === 200 && others.s === 403, [mine.s, others.s]);
ok('a refund email stays with the owner', !refund?.assignedUserId, refund?.assignedUserId);
await settings({ autoAssign: true });
ok("a lead's reply goes to the lead's own owner", reply?.assignedUserId === e1 && reply.aiCategory === 'lead_reply', JSON.stringify(reply && [reply.assignedUserId, reply.aiCategory]));
const notes = (await call(e2h, 'GET', 'Notification?maxSize=20')).j.list ?? [];
console.log(`     (info: assignee notifications seen by the employee: ${notes.length})`);

// cleanup
await checkOutAll();
for (const c of convs) { for (const m of (await call(admin, 'GET', `Conversation/${c.id}/messages?maxSize=100`)).j.list ?? []) await call(admin, 'DELETE', `SocialMessage/${m.id}`); await call(admin, 'DELETE', `Conversation/${c.id}`); }
await call(admin, 'DELETE', `Lead/${lead.id}`); await call(admin, 'DELETE', `ProposalBrief/${brief.id}`);
await settings({ autoAssign: false, autoAssignOnlyCheckedIn: true, aiDraftOnly: true });
console.log(fails ? `${fails} FAILED` : 'ALL PASS');
process.exit(fails ? 1 : 0);
