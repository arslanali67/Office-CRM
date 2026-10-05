// Loads docs/KNOWLEDGE-BASE.md into the EspoCRM Knowledge Base (R07 / M3.2). Idempotent: safe to re-run.
// Every "## heading" under "# Articles" becomes one published article (matched by name).
// Old "(TEST)" and "(PLACEHOLDER)" articles that are no longer in the file are deleted; other articles are left alone.
// Usage: node --env-file=.env scripts/load-kb.mjs
import { readFileSync } from 'node:fs';

const BASE = (process.env.BASE_URL ?? `http://localhost:${process.env.ESPO_PORT ?? 8080}`) + '/api/v1/';
const AUTH = 'Basic ' + Buffer.from(`admin:${process.env.ESPOCRM_ADMIN_PASSWORD}`).toString('base64');
async function api(method, path, body) {
  const r = await fetch(BASE + path, { method, headers: { Authorization: AUTH, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${r.headers.get('x-status-reason') ?? ''} ${text}`);
  return text ? JSON.parse(text) : null;
}

const md = readFileSync(new URL('../docs/KNOWLEDGE-BASE.md', import.meta.url), 'utf8').replace(/\r/g, '');
const section = md.split(/^# Articles$/m)[1]?.split(/^# /m)[0];
if (!section) throw new Error('docs/KNOWLEDGE-BASE.md has no "# Articles" section');
const articles = section.split(/^## /m).slice(1).map(s => {
  const [name, ...lines] = s.split('\n');
  return { name: name.trim(), text: lines.join('\n').trim() };
});
for (const a of articles) if (!a.name || !a.text) throw new Error(`Empty article: "${a.name}"`);
if (new Set(articles.map(a => a.name)).size !== articles.length) throw new Error('Two articles have the same heading');

const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const existing = (await api('GET', 'KnowledgeBaseArticle?select=id,name&maxSize=200')).list;
for (const { name, text } of articles) {
  const data = { name, status: 'Published', type: 'Article', body: text.split('\n').map(l => `<p>${esc(l)}</p>`).join(''), bodyPlain: text };
  const ex = existing.find(e => e.name === name);
  await (ex ? api('PUT', `KnowledgeBaseArticle/${ex.id}`, data) : api('POST', 'KnowledgeBaseArticle', data));
  console.log(ex ? 'updated' : 'created', name);
}
for (const e of existing)
  if (/\((TEST|PLACEHOLDER)\)\s*$/.test(e.name) && !articles.some(a => a.name === e.name)) {
    await api('DELETE', `KnowledgeBaseArticle/${e.id}`);
    console.log('deleted', e.name);
  }
