import { readFileSync, writeFileSync } from 'node:fs';

// M4 setup via EspoCRM REST API. Idempotent. Run order: setup-m1, setup-m3, setup-m4 (after the extension is installed).
// Usage: node --env-file=.env scripts/setup-m4.mjs
const BASE = (process.env.BASE_URL ?? `http://localhost:${process.env.ESPO_PORT ?? 8080}`) + '/api/v1/';
const AUTH = 'Basic ' + Buffer.from(`admin:${process.env.ESPOCRM_ADMIN_PASSWORD}`).toString('base64');

async function api(method, path, body) {
  const r = await fetch(BASE + path, { method, headers: { Authorization: AUTH, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${r.headers.get('x-status-reason') ?? ''} ${text}`);
  return text ? JSON.parse(text) : null;
}
function setEnv(key, value) {
  let s = readFileSync('.env', 'utf8');
  const line = new RegExp(`^${key}=.*$`, 'm');
  s = line.test(s) ? s.replace(line, () => `${key}=${value}`) : `${s.replace(/\n*$/, '\n')}${key}=${value}\n`;
  writeFileSync('.env', s);
}
const find = async (entity, attribute, value) =>
  (await api('GET', `${entity}?${new URLSearchParams({ 'where[0][type]': 'equals', 'where[0][attribute]': attribute, 'where[0][value]': value, maxSize: '1' })}`)).list?.[0];
const ensure = async (entity, name, data) => (await find(entity, 'name', name)) ?? api('POST', entity, { name, ...data });

// ---- Automation API user: add what proposals and lead replies need ----
const role = await find('Role', 'name', 'Automation');
const rw = { create: 'no', read: 'all', edit: 'all', delete: 'no' };
await api('PUT', `Role/${role.id}`, {
  assignmentPermission: 'all', // hot-lead Tasks are assigned to the lead's owner, not to the API user
  data: {
    ...role.data,
    User: { create: 'no', read: 'all', edit: 'no', delete: 'no' }, // read-only: EspoCRM needs it to assign a Task to a user
    Lead: { ...rw, stream: 'no' },
    TargetList: { ...rw, create: 'yes' },
    ProposalBrief: rw,
    Task: { create: 'yes', read: 'all', edit: 'no', delete: 'no', stream: 'no' },
  },
});

// ---- Employees never see briefs ----
const emp = await find('Role', 'name', 'Employee');
await api('PUT', `Role/${emp.id}`, { data: { ...emp.data, ProposalBrief: false } });

// ---- Webhook: brief status change -> automation service ----
const apiUser = await find('User', 'userName', 'automation');
const event = 'ProposalBrief.fieldUpdate.status';
const hook = await find('Webhook', 'event', event);
const url = process.env.AUTOMATION_BRIEF_WEBHOOK_URL ?? 'http://automation:3000/webhooks/proposal-brief';
const hookData = { event, url, isActive: true, userId: apiUser.id };
const saved = hook ? await api('PUT', `Webhook/${hook.id}`, hookData) : await api('POST', 'Webhook', hookData);
// EspoCRM generates each webhook's secret itself; the service verifies the brief webhook with its own one.
setEnv('WEBHOOK_SECRET_BRIEF', (await api('GET', `Webhook/${saved.id}`)).secretKey);

// ---- Email template used by every proposal Mass Email ----
const companyAddress = process.env.COMPANY_ADDRESS ?? 'PLACEHOLDER Company Ltd, 1 Example Street, Lahore';
const body = `<div style="white-space: pre-wrap">{Lead.aiProposalBody}</div><br><p style="color:#777;font-size:12px">${companyAddress}<br>{optOutLink}</p>`;
const tpl = await find('EmailTemplate', 'name', 'Lead proposal (AI)');
const tplData = { name: 'Lead proposal (AI)', subject: '{Lead.aiProposalSubject}', body, isHtml: true, status: 'Active' };
if (tpl) await api('PUT', `EmailTemplate/${tpl.id}`, tplData); else await api('POST', 'EmailTemplate', tplData);

// ---- Campaign, exclusion list, sample brief, sending limit ----
await ensure('Campaign', 'AI Lead Proposals', { type: 'Email', status: 'Active' });
await ensure('TargetList', 'Proposal replies and opt-outs', {});
const sampleList = await ensure('TargetList', 'Sample leads (import samples/leads-template.csv here)', {});
await ensure('ProposalBrief', 'Website + SEO Starter (SAMPLE)', {
  targetListId: sampleList.id, status: 'draft', wordLimit: 140,
  instructions: `Offer our Website + SEO Starter package (USD 799, delivered in 3 weeks).
Mention something specific about their industry and their notes if present.
Give 10% discount if they reply before 31 October.
Friendly, professional tone. Max 140 words. Ask for a 15-minute call this week.
Sign as: Ahmed, Business Development, PLACEHOLDER Company.`,
});
// ---- PDF version of a proposal (button 'Send proposal PDF' on the lead) ----
const company = process.env.COMPANY_NAME ?? 'PLACEHOLDER Company Ltd';
const pdfBody = `<h2 style="color:#1f3a5f">{{aiProposalSubject}}</h2><p>{{{proposalHtml}}}</p><hr><p style="font-size:9pt;color:#777">${company}<br>${companyAddress}</p>`;
const pdf = (await api('GET', `Template?${new URLSearchParams({ 'where[0][type]': 'equals', 'where[0][attribute]': 'name', 'where[0][value]': 'Lead proposal PDF', maxSize: '1' })}`)).list[0];
const pdfData = { name: 'Lead proposal PDF', entityType: 'Lead', status: 'Active', body: pdfBody, filename: 'Proposal-{{accountName}}.pdf', pageFormat: 'A4', topMargin: 20, bottomMargin: 20, leftMargin: 20, rightMargin: 20 };
if (pdf) await api('PUT', `Template/${pdf.id}`, pdfData); else await api('POST', 'Template', pdfData);

// Mass Email needs a system sender address even when it sends through a group mailbox.
await api('PUT', 'Settings', {
  outboundEmailFromAddress: process.env.MAILBOX_ADDRESS ?? 'support@crm.test', outboundEmailFromName: process.env.MAILBOX_FROM_NAME ?? 'Company Support',
  massEmailMaxPerHourCount: Number(process.env.MASS_EMAIL_PER_HOUR ?? 50), massEmailOpenTracking: true,
});
console.log('M4 setup done. WEBHOOK_SECRET_BRIEF written to .env (restart automation to load it).');
