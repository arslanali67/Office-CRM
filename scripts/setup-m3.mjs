// M3 setup via EspoCRM REST API. Idempotent: safe to re-run. Run setup-m1.mjs after the extension is installed first.
// Usage: node --env-file=.env scripts/setup-m3.mjs
// Local defaults point at the GreenMail test server (docker-compose.local.yml); override MAILBOX_* for a real mailbox.
import { readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

const BASE = (process.env.BASE_URL ?? 'http://localhost:8080') + '/api/v1/';
const AUTH = 'Basic ' + Buffer.from(`admin:${process.env.ESPOCRM_ADMIN_PASSWORD}`).toString('base64');

async function api(method, path, body) {
  const r = await fetch(BASE + path, { method, headers: { Authorization: AUTH, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${r.headers.get('x-status-reason') ?? ''} ${text}`);
  return text ? JSON.parse(text) : null;
}
const find = async (entity, attribute, value) =>
  (await api('GET', `${entity}?${new URLSearchParams({ 'where[0][type]': 'equals', 'where[0][attribute]': attribute, 'where[0][value]': value, maxSize: '1' })}`)).list?.[0];
async function upsert(entity, attribute, value, data) {
  const ex = await find(entity, attribute, value);
  return ex ? api('PUT', `${entity}/${ex.id}`, data) : api('POST', entity, data);
}
function setEnv(key, value) {
  let s = readFileSync('.env', 'utf8');
  s = new RegExp(`^${key}=.*$`, 'm').test(s) ? s.replace(new RegExp(`^${key}=.*$`, 'm'), () => `${key}=${value}`) : s.replace(/\n?$/, `\n${key}=${value}\n`);
  writeFileSync('.env', s);
}

// ---- Automation API user: minimal role, API key ----
const all = { create: 'no', read: 'all', edit: 'no', delete: 'no' };
const role = await upsert('Role', 'name', 'Automation', {
  name: 'Automation',
  data: { Email: { create: 'yes', read: 'all', edit: 'all', delete: 'no', stream: 'no' }, KnowledgeBaseArticle: all, AutoReplyRule: all, User: { create: 'no', read: 'own', edit: 'no', delete: 'no' }, Task: false, Lead: false, Contact: false, Account: false },
  assignmentPermission: 'no', userPermission: 'no', exportPermission: 'no', massUpdatePermission: 'no',
});
const apiUser = await upsert('User', 'userName', 'automation', {
  userName: 'automation', type: 'api', authMethod: 'ApiKey', firstName: 'Automation', lastName: 'Service', isActive: true, rolesIds: [role.id],
  ...(process.env.AUTOMATION_IP ? { ipAddress: process.env.AUTOMATION_IP } : {}), // ponytail: set AUTOMATION_IP in production to restrict the API user
});
const apiKey = (await api('GET', `User/${apiUser.id}`)).apiKey;
if (!apiKey) throw new Error('API user has no apiKey');
setEnv('ESPO_API_KEY', apiKey);

// ---- Webhook Email.create -> automation service ----
const url = process.env.AUTOMATION_WEBHOOK_URL ?? 'http://automation:3000/webhooks/espo';
let hook = await find('Webhook', 'event', 'Email.create');
const secret = process.env.WEBHOOK_SECRET || randomBytes(24).toString('hex');
hook = hook
  ? await api('PUT', `Webhook/${hook.id}`, { url, isActive: true, userId: apiUser.id, secretKey: secret })
  : await api('POST', 'Webhook', { event: 'Email.create', url, isActive: true, userId: apiUser.id, secretKey: secret });
setEnv('WEBHOOK_SECRET', (await api('GET', `Webhook/${hook.id}`)).secretKey ?? secret);

// ---- Shared company inbox (Group Email Account) ----
const addr = process.env.MAILBOX_ADDRESS ?? 'support@crm.test';
await upsert('InboundEmail', 'emailAddress', addr, {
  name: 'Company Inbox', emailAddress: addr, status: 'Active', fromName: process.env.MAILBOX_FROM_NAME ?? 'Company Support',
  useImap: true, host: process.env.MAILBOX_IMAP_HOST ?? 'greenmail', port: Number(process.env.MAILBOX_IMAP_PORT ?? 3143), security: process.env.MAILBOX_IMAP_SECURITY ?? '',
  username: process.env.MAILBOX_USER ?? 'support@crm.test', password: process.env.MAILBOX_PASSWORD ?? 'x',
  monitoredFolders: ['INBOX'], fetchSince: new Date(Date.now() - 86400e3).toISOString().slice(0, 10), storeSentEmails: false,
  useSmtp: true, smtpHost: process.env.MAILBOX_SMTP_HOST ?? 'greenmail', smtpPort: Number(process.env.MAILBOX_SMTP_PORT ?? 3025), smtpSecurity: process.env.MAILBOX_SMTP_SECURITY ?? '',
  smtpAuth: (process.env.MAILBOX_SMTP_AUTH ?? 'false') === 'true', smtpUsername: process.env.MAILBOX_USER ?? 'support@crm.test', smtpPassword: process.env.MAILBOX_PASSWORD ?? 'x',
  smtpIsShared: true, smtpIsForMassEmail: true, createCase: false,
  // No team: emails are then visible to the owner and to whoever they are assigned to (role: Email = own), not to every employee.
  teamsIds: [],
});

// ---- Placeholder knowledge base (replace with real company facts: M0.8) ----
const kb = [
  ['Services (PLACEHOLDER)', 'We offer website design, SEO and social media management for small businesses. Our team builds mobile-friendly websites and helps them rank locally.'],
  ['Pricing (PLACEHOLDER)', 'Website + SEO Starter package costs USD 799 and is delivered in 3 weeks. Social media management starts at USD 199 per month.'],
  ['Opening hours (PLACEHOLDER)', 'We are open Monday to Friday, 9:00 to 17:00. We are closed on weekends and public holidays.'],
  ['Booking a call or appointment (PLACEHOLDER)', 'To book a free 15 minute consultation call, reply with your preferred day and time. A team member confirms the slot by email.'],
  ['Policies (PLACEHOLDER)', 'Refunds, complaints and legal matters are handled personally by the owner. We never share customer data with third parties.'],
];
for (const [name, text] of kb)
  await upsert('KnowledgeBaseArticle', 'name', name, { name, status: 'Published', type: 'Article', body: `<p>${text}</p>`, bodyPlain: text });

// ---- Auto Reply Rules (Appendix B defaults; draft-only mode still blocks all sending) ----
const rules = { inquiry: true, pricing: true, booking: true, complaint: false, refund_legal: false, lead_reply: false, spam: false, other: false };
for (const [category, autoSend] of Object.entries(rules)) {
  const ex = (await api('GET', `AutoReplyRule?${new URLSearchParams({ 'where[0][type]': 'equals', 'where[0][attribute]': 'category', 'where[0][value]': category, maxSize: '1' })}`)).list[0];
  if (!ex) await api('POST', 'AutoReplyRule', { category, channel: 'email', autoSend });
}

// ---- Jobs: scheduled emails every minute (built-in job), follow-up tasks ----
const setJob = async (job, scheduling, name) => {
  const ex = await find('ScheduledJob', 'job', job);
  if (ex) await api('PUT', `ScheduledJob/${ex.id}`, { scheduling, status: 'Active' });
  else await api('POST', 'ScheduledJob', { name, job, scheduling, status: 'Active' });
};
await setJob('SendScheduledEmails', '* * * * *');
await setJob('CreateFollowUpTasks', '*/15 * * * *', 'Create follow-up tasks for unanswered emails');

// ---- Draft-only mode on for the first 2 weeks ----
await api('PUT', 'Settings', { aiDraftOnly: true });
console.log('M3 setup done. Inbox:', addr, '| API key and webhook secret written to .env (restart automation to load them).');
