// M5 end-to-end checks: signed Meta webhooks -> EspoCRM conversations, AI, human replies, 24h window, contact linking.
// Needs the local stack (mock Meta Graph API on :4011, automation on :3100).
// Usage: COMPOSE_PATH_SEPARATOR=: COMPOSE_FILE=docker-compose.yml:docker-compose.local.yml node --env-file=.env scripts/test-m5.mjs
import { createHmac } from 'node:crypto';
import { execSync } from 'node:child_process';

const BASE = 'http://localhost:8080/api/v1/';
const AUTOMATION = 'http://localhost:3100';
const MOCK = 'http://localhost:4011';
const basic = (u, p) => ({ Authorization: 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64') });
const admin = basic('admin', process.env.ESPOCRM_ADMIN_PASSWORD);
const emp = n => basic(`emp${n}`, process.env.EMPLOYEE_PASSWORD);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const q = o => new URLSearchParams(o).toString();
const sh = cmd => execSync(cmd, { env: { ...process.env, MSYS_NO_PATHCONV: '1' }, stdio: 'pipe' }).toString();
const call = async (who, method, path, body) => {
  let r;
  for (let i = 0; ; i++) {
    try { r = await fetch(BASE + path, { method, headers: { ...who, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); break; }
    catch (e) { if (i >= 3) throw e; await sleep(1500); }
  }
  const t = await r.text();
  return { s: r.status, reason: r.headers.get('x-status-reason') ?? '', j: t.startsWith('{') || t.startsWith('[') ? JSON.parse(t) : t };
};
const waitFor = async (fn, ms = 20_000, step = 400) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return null; await sleep(step); } };
const webhooks = () => sh('docker compose exec -T -u www-data espocrm php command.php run-job ProcessWebhookQueue');
let fails = 0;
const ok = (name, cond, extra = '') => { console.log(cond ? 'PASS' : 'FAIL', name, cond ? '' : String(extra).slice(0, 400)); if (!cond) fails++; };

// ---- fake Meta ----
const sign = raw => 'sha256=' + createHmac('sha256', process.env.META_APP_SECRET).update(raw).digest('hex');
async function metaPost(payload, signature) {
  const raw = JSON.stringify(payload);
  const r = await fetch(`${AUTOMATION}/webhooks/meta`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(signature === null ? {} : { 'X-Hub-Signature-256': signature ?? sign(raw) }) }, body: raw });
  return r.status;
}
const stamp = Date.now().toString(36);
let seq = 0;
const mid = () => `m_${stamp}_${++seq}`;
const dm = (cust, text, extra = {}, m = mid()) => ({ sender: { id: cust }, recipient: { id: 'PAGE' }, timestamp: Date.now(), message: { mid: m, text, ...extra } });
const page = (...events) => ({ object: 'page', entry: [{ id: 'PAGE', time: Date.now(), messaging: events }] });
const insta = (...events) => ({ object: 'instagram', entry: [{ id: 'IGID', time: Date.now(), messaging: events }] });
const profile = (id, name) => fetch(`${MOCK}/_profile`, { method: 'POST', body: JSON.stringify({ id, name }) });
const sent = async () => (await fetch(`${MOCK}/_sent`)).json();
const msgByExt = async ext => (await call(admin, 'GET', `SocialMessage?${q({ 'where[0][type]': 'equals', 'where[0][attribute]': 'externalId', 'where[0][value]': ext, maxSize: '5' })}`)).j.list ?? [];
const conv = async (channel, cust) => (await call(admin, 'GET', `Conversation?${q({ 'where[0][type]': 'equals', 'where[0][attribute]': 'channel', 'where[0][value]': channel, 'where[1][type]': 'equals', 'where[1][attribute]': 'customerId', 'where[1][value]': cust, maxSize: '5' })}`)).j.list ?? [];
const setDraftOnly = v => call(admin, 'PUT', 'Settings', { aiDraftOnly: v });
const userId = async n => (await call(admin, 'GET', `User?${q({ 'where[0][type]': 'equals', 'where[0][attribute]': 'userName', 'where[0][value]': `emp${n}` })}`)).j.list[0].id;
const created = { contacts: [], convs: [] };

await fetch(`${MOCK}/_reset`, { method: 'POST', body: '{}' });
await setDraftOnly(true);
const A = `psid-${stamp}-alice`, B = `psid-${stamp}-bob`, C = `psid-${stamp}-carl`, D = `psid-${stamp}-dana`, E = `psid-${stamp}-erin`, F = `fail-${stamp}`, G = `noprofile-${stamp}`, H = `psid-${stamp}-hana`;
await profile(A, `Alice Mock${stamp}`); await profile(B, `Bob Mock${stamp}`); await profile(C, `Carl Mock${stamp}`);
await profile(F, `Fay Mock${stamp}`); await profile(H, `Hana Mock${stamp}`);

// =============== webhook handshake + signature ===============
const hs = await fetch(`${AUTOMATION}/webhooks/meta?hub.mode=subscribe&hub.verify_token=${process.env.META_VERIFY_TOKEN}&hub.challenge=chal-${stamp}`);
ok('Meta handshake echoes the challenge', hs.status === 200 && (await hs.text()) === `chal-${stamp}`);
ok('handshake with a wrong token is refused', (await fetch(`${AUTOMATION}/webhooks/meta?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=x`)).status === 403);
const forgedMid = mid();
ok('forged signature -> 401', (await metaPost(page(dm(A, 'hacked', {}, forgedMid)), 'sha256=' + '0'.repeat(64))) === 401);
ok('missing signature -> 401', (await metaPost(page(dm(A, 'hacked', {}, forgedMid)), null)) === 401);
await sleep(1500);
ok('forged deliveries create nothing', (await msgByExt(forgedMid)).length === 0 && (await conv('facebook', A)).length === 0);

// =============== Facebook DM arrives (draft-only mode) ===============
const m1 = mid();
const t0 = Date.now();
ok('valid signed delivery is acknowledged immediately', (await metaPost(page(dm(A, 'Hello, how much is the Website package?', {}, m1)))) === 200);
const in1 = await waitFor(async () => (await msgByExt(m1))[0]?.aiCategory ? (await msgByExt(m1))[0] : null, 15_000, 200);
const took = Date.now() - t0;
console.log(`     (DM posted -> visible with category + draft in EspoCRM: ${(took / 1000).toFixed(1)}s)`);
ok('DM appears in EspoCRM within 5 seconds', !!in1 && took < 5000, took);
const cA = (await conv('facebook', A))[0]; created.convs.push(cA?.id);
ok('one conversation per customer per channel, with Graph name + channel', cA?.customerName === `Alice Mock${stamp}` && cA.channel === 'facebook', JSON.stringify(cA && [cA.customerName, cA.channel]));
ok('message stored: incoming, unique Meta id, AI category + knowledge-base draft', in1.direction === 'in' && in1.externalId === m1 && in1.aiCategory === 'pricing' && /USD 799/.test(in1.aiDraft), JSON.stringify(in1 && [in1.direction, in1.aiCategory, in1.aiDraft]));
ok('draft-only mode: waits for a human, nothing sent to the customer', in1.status === 'needs_human' && cA.status === 'needs_human' && (await sent()).length === 0, JSON.stringify([in1.status, cA.status]));
const w = Date.parse(cA.windowExpiresAt.replace(' ', 'T') + 'Z'), lastMsg = Date.parse(cA.lastMessageAt.replace(' ', 'T') + 'Z');
ok('24-hour reply window = last customer message + 24h', Math.abs(w - lastMsg - 24 * 3600e3) < 2000, JSON.stringify([cA.lastMessageAt, cA.windowExpiresAt]));

// =============== duplicates, echoes, other events ===============
const payload1 = page(dm(A, 'Hello, how much is the Website package?', {}, m1));
await Promise.all([1, 2, 3, 4, 5].map(() => metaPost(payload1)));
await sleep(2500);
ok('Meta retries (5 parallel copies) never create a duplicate', (await msgByExt(m1)).length === 1 && (await conv('facebook', A)).length === 1);
const echoMid = mid();
await metaPost(page({ sender: { id: 'PAGE' }, recipient: { id: A }, timestamp: Date.now(), message: { mid: echoMid, text: 'sent from the Page inbox', is_echo: true } }, { sender: { id: A }, recipient: { id: 'PAGE' }, delivery: { mids: [m1] } }));
await sleep(1500);
ok('echo messages and delivery receipts are skipped', (await msgByExt(echoMid)).length === 0);

// =============== Instagram is a separate channel ===============
const mi = mid();
await metaPost(insta(dm(A, 'Hi from Instagram, what services do you offer?', {}, mi)));
const inI = await waitFor(async () => (await msgByExt(mi))[0]?.aiCategory ? (await msgByExt(mi))[0] : null, 15_000);
const cI = (await conv('instagram', A))[0]; created.convs.push(cI?.id);
ok('same customer id on Instagram = its own conversation', !!cI && cI.id !== cA.id && inI?.conversationId === cI.id);

// =============== assignment + human reply ===============
const e1 = await userId(1), e2 = await userId(2);
await call(admin, 'PUT', `Conversation/${cA.id}`, { assignedUserId: e1 });
const seen = async n => ((await call(emp(n), 'GET', 'Conversation?maxSize=100')).j.list ?? []).map(c => c.id);
ok('assigned employee sees the conversation, others do not', (await seen(1)).includes(cA.id) && !(await seen(2)).includes(cA.id));
ok('its messages follow the assignee', (await call(emp(1), 'GET', `SocialMessage/${in1.id}`)).s === 200 && (await call(emp(2), 'GET', `SocialMessage/${in1.id}`)).s === 403);
ok('unassigned employee cannot reply', (await call(emp(2), 'POST', 'SocialMessage', { conversationId: cA.id, direction: 'out', text: 'hi', status: 'new' })).s === 403);
ok('nobody can fake an incoming message', (await call(emp(1), 'POST', 'SocialMessage', { conversationId: cA.id, direction: 'in', text: 'fake', status: 'new' })).s === 403);
ok('empty and over-long replies are refused', (await call(emp(1), 'POST', 'SocialMessage', { conversationId: cA.id, direction: 'out', text: '   ', status: 'new' })).s === 400 && (await call(emp(1), 'POST', 'SocialMessage', { conversationId: cA.id, direction: 'out', text: 'x'.repeat(2001), status: 'new' })).s === 400);
const reply = await call(emp(1), 'POST', 'SocialMessage', { conversationId: cA.id, direction: 'out', text: 'Hello Alice, the package is USD 799. Shall I book a call?', status: 'new' });
ok('assigned employee writes a reply', reply.s === 200, JSON.stringify(reply));
webhooks();
const out1 = await waitFor(async () => { const m = (await call(admin, 'GET', `SocialMessage/${reply.j.id}`)).j; return m.status !== 'new' ? m : null; }, 20_000);
ok('reply is sent through Meta and marked sent with Meta message id', out1?.status === 'sent' && /^mid\.mock/.test(out1.externalId), JSON.stringify(out1 && [out1.status, out1.externalId, out1.error]));
const mockSent = await sent();
ok('customer app receives it (Send API got recipient, text and token)', mockSent.some(s => s.recipient === A && s.text.startsWith('Hello Alice') && s.token === process.env.META_PAGE_TOKEN), JSON.stringify(mockSent));
const cA2 = (await call(admin, 'GET', `Conversation/${cA.id}`)).j;
ok('conversation returns to open, the waiting message counts as answered', cA2.status === 'open' && (await call(admin, 'GET', `SocialMessage/${in1.id}`)).j.status === 'sent', JSON.stringify([cA2.status]));

// employee field limits
await call(emp(1), 'PUT', `Conversation/${cA.id}`, { customerName: 'Renamed', windowExpiresAt: '2099-01-01 00:00:00' });
const cA3 = (await call(admin, 'GET', `Conversation/${cA.id}`)).j;
ok('employee cannot rewrite customer name or window', cA3.customerName === `Alice Mock${stamp}` && cA3.windowExpiresAt === cA2.windowExpiresAt);

// =============== 24-hour rule ===============
await call(admin, 'PUT', `Conversation/${cA.id}`, { windowExpiresAt: new Date(Date.now() - 3600e3).toISOString().slice(0, 19).replace('T', ' ') });
const late = await call(emp(1), 'POST', 'SocialMessage', { conversationId: cA.id, direction: 'out', text: 'too late', status: 'new' });
ok('sending after the 24-hour window is blocked with a clear reason', late.s === 403 && /24-hour/.test(late.reason), JSON.stringify([late.s, late.reason]));
await call(admin, 'PUT', `Conversation/${cA.id}`, { windowExpiresAt: cA2.windowExpiresAt });

// =============== live mode: auto-reply + complaint + loop guard ===============
await setDraftOnly(false);
const mb = mid();
await metaPost(page(dm(B, 'What is the price of the Website package?', {}, mb)));
const inB = await waitFor(async () => { const m = (await msgByExt(mb))[0]; return m && m.status === 'auto_replied' ? m : null; }, 20_000);
const cB = (await conv('facebook', B))[0]; created.convs.push(cB?.id);
ok('live mode: confident pricing DM is auto-replied', inB?.status === 'auto_replied' && inB.aiCategory === 'pricing', JSON.stringify(inB && [inB.status, inB.aiCategory]));
const sentB = (await sent()).filter(s => s.recipient === B);
ok('the customer got exactly one reply with the knowledge-base price', sentB.length === 1 && /USD 799/.test(sentB[0].text), JSON.stringify(sentB));
const msgsB = (await call(admin, 'GET', `Conversation/${cB.id}/messages?orderBy=createdAt&order=asc`)).j.list;
const outB = msgsB.find(m => m.direction === 'out');
ok('the auto-reply is recorded in the conversation as a sent outgoing message', outB?.status === 'sent' && /^mid\.mock/.test(outB.externalId) && (await call(admin, 'GET', `Conversation/${cB.id}`)).j.status === 'open');
await metaPost(page({ sender: { id: 'PAGE' }, recipient: { id: B }, timestamp: Date.now(), message: { mid: outB.externalId, text: outB.text, is_echo: true } }));
await sleep(1500);
ok('Meta echo of our own reply is ignored (no loop, no duplicate)', (await msgByExt(outB.externalId)).length === 1 && (await sent()).filter(s => s.recipient === B).length === 1);

const mc = mid();
await metaPost(page(dm(C, 'My order arrived damaged and I am very disappointed. Terrible service.', {}, mc)));
const inC = await waitFor(async () => (await msgByExt(mc))[0]?.aiCategory ? (await msgByExt(mc))[0] : null, 15_000);
const cC = (await conv('facebook', C))[0]; created.convs.push(cC?.id);
await sleep(1000);
ok('complaint is never auto-sent: needs human, conversation flagged', inC?.aiCategory === 'complaint' && inC.status === 'needs_human' && cC.status === 'needs_human' && (await sent()).filter(s => s.recipient === C).length === 0, JSON.stringify(inC && [inC.aiCategory, inC.status]));
const nh = (await call(admin, 'GET', 'Conversation?primaryFilter=needsHuman&maxSize=100')).j.list.map(c => c.id);
ok('Needs-human filter lists the complaint, not the answered conversations', nh.includes(cC.id) && !nh.includes(cB.id) && !nh.includes(cA.id));

// =============== failures are visible ===============
const mf = mid();
await metaPost(page(dm(F, 'hello there', {}, mf)));
await waitFor(async () => (await conv('facebook', F))[0], 15_000);
const cF = (await conv('facebook', F))[0]; created.convs.push(cF?.id);
await call(admin, 'PUT', `Conversation/${cF.id}`, { assignedUserId: e1 });
const rf = await call(emp(1), 'POST', 'SocialMessage', { conversationId: cF.id, direction: 'out', text: 'Hi, how can we help?', status: 'new' });
webhooks();
const failed = await waitFor(async () => { const m = (await call(admin, 'GET', `SocialMessage/${rf.j.id}`)).j; return m.status !== 'new' ? m : null; }, 20_000);
ok('when Meta rejects a send the message is marked failed with Meta\'s reason', failed?.status === 'failed' && /allowed window/.test(failed.error), JSON.stringify(failed && [failed.status, failed.error]));

// =============== contact linking ===============
const dana = (await call(admin, 'POST', 'Contact', { firstName: 'Dana', lastName: `Mock${stamp}` })).j; created.contacts.push(dana.id);
const noDup = { ...admin, 'X-Skip-Duplicate-Check': 'true' }; // two Contacts with one name: the ambiguity we want to test
const erin1 = (await call(noDup, 'POST', 'Contact', { firstName: 'Erin', lastName: `Twin${stamp}` })).j, erin2 = (await call(noDup, 'POST', 'Contact', { firstName: 'Erin', lastName: `Twin${stamp}` })).j;
created.contacts.push(erin1.id, erin2.id);
await profile(D, `Dana Mock${stamp}`); await profile(E, `Erin Twin${stamp}`);
for (const [cust, text] of [[D, 'Hello'], [E, 'Hello'], [G, 'Hello']]) await metaPost(page(dm(cust, text)));
const cD = await waitFor(async () => (await conv('facebook', D))[0], 15_000), cE = await waitFor(async () => (await conv('facebook', E))[0], 15_000), cG = await waitFor(async () => (await conv('facebook', G))[0], 15_000);
created.convs.push(cD?.id, cE?.id, cG?.id);
ok('customer with a unique matching Contact name is linked to it', cD?.contactId === dana.id, JSON.stringify(cD && cD.contactId));
ok('ambiguous name (two Contacts) is not linked', cE && !cE.contactId);
ok('no Graph profile: conversation still created, named by id', cG && !cG.customerName && cG.name.includes(G), JSON.stringify(cG && [cG.name, cG.customerName]));

// =============== attachments ===============
const mh = mid();
await metaPost(page(dm(H, '', { attachments: [{ type: 'image', payload: { url: 'x' } }] }, mh)));
const inH = await waitFor(async () => (await msgByExt(mh))[0]?.status === 'needs_human' ? (await msgByExt(mh))[0] : null, 15_000);
created.convs.push((await conv('facebook', H))[0]?.id);
ok('attachment-only DM is stored as [attachment] and handed to a human', inH?.text === '[attachment]' && inH.status === 'needs_human', JSON.stringify(inH && [inH.text, inH.status]));

// =============== cleanup ===============
for (const id of created.convs.filter(Boolean)) {
  for (const m of (await call(admin, 'GET', `Conversation/${id}/messages?maxSize=100`)).j.list ?? []) await call(admin, 'DELETE', `SocialMessage/${m.id}`);
  await call(admin, 'DELETE', `Conversation/${id}`);
}
for (const id of created.contacts) await call(admin, 'DELETE', `Contact/${id}`);
await setDraftOnly(true);
console.log(fails ? `${fails} FAILED` : 'ALL PASS');
process.exit(fails ? 1 : 0);
