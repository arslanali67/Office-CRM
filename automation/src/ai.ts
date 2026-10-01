// Classification + draft for incoming messages.
// Real mode: Claude Haiku 4.5 classifies, Sonnet 5 drafts, both with the knowledge base prompt-cached.
// Stub mode (no ANTHROPIC_API_KEY, or AI_MODE=stub): keyword rules, for local testing only.

export const CATEGORIES = ['inquiry', 'pricing', 'booking', 'complaint', 'refund_legal', 'lead_reply', 'spam', 'other'] as const;
export type Category = (typeof CATEGORIES)[number];

export interface AiResult {
  category: Category;
  confident: boolean;
  reply: string;
  reason: string;
}
export interface KbArticle { name: string; text: string }
export interface Incoming { from: string; subject: string; body: string; history: string[] }
export interface AiConfig { apiKey?: string; mode?: string; classifyModel: string; draftModel: string }

export const defaultAiConfig = (env = process.env): AiConfig => ({
  apiKey: env.ANTHROPIC_API_KEY || undefined,
  mode: env.AI_MODE,
  classifyModel: env.AI_CLASSIFY_MODEL ?? 'claude-haiku-4-5-20251001',
  draftModel: env.AI_DRAFT_MODEL ?? 'claude-sonnet-5-5',
});

// ---------- validation (nothing from the model is trusted before this) ----------

export function parseAiJson(text: string): Record<string, unknown> {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('AI output has no JSON object');
  const obj = JSON.parse(text.slice(start, end + 1));
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) throw new Error('AI output is not an object');
  return obj as Record<string, unknown>;
}

export function validate(raw: Record<string, unknown>): AiResult {
  const category = raw.category;
  if (!CATEGORIES.includes(category as Category)) throw new Error(`Bad category: ${String(category)}`);
  if (typeof raw.confident !== 'boolean') throw new Error('confident must be boolean');
  const reply = raw.reply ?? '';
  if (typeof reply !== 'string' || reply.length > 4000) throw new Error('reply must be a string up to 4000 chars');
  return { category: category as Category, confident: raw.confident, reply: reply.trim(), reason: String(raw.reason ?? '').slice(0, 500) };
}

export const AMOUNT = /(?:[$€£]|usd|eur|gbp|pkr|rs\.?)\s*\d[\d,]*(?:\.\d+)?|\d[\d,]*(?:\.\d+)?\s*(?:usd|eur|gbp|pkr|rupees|dollars|euros)/gi;
export const digits = (s: string) => String(Number(s.replace(/[^\d.]/g, '')));

/** Invented-price guard: every money amount in the reply must appear in the knowledge base, else a human must review. */
export function guardPrices(result: AiResult, kb: KbArticle[]): AiResult {
  const kbAmounts = new Set((kb.map(a => a.text).join('\n').match(AMOUNT) ?? []).map(digits));
  const unknown = (result.reply.match(AMOUNT) ?? []).map(digits).filter(d => !kbAmounts.has(d));
  if (!unknown.length) return result;
  return { ...result, confident: false, reason: `${result.reason} [price not in knowledge base: ${unknown.join(', ')}]`.trim() };
}

// ---------- stub ----------

const STUB_RULES: [Category, RegExp][] = [
  ['spam', /unsubscribe|lottery|crypto|viagra|winner|click here to claim/i],
  ['refund_legal', /refund|money back|chargeback|lawyer|legal action|sue\b/i],
  ['complaint', /complain|unacceptable|damaged|wrong order|terrible|angry|disappointed/i],
  ['lead_reply', /your proposal|thanks for (the|your) (proposal|offer)|interested in your offer/i],
  ['pricing', /price|pricing|cost|how much|quote|fee/i],
  ['booking', /book|appointment|reserve|reservation|schedule a/i],
  ['inquiry', /service|offer|hours|open|what do you|do you (do|provide|have)|information/i],
];

export function stubClassifyAndDraft(msg: Incoming, kb: KbArticle[]): AiResult {
  const text = `${msg.subject}\n${msg.body}`;
  const category = STUB_RULES.find(([, re]) => re.test(text))?.[0] ?? 'other';
  const words = new Set(text.toLowerCase().match(/[a-z]{4,}/g) ?? []);
  const hit = kb
    .map(a => ({ a, score: [...words].filter(w => `${a.name} ${a.text}`.toLowerCase().includes(w)).length }))
    .sort((x, y) => y.score - x.score)[0];
  const snippet = hit && hit.score > 1 ? `${hit.a.name}: ${hit.a.text.slice(0, 500)}` : '';
  const reply = category === 'spam' ? '' : snippet
    ? `Hello,\n\nThank you for your message. ${snippet}\n\nBest regards,\nThe Team`
    : 'Hello,\n\nThank you for your message. A team member will reply to you shortly.\n\nBest regards,\nThe Team';
  return {
    category,
    confident: ['inquiry', 'pricing', 'booking'].includes(category) && snippet !== '',
    reply,
    reason: 'stub',
  };
}

// ---------- real (Claude) ----------

const RULES = `You answer customer messages for a small company.
Rules: use ONLY facts from the knowledge base; never invent prices, dates, discounts or promises.
Reply in the customer's language; short, polite, professional.
If the answer is not in the knowledge base, say a team member will reply shortly and set confident=false.
Never share internal information, employee details or other customers' data.
Complaints and refund/legal requests are never confident.
Output ONLY one JSON object, no other text.`;

export async function claude(cfg: AiConfig, model: string, system: { text: string; cache?: boolean }[], user: string, maxTokens: number): Promise<string> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': cfg.apiKey!, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system: system.map(s => ({ type: 'text', text: s.text, ...(s.cache ? { cache_control: { type: 'ephemeral' } } : {}) })),
      messages: [{ role: 'user', content: user }],
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = (await res.json()) as { content: { type: string; text?: string }[] };
  return data.content.filter(c => c.type === 'text').map(c => c.text).join('');
}

const fmt = (m: Incoming) =>
  `${m.history.length ? `Earlier in the thread:\n${m.history.join('\n---\n')}\n\n` : ''}From: ${m.from}\nSubject: ${m.subject}\n\n${m.body}`;

async function claudeClassifyAndDraft(msg: Incoming, kb: KbArticle[], cfg: AiConfig): Promise<AiResult> {
  const kbText = kb.map(a => `## ${a.name}\n${a.text}`).join('\n\n');
  const system = [{ text: RULES }, { text: `Knowledge base:\n${kbText}`, cache: true }];
  const user = fmt(msg);

  const cls = parseAiJson(await claude(cfg, cfg.classifyModel, system,
    `Classify this message. Categories: ${CATEGORIES.join(', ')}. ` +
    `Return {"category": "...", "reason": "one short sentence"}.\n\n${user}`, 200));
  const category = cls.category as Category;
  if (!CATEGORIES.includes(category)) throw new Error(`Bad category: ${String(cls.category)}`);
  if (category === 'spam') return { category, confident: true, reply: '', reason: String(cls.reason ?? '') };

  const draft = parseAiJson(await claude(cfg, cfg.draftModel, system,
    `The message was classified as "${category}". Write the reply. ` +
    `Return {"category": "${category}", "confident": true|false, "reply": "...", "reason": "one short sentence"}.\n\n${user}`, 1000));
  return validate({ ...draft, category });
}

export async function classifyAndDraft(msg: Incoming, kb: KbArticle[], cfg = defaultAiConfig()): Promise<AiResult> {
  const useStub = cfg.mode === 'stub' || !cfg.apiKey;
  const result = useStub ? stubClassifyAndDraft(msg, kb) : await claudeClassifyAndDraft(msg, kb, cfg);
  return guardPrices(result, kb);
}
