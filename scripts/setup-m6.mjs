// M6 setup via EspoCRM REST API. Idempotent. Run order: setup-m1, m3, m4, m5, m6 (after the extension is installed).
// Usage: node --env-file=.env scripts/setup-m6.mjs
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

// ---- Automation API user: read what the nightly report counts, write the report ----
const role = await find('Role', 'name', 'Automation');
const read = { create: 'no', read: 'all', edit: 'no', delete: 'no' };
await api('PUT', `Role/${role.id}`, {
  data: { ...role.data, Attendance: read, Campaign: read, DailyReport: { create: 'yes', read: 'all', edit: 'all', delete: 'no' } },
});

// ---- Security (plan section 10): password policy, session expiry, brute-force limits, 2FA available ----
await api('PUT', 'Settings', {
  passwordStrengthLength: 10, passwordStrengthLetterCount: 1, passwordStrengthNumberCount: 1, passwordStrengthBothCases: true,
  authTokenLifetime: 12, authTokenMaxIdleTime: 4, // hours: a session ends after 12 h, or 4 h without use
  // (login lock-out after 5 failed attempts is config-only: set by scripts/install-extension.sh)
  auth2FA: true, auth2FAMethodList: ['Totp'], auth2FAForced: false, // owner enrols in Preferences (forced later if wanted)
});

// ---- Owner email (daily summary goes here): placeholder until the real address is known ----
const owner = await find('User', 'userName', 'admin');
if (!owner.emailAddress) await api('PUT', `User/${owner.id}`, { emailAddress: process.env.OWNER_EMAIL ?? 'owner@crm.test' });

// ---- Daily summary mail at 07:30 (server time) ----
const job = await find('ScheduledJob', 'job', 'SendDailySummary');
const jobData = { name: 'Daily summary email to the owner', job: 'SendDailySummary', status: 'Active', scheduling: '30 7 * * *' };
if (job) await api('PUT', `ScheduledJob/${job.id}`, jobData); else await api('POST', 'ScheduledJob', jobData);
console.log('M6 setup done.');

// ---- Webhooks (human DM replies, Generate button) are delivered by this job: every minute instead of every 2 ----
const hookJob = await find('ScheduledJob', 'job', 'ProcessWebhookQueue');
if (hookJob) await api('PUT', `ScheduledJob/${hookJob.id}`, { scheduling: '* * * * *', status: 'Active' });
