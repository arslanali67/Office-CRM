import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyAndDraft, defaultAiConfig, llm, retryDelayMs } from '../src/ai.ts';

retryDelayMs.value = 0;

const kb = [{ name: 'Pricing', text: 'Starter costs USD 799.' }];
const msg = { from: 'a@b.test', subject: 'Price?', body: 'How much?', history: [] };

function fakeFetch(reply: (url: string, init: any) => Response) {
  const calls: { url: string; init: any }[] = [];
  const orig = globalThis.fetch;
  globalThis.fetch = (async (url: any, init: any) => { calls.push({ url: String(url), init }); return reply(String(url), init); }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = orig; } };
}
const gemOk = (text: string) => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }), { status: 200 });

test('config: Claude is the default, Gemini only when asked, each with its own key and models', () => {
  const c = defaultAiConfig({ ANTHROPIC_API_KEY: 'a', GEMINI_API_KEY: 'g' } as any);
  assert.deepEqual([c.provider, c.apiKey, c.draftModel], ['claude', 'a', 'claude-sonnet-5-5']);
  const g = defaultAiConfig({ AI_PROVIDER: 'gemini', ANTHROPIC_API_KEY: 'a', GEMINI_API_KEY: 'g' } as any);
  assert.deepEqual([g.provider, g.apiKey], ['gemini', 'g']);
  assert.match(g.draftModel, /^gemini/);
  assert.equal(defaultAiConfig({ AI_PROVIDER: 'gemini', ANTHROPIC_API_KEY: 'a' } as any).apiKey, undefined, 'the Claude key is never used for Gemini');
  assert.equal(defaultAiConfig({ AI_PROVIDER: 'gemini', AI_DRAFT_MODEL: 'my-model' } as any).draftModel, 'my-model');
  assert.equal(defaultAiConfig({ AI_DRAFT_MODEL: '' } as any).draftModel, 'claude-sonnet-5-5', 'an empty value falls back to the default');
});

test('gemini: request has key in a header, system text, JSON mode; answer is read back', async () => {
  const f = fakeFetch(() => gemOk('{"ok":true}'));
  try {
    const out = await llm({ provider: 'gemini', apiKey: 'SECRET', classifyModel: '', draftModel: '' }, 'gemini-x', [{ text: 'RULES' }, { text: 'KB', cache: true }], 'hello', 100);
    assert.equal(out, '{"ok":true}');
    const { url, init } = f.calls[0];
    assert.match(url, /models\/gemini-x:generateContent$/);
    assert.ok(!url.includes('SECRET'), 'key must not be in the URL');
    assert.equal(init.headers['x-goog-api-key'], 'SECRET');
    const body = JSON.parse(init.body);
    assert.deepEqual(body.systemInstruction.parts.map((p: any) => p.text), ['RULES', 'KB']);
    assert.equal(body.contents[0].parts[0].text, 'hello');
    assert.equal(body.generationConfig.responseMimeType, 'application/json');
    assert.ok(body.generationConfig.maxOutputTokens >= 100);
  } finally { f.restore(); }
});

test('gemini: errors and empty answers are reported, not swallowed', async () => {
  let f = fakeFetch(() => new Response('quota', { status: 429 }));
  try { await assert.rejects(llm({ provider: 'gemini', apiKey: 'k', classifyModel: '', draftModel: '' }, 'm', [], 'x', 10), /Gemini 429/); assert.equal(f.calls.length, 4, 'tried 4 times'); } finally { f.restore(); }
  f = fakeFetch(() => new Response('bad key', { status: 400 }));
  try { await assert.rejects(llm({ provider: 'gemini', apiKey: 'k', classifyModel: '', draftModel: '' }, 'm', [], 'x', 10), /Gemini 400/); assert.equal(f.calls.length, 1, 'a permanent error is not retried'); } finally { f.restore(); }
  f = fakeFetch(() => new Response(JSON.stringify({ candidates: [{ finishReason: 'SAFETY' }] }), { status: 200 }));
  try { await assert.rejects(llm({ provider: 'gemini', apiKey: 'k', classifyModel: '', draftModel: '' }, 'm', [], 'x', 10), /no text \(SAFETY\)/); } finally { f.restore(); }
});

test('gemini end to end: classify + draft, and the invented-price guard still applies', async () => {
  const cfg = { provider: 'gemini' as const, apiKey: 'k', classifyModel: 'c', draftModel: 'd' };
  let f = fakeFetch((_u, init) => gemOk(JSON.parse(init.body).contents[0].parts[0].text.startsWith('Classify')
    ? '{"category":"pricing","reason":"asks price"}' : '{"category":"pricing","confident":true,"reply":"It costs USD 799.","reason":"kb"}'));
  try {
    const r = await classifyAndDraft(msg, kb, cfg);
    assert.deepEqual([r.category, r.confident, r.reply], ['pricing', true, 'It costs USD 799.']);
  } finally { f.restore(); }
  f = fakeFetch((_u, init) => gemOk(JSON.parse(init.body).contents[0].parts[0].text.startsWith('Classify')
    ? '{"category":"pricing","reason":"x"}' : '{"category":"pricing","confident":true,"reply":"It costs USD 500.","reason":"kb"}'));
  try {
    const r = await classifyAndDraft(msg, kb, cfg);
    assert.equal(r.confident, false, 'a price that is not in the knowledge base must go to a human');
  } finally { f.restore(); }
});

test('a temporary "high demand" error is retried and then succeeds', async () => {
  let n = 0;
  const f = fakeFetch(() => (++n < 3 ? new Response('{"error":{"code":503}}', { status: 503 }) : gemOk('{"ok":true}')));
  try {
    assert.equal(await llm({ provider: 'gemini', apiKey: 'k', classifyModel: '', draftModel: '' }, 'm', [], 'x', 10), '{"ok":true}');
    assert.equal(f.calls.length, 3);
  } finally { f.restore(); }
});

test('a daily quota error is not retried', async () => {
  const f = fakeFetch(() => new Response('{"error":{"code":429,"details":[{"quotaId":"GenerateRequestsPerDayPerProjectPerModel-FreeTier"}]}}', { status: 429 }));
  try {
    await assert.rejects(llm({ provider: 'gemini', apiKey: 'k', classifyModel: '', draftModel: '' }, 'm', [], 'x', 10), /Gemini 429/);
    assert.equal(f.calls.length, 1);
  } finally { f.restore(); }
});
