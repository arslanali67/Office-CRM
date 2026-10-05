// M4 end-to-end checks: CSV import, AI proposals (stub), review/regenerate, test send, Mass Email, unsubscribe, replies, follow-ups.
// Usage: COMPOSE_PATH_SEPARATOR=: COMPOSE_FILE=docker-compose.yml:docker-compose.local.yml node --env-file=.env scripts/test-m4.mjs
import net from 'node:net';
import { execSync } from 'node:child_process';
import { importLeads } from './import-leads.mjs';

const BASE = `http://localhost:${process.env.ESPO_PORT ?? 8080}/api/v1/`;
const admin = { Authorization: 'Basic ' + Buffer.from(`admin:${process.env.ESPOCRM_ADMIN_PASSWORD}`).toString('base64') };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const call = async (method, path, body, who = admin) => {
  let r;
  for (let i = 0; ; i++) {
    try { r = await fetch(BASE + path, { method, headers: { ...who, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); break; }
    catch (e) { if (i >= 3) throw e; await sleep(1500); }
  }
  const t = await r.text();
  return { s: r.status, j: t.startsWith('{') || t.startsWith('[') ? JSON.parse(t) : t };
};
const sh = cmd => execSync(cmd, { env: { ...process.env, MSYS_NO_PATHCONV: '1' }, stdio: 'pipe', maxBuffer: 64 << 20 }).toString();
const job = (name, opts = '') => sh(`docker compose exec -T -u www-data espocrm php command.php run-job ${name} ${opts}`);
const waitFor = async (fn, ms = 40_000, step = 1000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return null; await sleep(step); } };
const q = o => new URLSearchParams(o).toString();
const byName = async (entity, name) => (await call('GET', `${entity}?${q({ 'where[0][type]': 'equals', 'where[0][attribute]': 'name', 'where[0][value]': name, maxSize: '1' })}`)).j.list?.[0];

let fails = 0;
const ok = (name, cond, extra = '') => { console.log(cond ? 'PASS' : 'FAIL', name, cond ? '' : String(extra).slice(0, 400)); if (!cond) fails++; };

function smtp(from, to, subject, body) {
  return new Promise((resolve, reject) => {
    const s = net.connect(Number(process.env.GREENMAIL_SMTP_PORT ?? 3025), 'localhost');
    const msg = `From: ${from}\r\nTo: ${to}\r\nSubject: ${subject}\r\nMessage-ID: <${Date.now()}.${Math.random().toString(36).slice(2)}@lead.test>\r\nDate: ${new Date().toUTCString()}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}\r\n.\r\n`;
    const steps = ['HELO test', `MAIL FROM:<${from}>`, `RCPT TO:<${to}>`, 'DATA', msg, 'QUIT'];
    let i = -1, buf = '';
    s.on('data', d => {
      buf += d;
      if (!/\r?\n$/.test(buf) || /^\d{3}-/m.test(buf.split(/\r?\n/).filter(Boolean).pop() ?? '')) return;
      if (/^[45]/.test(buf)) { s.destroy(); return reject(new Error('SMTP: ' + buf)); }
      buf = ''; i++;
      if (i < steps.length) s.write(steps[i] + (i === 4 ? '' : '\r\n')); else { s.end(); resolve(); }
    });
    s.on('error', reject);
  });
}
const mailbox = user => { try { return JSON.parse(sh(`python scripts/read-mailbox.py ${user}`)); } catch { return []; } };

const stamp = Date.now().toString(36);
const cleanup = { imports: [], lists: [], briefs: [], massEmails: [] };
const inbox = (await call('GET', 'InboundEmail?maxSize=1')).j.list[0];
const exclusion = await byName('TargetList', 'Proposal replies and opt-outs');
await call('PUT', 'Settings', { massEmailMaxPerHourCount: 5000, aiDraftOnly: true }); // restored at the end

const webhooks = () => job('ProcessWebhookQueue');
async function generate(briefId, regenerate = false, ms = 180_000) {
  await call('PUT', `ProposalBrief/${briefId}`, { status: 'generating', regenerate });
  webhooks();
  return waitFor(async () => { const b = (await call('GET', `ProposalBrief/${briefId}`)).j; return b.status === 'review' ? b : null; }, ms, 2000);
}
async function leadsOf(listId) {
  const out = [];
  for (let offset = 0; ; offset += 200) {
    const r = (await call('GET', `TargetList/${listId}/leads?${q({ maxSize: '200', offset: String(offset), select: 'id,name,emailAddress,firstName,accountName,industryText,description,aiProposalSubject,aiProposalBody,interestLevel,status,proposalBriefId,emailAddressIsOptedOut,targetListIsOptedOut' })}`)).j.list;
    out.push(...r);
    if (r.length < 200) return out;
  }
}

const INSTRUCTIONS = `Offer our Website + SEO Starter package (USD 799, delivered in 3 weeks).
Mention something specific about their industry and their notes if present.
Give 10% discount if they reply before 31 October.
Friendly, professional tone. Max 140 words. Ask for a 15-minute call this week.
Sign as: Ahmed, Business Development, Acme Web Studio.`;

// =============== A. 500-row CSV import with duplicate / invalid report ===============
const rows = ['email,first_name,last_name,company,industry,city,interest,notes'];
for (let i = 0; i < 480; i++) {
  rows.push(`lead${i}-${stamp}@bulk.example,First${i},Last${i},Company ${i},${i % 5 ? 'Retail' : ''},${i % 4 ? 'Lahore' : ''},${i % 7 ? 'Website' : ''},${i % 3 ? 'Note number ' + i : ''}`);
}
for (let i = 0; i < 10; i++) rows.push(`lead${i}-${stamp}@bulk.example,Dup${i},Last,Dup Co,,,,`); // duplicates of rows already in the file
for (let i = 0; i < 10; i++) rows.push(`not-an-email-${i},Bad${i},Last,Bad Co,,,,`); // invalid
const bulkName = `Bulk ${stamp}`;
const t0 = Date.now();
const imp = await importLeads(rows.join('\n') + '\n', bulkName);
cleanup.imports.push(imp.importId); cleanup.lists.push(imp.targetListId);
console.log(`     (import of ${rows.length - 1} rows: ${((Date.now() - t0) / 1000).toFixed(1)}s)`);
ok('480 valid rows imported', imp.created === 480, JSON.stringify(imp).slice(0, 300));
ok('10 duplicate emails detected (and removed)', imp.duplicates === 10, imp.duplicates);
ok('10 invalid rows reported with row numbers', imp.failed === 10 && imp.errors.every(e => e.row > 480), JSON.stringify(imp.errors.slice(0, 2)));
const bulkLeads0 = await leadsOf(imp.targetListId);
ok('target list holds exactly the 480 valid leads', bulkLeads0.length === 480, bulkLeads0.length);
ok('extra CSV columns landed in custom fields', bulkLeads0.some(l => l.industryText === 'Retail' && l.description?.startsWith('Note number')));

// =============== B. one brief -> 480 unique drafts ===============
const brief = (await call('POST', 'ProposalBrief', { name: `Bulk brief ${stamp}`, instructions: INSTRUCTIONS, targetListId: imp.targetListId, wordLimit: 140 })).j;
cleanup.briefs.push(brief.id);
const t1 = Date.now();
const done = await generate(brief.id);
console.log(`     (generation of 480 proposals: ${((Date.now() - t1) / 1000).toFixed(1)}s)`);
ok('brief goes generating -> review with progress counters', done?.status === 'review' && done.generatedCount === 480 && done.totalCount === 480 && done.failedCount === 0, JSON.stringify(done && [done.status, done.generatedCount, done.totalCount, done.failedCount]));
const leads = await leadsOf(imp.targetListId);
const bad = [];
const amounts = new Set(), pcts = new Set();
for (const l of leads) {
  const t = `${l.aiProposalSubject}\n${l.aiProposalBody}`;
  if (!l.aiProposalSubject || !l.aiProposalBody) bad.push([l.name, 'missing']);
  else if (/\{|\}|\[|\]|<[A-Za-z]|undefined|null|NaN|, ,/.test(t)) bad.push([l.name, 'placeholder/garbage']);
  else if (l.aiProposalBody.trim().split(/\s+/).length > 140) bad.push([l.name, 'too long']);
  else if (!l.aiProposalBody.startsWith(`Hi ${l.firstName},`)) bad.push([l.name, 'greeting']);
  (t.match(/USD\s?\d[\d,.]*/g) ?? []).forEach(a => amounts.add(a)); (t.match(/\d+\s?%/g) ?? []).forEach(a => pcts.add(a));
  if (l.description && l.aiProposalBody && !l.aiProposalBody.includes(l.description.replace(/[.!]+$/, ''))) bad.push([l.name, 'notes not used']);
  if (!l.description && /I saw this about you/.test(l.aiProposalBody)) bad.push([l.name, 'invented notes']);
  if (!l.industryText && /works in/.test(l.aiProposalBody)) bad.push([l.name, 'invented industry']);
}
ok('all 480 proposals: no placeholders, within 140 words, personalised, no invented lead facts', bad.length === 0, JSON.stringify(bad.slice(0, 3)));
ok('only the brief\'s offer appears (USD 799, 10%)', [...amounts].every(a => /799/.test(a)) && [...pcts].every(p => /^10\s?%$/.test(p)), JSON.stringify([...amounts, ...pcts]));
ok('480 unique proposals (one per lead)', new Set(leads.map(l => l.aiProposalBody)).size === 480);
ok('proposals are linked to their brief', leads.every(l => l.proposalBriefId === brief.id));

// =============== C. review / edit / regenerate ===============
const target = leads[0];
await call('PUT', `Lead/${target.id}`, { aiProposalBody: 'MANUAL EDIT by the owner' });
const again = await generate(brief.id, false);
ok('Generate keeps leads that already have a proposal (manual edits survive)', again?.status === 'review' && (await call('GET', `Lead/${target.id}`)).j.aiProposalBody === 'MANUAL EDIT by the owner', JSON.stringify(again));
await generate(brief.id, true);
ok('Regenerate rewrites every proposal', (await call('GET', `Lead/${target.id}`)).j.aiProposalBody.startsWith('Hi '));

// =============== D. send test ===============
const testTo = `owner-${stamp}@crm.test`;
const st = await call('POST', 'ProposalBrief/action/sendTest', { id: brief.id, address: testTo });
ok('send test accepted', st.s === 200, JSON.stringify(st));
const got = await waitFor(() => { const m = mailbox(testTo); return m.length ? m : null; }, 15_000);
ok('test proposal arrives at the test address, marked [TEST]', got?.[0]?.subject?.startsWith('[TEST] A proposal for') && got[0].body.includes('NOT sent to them'), JSON.stringify(got?.[0]));
ok('send test rejects bad address', (await call('POST', 'ProposalBrief/action/sendTest', { id: brief.id, address: 'nope' })).s === 400);

// =============== E. seed campaign: Mass Email to 20 addresses ===============
const seedRows = ['email,first_name,last_name,company,industry,city,interest,notes'];
for (let i = 1; i <= 20; i++) seedRows.push(`seed${i}-${stamp}@customer.test,Seed${i},Person,Seed Co ${i},Healthcare,Lahore,Website,Site not mobile friendly`);
const seedList = `Seed ${stamp}`;
const seed = await importLeads(seedRows.join('\n') + '\n', seedList);
cleanup.imports.push(seed.importId); cleanup.lists.push(seed.targetListId);
const seedBrief = (await call('POST', 'ProposalBrief', { name: `Seed brief ${stamp}`, instructions: INSTRUCTIONS, targetListId: seed.targetListId, wordLimit: 140 })).j;
cleanup.briefs.push(seedBrief.id);
ok('seed proposals generated', (await generate(seedBrief.id))?.generatedCount === 20);
const seedLeads = await leadsOf(seed.targetListId);
const seedAddr = l => l.emailAddress;
const tpl = await byName('EmailTemplate', 'Lead proposal (AI)');
const campaign = await byName('Campaign', 'AI Lead Proposals');
const startAt = new Date(Date.now() - 60_000).toISOString().slice(0, 19).replace('T', ' ');
async function launch(name, extra = {}) {
  const me = (await call('POST', 'MassEmail', { name, status: 'Pending', startAt, emailTemplateId: tpl.id, campaignId: campaign.id, targetListsIds: [seed.targetListId], inboundEmailId: inbox.id, storeSentEmails: false, ...extra })).j;
  cleanup.massEmails.push(me.id);
  job('ProcessMassEmail'); await sleep(1500); job('ProcessMassEmail');
  return me;
}
const me1 = await launch(`Proposal 1 ${stamp}`);
await call('PUT', `ProposalBrief/${seedBrief.id}`, { massEmailId: me1.id });
const arrived = await waitFor(() => { const c = seedLeads.filter(l => mailbox(seedAddr(l)).length >= 1).length; return c === 20 ? c : null; }, 60_000, 3000);
ok('Mass Email delivers one email to each of the 20 seed addresses', arrived === 20);
const m1 = mailbox(seedAddr(seedLeads[0]))[0];
const l1 = seedLeads[0];
ok('delivered subject and body are the lead\'s own AI proposal', m1?.subject === l1.aiProposalSubject && m1.body.includes(l1.aiProposalBody.split('\n')[2].slice(0, 40)), JSON.stringify(m1 && [m1.subject, m1.body.slice(0, 120)]));
ok('sent from the company mailbox', m1?.from?.includes('support@crm.test'), m1?.from);
ok('footer has company address + unsubscribe link, open tracking present', /Campaign\/unsubscribe|entryPoint=unsubscribe/.test(m1?.html ?? '') && /PLACEHOLDER Company Ltd/.test(m1?.html ?? '') && /entryPoint=campaignTrackOpened/.test(m1?.html ?? ''), m1?.html?.slice(-400));
const meDone = (await call('GET', `MassEmail/${me1.id}`)).j;
ok('Mass Email completes', meDone.status === 'Complete', meDone.status);
const camp = (await call('GET', `Campaign/${campaign.id}`)).j;
ok('campaign statistics count the sent emails', camp.sentCount >= 20, camp.sentCount);

// =============== F. unsubscribe ===============
const unsubId = /[?&]id=([a-z0-9]+)/i.exec((m1.html.match(/href="([^"]*unsubscribe[^"]*)"/i) ?? [])[1]?.replace(/&amp;/g, '&') ?? '')?.[1];
ok('unsubscribe link carries a queue item id', !!unsubId, m1?.html?.match(/href="[^"]*nsubscribe[^"]*"/));
const un = await call('POST', `Campaign/unsubscribe/${unsubId}`, undefined, {});
ok('unsubscribe request accepted (no login needed)', un.s === 200, JSON.stringify(un));
const lu = (await leadsOf(seed.targetListId)).find(l => l.id === l1.id);
ok('lead is now opted out of the list', lu.targetListIsOptedOut === true || lu.emailAddressIsOptedOut === true, JSON.stringify([lu.targetListIsOptedOut, lu.emailAddressIsOptedOut]));

// =============== G. replies: interest tagging, lead linking, tasks, exclusion ===============
const reply = async (lead, subject, text) => { await smtp(seedAddr(lead), 'support@crm.test', subject, text); };
const [L2, L3, L4, L5] = [seedLeads[1], seedLeads[2], seedLeads[3], seedLeads[4]];
await reply(L2, `Re: ${L2.aiProposalSubject}`, "Yes, I'm interested! Let's talk on Monday.");
await reply(L3, `Re: ${L3.aiProposalSubject}`, 'Not interested, please remove me from your list.');
await reply(L4, `Automatic reply: ${L4.aiProposalSubject}`, 'I am out of office until 5 October.');
await reply(L5, `Re: ${L5.aiProposalSubject}`, 'What exactly is included in the package?');
const fetchMail = () => job('CheckInboundEmails', `--targetType=InboundEmail --targetId=${inbox.id}`);
fetchMail(); webhooks();
const tagged = await waitFor(async () => {
  const ls = await Promise.all([L2, L3, L5].map(async l => (await call('GET', `Lead/${l.id}`)).j));
  return ls.every(l => l.interestLevel) ? ls : null;
}, 30_000);
const lead2 = tagged?.[0], lead3 = tagged?.[1], lead5 = tagged?.[2];
ok('interested reply -> interest tagged + status In Process', lead2?.interestLevel === 'interested' && lead2.status === 'In Process', JSON.stringify(lead2 && [lead2.interestLevel, lead2.status]));
ok('not-interested reply -> tagged + status Dead', lead3?.interestLevel === 'not_interested' && lead3.status === 'Dead', JSON.stringify(lead3 && [lead3.interestLevel, lead3.status]));
ok('question reply -> tagged question', lead5?.interestLevel === 'question');
let lead4;
await waitFor(async () => (lead4 = (await call('GET', `Lead/${L4.id}`)).j).interestLevel, 15_000);
ok('out-of-office reply -> tagged out_of_office', lead4?.interestLevel === 'out_of_office');
const tasks = (await call('GET', `Task?${q({ 'where[0][type]': 'equals', 'where[0][attribute]': 'parentId', 'where[0][value]': L2.id })}`)).j.list;
ok('interested reply creates a High-priority Task for the owner', tasks.length === 1 && tasks[0].priority === 'High' && /Hot lead/.test(tasks[0].name), JSON.stringify(tasks));
ok('no task for other reply types', ((await call('GET', `Task?${q({ 'where[0][type]': 'equals', 'where[0][attribute]': 'parentId', 'where[0][value]': L3.id })}`)).j.list ?? []).length === 0);
const repEmail = (await call('GET', `Email?${q({ 'where[0][type]': 'equals', 'where[0][attribute]': 'name', 'where[0][value]': `Re: ${L2.aiProposalSubject}`, maxSize: '1' })}`)).j.list[0];
ok('reply is linked to the lead automatically', repEmail?.parentType === 'Lead' && repEmail.parentId === L2.id, JSON.stringify(repEmail && [repEmail.parentType, repEmail.parentId]));
ok('lead replies are never auto-answered (a person replies)', repEmail?.aiCategory === 'lead_reply' && repEmail.aiStatus === 'needs_human' && mailbox(seedAddr(L2)).length === 1);
const excluded = await leadsOf(exclusion.id);
const exIds = new Set(excluded.map(l => l.id));
ok('replied leads are in the exclusion list; out-of-office is not', [L2, L3, L5].every(l => exIds.has(l.id)) && !exIds.has(L4.id));

// =============== H. follow-up excludes replied + opted-out ===============
const me2 = await launch(`Proposal 2 follow-up ${stamp}`, { excludingTargetListsIds: [exclusion.id] });
await sleep(6000);
const counts = Object.fromEntries(seedLeads.map(l => [l.id, mailbox(seedAddr(l)).filter(m => m.subject === l.aiProposalSubject).length]));
ok('follow-up skips replied leads and the unsubscribed lead', [seedLeads[0], L2, L3, L5].every(l => counts[l.id] === 1), JSON.stringify(counts));
ok('follow-up still reaches everyone else (incl. out-of-office)', seedLeads.filter(l => ![seedLeads[0], L2, L3, L5].includes(l)).every(l => counts[l.id] === 2), JSON.stringify(counts));

// =============== cleanup ===============
for (const id of cleanup.massEmails) await call('DELETE', `MassEmail/${id}`);
for (const id of cleanup.briefs) await call('DELETE', `ProposalBrief/${id}`);
for (const id of cleanup.imports) await call('POST', `Import/${id}/revert`, {});
for (const id of cleanup.lists) await call('DELETE', `TargetList/${id}`);
for (const l of excluded) await call('DELETE', `Task/${(tasks[0] ?? {}).id}`).catch(() => {});
await call('PUT', 'Settings', { massEmailMaxPerHourCount: 50, aiDraftOnly: true, massEmailOpenTracking: true });
console.log(fails ? `${fails} FAILED` : 'ALL PASS');
process.exit(fails ? 1 : 0);
