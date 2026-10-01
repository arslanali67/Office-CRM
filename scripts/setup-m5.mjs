// M5 setup via EspoCRM REST API. Idempotent. Run order: setup-m1, setup-m3, setup-m4, setup-m5 (after the extension is installed).
// Usage: node --env-file=.env scripts/setup-m5.mjs
import { readFileSync, writeFileSync } from 'node:fs';

const BASE = (process.env.BASE_URL ?? 'http://localhost:8080') + '/api/v1/';
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

// ---- Automation API user: store DMs, answer them, link contacts ----
const role = await find('Role', 'name', 'Automation');
const rw = { create: 'yes', read: 'all', edit: 'all', delete: 'no' };
await api('PUT', `Role/${role.id}`, {
  data: { ...role.data, Conversation: rw, SocialMessage: rw, Contact: { create: 'no', read: 'all', edit: 'no', delete: 'no' } },
});

// ---- Webhook: a reply written in EspoCRM -> the service sends it through Meta ----
const apiUser = await find('User', 'userName', 'automation');
const event = 'SocialMessage.create';
const hook = await find('Webhook', 'event', event);
const hookData = { event, url: process.env.AUTOMATION_SOCIAL_WEBHOOK_URL ?? 'http://automation:3000/webhooks/social-message', isActive: true, userId: apiUser.id };
const saved = hook ? await api('PUT', `Webhook/${hook.id}`, hookData) : await api('POST', 'Webhook', hookData);
setEnv('WEBHOOK_SECRET_SOCIAL', (await api('GET', `Webhook/${saved.id}`)).secretKey); // EspoCRM generates one secret per webhook

// ---- Auto Reply Rules for DMs: same defaults as email (draft-only mode still blocks all sending) ----
const rules = { inquiry: true, pricing: true, booking: true, complaint: false, refund_legal: false, lead_reply: false, spam: false, other: false };
for (const channel of ['facebook', 'instagram']) {
  for (const [category, autoSend] of Object.entries(rules)) {
    const q = new URLSearchParams({ 'where[0][type]': 'equals', 'where[0][attribute]': 'category', 'where[0][value]': category, 'where[1][type]': 'equals', 'where[1][attribute]': 'channel', 'where[1][value]': channel, maxSize: '1' });
    if (!(await api('GET', `AutoReplyRule?${q}`)).list[0]) await api('POST', 'AutoReplyRule', { category, channel, autoSend });
  }
}
console.log('M5 setup done. WEBHOOK_SECRET_SOCIAL written to .env (restart automation to load it).');
