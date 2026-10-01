// M4.11 checks: "Send proposal PDF" on a lead. Needs the local stack (GreenMail).
// Usage: COMPOSE_PATH_SEPARATOR=: COMPOSE_FILE=docker-compose.yml:docker-compose.local.yml node --env-file=.env scripts/test-pdf.mjs
import { execSync } from 'node:child_process';

const BASE = 'http://localhost:8080/api/v1/';
const basic = (u, p) => ({ Authorization: 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64') });
const admin = basic('admin', process.env.ESPOCRM_ADMIN_PASSWORD);
const emp = n => basic(`emp${n}`, process.env.EMPLOYEE_PASSWORD);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const call = async (who, method, path, body) => {
  const r = await fetch(BASE + path, { method, headers: { ...who, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  return { s: r.status, reason: r.headers.get('x-status-reason') ?? '', j: t.startsWith('{') || t.startsWith('[') ? JSON.parse(t) : t };
};
const mailbox = user => { try { return JSON.parse(execSync(`python scripts/read-mailbox.py ${user}`, { stdio: 'pipe' }).toString()); } catch { return []; } };
let fails = 0;
const ok = (name, cond, extra = '') => { console.log(cond ? 'PASS' : 'FAIL', name, cond ? '' : String(extra).slice(0, 400)); if (!cond) fails++; };

const stamp = Date.now().toString(36);
const addr = `pdf-${stamp}@customer.test`;
const e1 = (await call(admin, 'GET', 'User?where[0][type]=equals&where[0][attribute]=userName&where[0][value]=emp1')).j.list[0].id;
const mk = async extra => (await call(admin, 'POST', 'Lead', { firstName: 'Pia', lastName: `Pdf${stamp}`, accountName: `Pdf Co ${stamp}`, emailAddress: addr, ...extra })).j;
const lead = await mk({ aiProposalSubject: 'A proposal for Pdf Co', aiProposalBody: 'Hi Pia,\n\nOur Website + SEO Starter costs USD 799 and takes 3 weeks.\n\nBest regards,\nAhmed' });
const bare = await mk({ firstName: 'Nopro', emailAddress: `nopro-${stamp}@customer.test` });

ok('a lead without a proposal cannot be sent one', (await call(admin, 'POST', 'Email/action/sendLeadPdf', { leadId: bare.id })).s === 400);
ok('an unassigned employee cannot send it', (await call(emp(1), 'POST', 'Email/action/sendLeadPdf', { leadId: lead.id })).s === 403);
await call(admin, 'PUT', `Lead/${lead.id}`, { assignedUserId: e1 });
const r = await call(emp(1), 'POST', 'Email/action/sendLeadPdf', { leadId: lead.id });
ok('the assigned employee can send it', r.s === 200, JSON.stringify([r.s, r.reason]));

let got = [];
for (let i = 0; i < 15 && !got.length; i++) { got = mailbox(addr); if (!got.length) await sleep(1000); }
const m = got[0];
ok('the lead receives an email with the PDF attached', m?.subject === `Our proposal for Pdf Co ${stamp}` && m.attachments?.length === 1, JSON.stringify(m && [m.subject, m.attachments]));
ok('the attachment is a real PDF named after the company', m?.attachments?.[0]?.type === 'application/pdf' && m.attachments[0].magic === '%PDF-' && m.attachments[0].size > 1000 && /^Proposal-Pdf/.test(m.attachments[0].filename), JSON.stringify(m?.attachments));
ok('the email body is personal and has no placeholders', /^Hi Pia,/.test(m?.body) && !/[{}\[\]]|undefined|null/.test(m?.body), m?.body);
const sent = (await call(admin, 'GET', `Email?${new URLSearchParams({ 'where[0][type]': 'equals', 'where[0][attribute]': 'name', 'where[0][value]': `Our proposal for Pdf Co ${stamp}`, maxSize: '1' })}`)).j.list?.[0];
ok('the sent email is stored and linked to the lead', sent?.status === 'Sent' && sent.parentType === 'Lead' && sent.parentId === lead.id, JSON.stringify(sent && [sent.status, sent.parentType]));

await call(admin, 'PUT', `Lead/${lead.id}`, { emailAddressIsOptedOut: true });
ok('an opted-out lead is refused', (await call(admin, 'POST', 'Email/action/sendLeadPdf', { leadId: lead.id })).s === 400);

for (const l of [lead, bare]) await call(admin, 'DELETE', `Lead/${l.id}`);
console.log(fails ? `${fails} FAILED` : 'ALL PASS');
process.exit(fails ? 1 : 0);
