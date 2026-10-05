// Load test (plan M6): 1,000 messages and a 5,000-lead campaign. Run it against staging (or the local stack).
// Usage: COMPOSE_PATH_SEPARATOR=: COMPOSE_FILE=docker-compose.yml:docker-compose.local.yml node --env-file=.env scripts/load-test.mjs [dms=1000] [leads=5000]
// Local mode talks to the mock Meta API (:4011) and the automation service (:3100). AI is the keyword stub, so AI latency is NOT measured.
import { createHmac } from 'node:crypto';
import { execSync } from 'node:child_process';
import { importLeads } from './import-leads.mjs';

const DMS = Number(process.argv[2] ?? 1000), LEADS = Number(process.argv[3] ?? 5000);
const BASE = `http://localhost:${process.env.ESPO_PORT ?? 8080}/api/v1/`;
const admin = { Authorization: 'Basic ' + Buffer.from(`admin:${process.env.ESPOCRM_ADMIN_PASSWORD}`).toString('base64'), 'Content-Type': 'application/json' };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const q = o => new URLSearchParams(o).toString();
const sh = cmd => execSync(cmd, { env: { ...process.env, MSYS_NO_PATHCONV: '1' }, stdio: 'pipe', maxBuffer: 256 << 20 }).toString();
const call = async (method, path, body) => { const r = await fetch(BASE + path, { method, headers: admin, body: body ? JSON.stringify(body) : undefined }); const t = await r.text(); return { s: r.status, j: t.startsWith('{') ? JSON.parse(t) : t }; };
const p = (arr, f) => arr.slice().sort((a, b) => a - b)[Math.min(arr.length - 1, Math.floor(arr.length * f))];
const stamp = Date.now().toString(36);
const secs = t0 => ((Date.now() - t0) / 1000).toFixed(1);
const results = {};
console.log(`Load test ${stamp}: ${DMS} DMs, ${LEADS} leads`);

// Probe: how fast does the CRM itself answer while the load runs?
const probe = []; let probing = true;
(async () => { while (probing) { const t = Date.now(); await call('GET', 'Task?maxSize=5&select=id'); probe.push(Date.now() - t); await sleep(3000); } })();

// =============== A. DM burst ===============
await call('PUT', 'Settings', { aiDraftOnly: false, aiAutoReplyPaused: false, massEmailMaxPerHourCount: 100000 });
await fetch(`http://localhost:${process.env.MOCK_META_PORT ?? 4011}/_reset`, { method: 'POST', body: '{}' });
const TEXTS = [
  ['What is the price of the Website package?', 'auto'], ['How much does it cost?', 'auto'], ['What services do you offer?', 'auto'], ['Can I book an appointment for Friday?', 'auto'],
  ['What are your opening hours?', 'auto'], ['My order arrived damaged and I am very disappointed.', 'human'], ['I want my money back, this is unacceptable.', 'human'],
  ['zzz qqq', 'human'], ['You are a lottery winner, click here to claim', 'ignored'], ['Do you provide SEO too?', 'auto'],
];
const customers = 200;
const sign = raw => 'sha256=' + createHmac('sha256', process.env.META_APP_SECRET).update(raw).digest('hex');
const tA = Date.now();
let accepted = 0, rejected = 0, next = 0;
async function worker() {
  while (next < DMS) {
    const i = next++;
    const [text] = TEXTS[i % TEXTS.length];
    const body = JSON.stringify({ object: i % 3 ? 'page' : 'instagram', entry: [{ id: 'PAGE', messaging: [{ sender: { id: `lt-${stamp}-${i % customers}` }, recipient: { id: 'PAGE' }, timestamp: Date.now(), message: { mid: `lt_${stamp}_${i}`, text } }] }] });
    const r = await fetch(`http://localhost:${process.env.AUTOMATION_PORT ?? 3100}/webhooks/meta`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': sign(body) }, body }).catch(() => ({ status: 0 }));
    r.status === 200 ? accepted++ : rejected++;
  }
}
await Promise.all(Array.from({ length: 10 }, worker));
console.log(`  ${accepted} webhooks accepted (${rejected} rejected) in ${secs(tA)}s; waiting for the service to finish...`);

async function count(statusSet) {
  let n = 0, total = 0;
  for (let offset = 0; ; offset += 200) {
    const r = (await call('GET', `SocialMessage?${q({ 'where[0][type]': 'startsWith', 'where[0][attribute]': 'externalId', 'where[0][value]': `lt_${stamp}_`, 'where[1][type]': 'equals', 'where[1][attribute]': 'direction', 'where[1][value]': 'in', select: 'status', maxSize: '200', offset: String(offset) })}`)).j.list ?? [];
    total += r.length; n += r.filter(m => statusSet.has(m.status)).length;
    if (r.length < 200) return { n, total };
  }
}
let last = { n: 0, total: 0 };
const deadline = Date.now() + 90 * 60e3;
while (Date.now() < deadline) {
  last = await count(new Set(['auto_replied', 'needs_human', 'ignored', 'sent']));
  if (last.total >= accepted && last.n >= accepted) break;
  await sleep(10_000);
}
const dmSecs = (Date.now() - tA) / 1000;
const sent = (await (await fetch(`http://localhost:${process.env.MOCK_META_PORT ?? 4011}/_sent`)).json()).length;
const final = await count(new Set(['auto_replied']));
const ai = await count(new Set(['needs_human']));
results.dm = { posted: DMS, accepted, stored: last.total, finished: last.n, seconds: Math.round(dmSecs), perMinute: Math.round(last.n / (dmSecs / 60)), autoReplied: final.n, needsHuman: ai.n, metaSends: sent };
console.log('  DMs:', JSON.stringify(results.dm));
const logs = sh(`docker compose logs automation --since ${Math.ceil(dmSecs / 60) + 2}m`);
results.dm.serviceErrors = (logs.match(/"event":"(error|dm_ai_error|dm_send_error|dm_out_error)"/g) ?? []).length;
const dupes = (await call('GET', `Conversation?${q({ 'where[0][type]': 'startsWith', 'where[0][attribute]': 'customerId', 'where[0][value]': `lt-${stamp}-`, select: 'channel,customerId', maxSize: '200' })}`)).j.list ?? [];
console.log(`  service errors: ${results.dm.serviceErrors}; conversations (first page): ${dupes.length}`);

// =============== B. 5,000-lead campaign ===============
const rows = ['email,first_name,last_name,company,industry,city,interest,notes'];
for (let i = 0; i < LEADS; i++) rows.push(`load${i}-${stamp}@bulk.example,First${i},Last${i},Load Co ${i},${i % 5 ? 'Retail' : ''},${i % 4 ? 'Lahore' : ''},${i % 7 ? 'Website' : ''},${i % 3 ? 'Note number ' + i : ''}`);
const tI = Date.now();
const imp = await importLeads(rows.join('\n') + '\n', `Load ${stamp}`);
results.import = { rows: LEADS, created: imp.created, duplicates: imp.duplicates, failed: imp.failed, seconds: Math.round((Date.now() - tI) / 1000) };
console.log('  import:', JSON.stringify(results.import));

const brief = (await call('POST', 'ProposalBrief', { name: `Load brief ${stamp}`, instructions: 'Offer our Website + SEO Starter package (USD 799, delivered in 3 weeks).\nGive 10% discount if they reply before 31 October.\nSign as: Ahmed, Acme Web Studio.', targetListId: imp.targetListId, wordLimit: 140 })).j;
const tG = Date.now();
await call('PUT', `ProposalBrief/${brief.id}`, { status: 'generating', regenerate: false });
sh('docker compose exec -T -u www-data espocrm php command.php run-job ProcessWebhookQueue');
let b;
while (Date.now() - tG < 60 * 60e3) { b = (await call('GET', `ProposalBrief/${brief.id}`)).j; if (b.status === 'review') break; await sleep(10_000); }
results.proposals = { total: b?.totalCount, written: b?.generatedCount, failed: b?.failedCount, seconds: Math.round((Date.now() - tG) / 1000) };
console.log('  proposals:', JSON.stringify(results.proposals));

// Sending limit: queue the whole list but allow only 200 per hour; the rest must stay queued.
await call('PUT', 'Settings', { massEmailMaxPerHourCount: 200 });
const tpl = (await call('GET', `EmailTemplate?${q({ 'where[0][type]': 'equals', 'where[0][attribute]': 'name', 'where[0][value]': 'Lead proposal (AI)' })}`)).j.list[0];
const inbox = (await call('GET', 'InboundEmail?maxSize=1')).j.list[0];
const me = (await call('POST', 'MassEmail', { name: `Load mass ${stamp}`, status: 'Pending', startAt: new Date(Date.now() - 60e3).toISOString().slice(0, 19).replace('T', ' '), emailTemplateId: tpl.id, targetListsIds: [imp.targetListId], inboundEmailId: inbox.id, storeSentEmails: false })).j;
const tM = Date.now();
sh('docker compose exec -T -u www-data espocrm php command.php run-job ProcessMassEmail'); await sleep(2000);
sh('docker compose exec -T -u www-data espocrm php command.php run-job ProcessMassEmail');
const queue = async status => (await call('GET', `EmailQueueItem?${q({ 'where[0][type]': 'equals', 'where[0][attribute]': 'massEmailId', 'where[0][value]': me.id, 'where[1][type]': 'equals', 'where[1][attribute]': 'status', 'where[1][value]': status, select: 'id', maxSize: '1' })}`)).j;
const sentItems = await (async () => { let n = 0; for (let o = 0; ; o += 200) { const r = (await call('GET', `EmailQueueItem?${q({ 'where[0][type]': 'equals', 'where[0][attribute]': 'massEmailId', 'where[0][value]': me.id, 'where[1][type]': 'equals', 'where[1][attribute]': 'status', 'where[1][value]': 'Sent', select: 'id', maxSize: '200', offset: String(o) })}`)).j.list ?? []; n += r.length; if (r.length < 200) return n; } })();
results.campaign = { queued: LEADS, sentFirstHour: sentItems, hourlyLimit: 200, seconds: Math.round((Date.now() - tM) / 1000) };
console.log('  mass email:', JSON.stringify(results.campaign));

probing = false;
results.crmProbeMs = { samples: probe.length, median: p(probe, 0.5), p95: p(probe, 0.95), max: Math.max(...probe) };
console.log('  CRM response time during the load (ms):', JSON.stringify(results.crmProbeMs));

// cleanup
await call('PUT', 'Settings', { massEmailMaxPerHourCount: 50, aiDraftOnly: true });
await call('DELETE', `MassEmail/${me.id}`); await call('DELETE', `ProposalBrief/${brief.id}`);
await call('POST', `Import/${imp.importId}/revert`, {}); await call('DELETE', `TargetList/${imp.targetListId}`);
for (let offset = 0; ; ) {
  const convs = (await call('GET', `Conversation?${q({ 'where[0][type]': 'startsWith', 'where[0][attribute]': 'customerId', 'where[0][value]': `lt-${stamp}-`, select: 'id', maxSize: '100' })}`)).j.list ?? [];
  if (!convs.length) break;
  for (const c of convs) { for (const m of (await call('GET', `Conversation/${c.id}/messages?maxSize=100&select=id`)).j.list ?? []) await call('DELETE', `SocialMessage/${m.id}`); await call('DELETE', `Conversation/${c.id}`); }
}
console.log('\nRESULT ' + JSON.stringify(results, null, 1));
