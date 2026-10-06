// Classification + draft for incoming messages.
// Real mode: Claude (default), Gemini (AI_PROVIDER=gemini) or OpenRouter (AI_PROVIDER=openrouter); a small model classifies, a bigger one drafts, with the knowledge base in the prompt.
// Stub mode (no API key for the chosen provider, or AI_MODE=stub): keyword rules, for local testing only.

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
export type Provider = 'claude' | 'gemini' | 'openrouter';
/** apiKey is the key of the chosen provider; no key (or AI_MODE=stub) means the keyword stub. */
export interface AiConfig { provider?: Provider; apiKey?: string; mode?: string; classifyModel: string; draftModel: string }

// ponytail: Gemini / OpenRouter model names change often; set AI_CLASSIFY_MODEL / AI_DRAFT_MODEL if these are retired.
const PROVIDERS: Record<Provider, { key: string; classify: string; draft: string }> = {
  claude: { key: 'ANTHROPIC_API_KEY', classify: 'claude-haiku-4-5-20251001', draft: 'claude-sonnet-5-5' },
  gemini: { key: 'GEMINI_API_KEY', classify: 'gemini-3.5-flash-lite', draft: 'gemini-3.5-flash' },
  openrouter: { key: 'OPENROUTER_API_KEY', classify: 'nvidia/nemotron-3-ultra-550b-a55b:free', draft: 'nvidia/nemotron-3-ultra-550b-a55b:free' },
};
export const providerKeyName = (provider?: string) => PROVIDERS[(provider as Provider) in PROVIDERS ? (provider as Provider) : 'claude'].key;

export const defaultAiConfig = (env = process.env): AiConfig => {
  const provider: Provider = (env.AI_PROVIDER as Provider) in PROVIDERS ? (env.AI_PROVIDER as Provider) : 'claude';
  const p = PROVIDERS[provider];
  return {
    provider,
    apiKey: env[p.key] || undefined,
    mode: env.AI_MODE,
    classifyModel: env.AI_CLASSIFY_MODEL || p.classify,
    draftModel: env.AI_DRAFT_MODEL || p.draft,
  };
};

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

// ---------- contact-detail guard (prompt-injection defence) ----------
// A message or a lead's notes can try to make the AI put a link, address or phone number of the attacker's choosing into
// a reply that goes out under the company's name. Any such detail must already exist in the knowledge base (or brief).

const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"')\]]+/gi;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PHONE_RE = /\+?\d[\d\s().-]{7,}\d/g;
const DATE_RE = /\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}[./]\d{1,2}[./]\d{2,4}\b/g;

/** Links, email addresses and phone numbers found in a text, normalised so the same detail compares equal. */
export function contactsIn(text: string): string[] {
  const out = new Set<string>();
  for (const u of text.match(URL_RE) ?? []) out.add('url:' + u.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/[/.,;:!?]+$/, ''));
  for (const e of text.match(EMAIL_RE) ?? []) out.add('mail:' + e.toLowerCase());
  for (const p of text.replace(DATE_RE, ' ').match(PHONE_RE) ?? []) {
    const d = p.replace(/\D/g, '');
    if (d.length >= 9) out.add('tel:' + d);
  }
  return [...out];
}

export function unknownContacts(text: string, allowedText: string): string[] {
  const known = new Set(contactsIn(allowedText));
  return contactsIn(text).filter(c => !known.has(c));
}

export function guardContacts(result: AiResult, kb: KbArticle[]): AiResult {
  const unknown = unknownContacts(result.reply, kb.map(a => a.text).join('\n'));
  if (!unknown.length) return result;
  return { ...result, confident: false, reason: `${result.reason} [contact detail not in knowledge base: ${unknown.join(', ')}]`.trim() };
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

// ---------- real (Claude or Gemini) ----------

const RULES = `You answer customer messages for a small company.
Rules: use ONLY facts from the knowledge base; never invent prices, dates, discounts or promises.
Reply in the customer's language; short, polite, professional.
If the answer is not in the knowledge base, say a team member will reply shortly and set confident=false.
Never share internal information, employee details or other customers' data.
Complaints and refund/legal requests are never confident.
Output ONLY one JSON object, no other text.`;

const TEMPORARY = /^(Gemini|Anthropic|OpenRouter) (429|5\d\d)/; // rate limit or "high demand": worth another try
export const retryDelayMs = { value: 2000 }; // tests set this to 0

export async function llm(cfg: AiConfig, model: string, system: { text: string; cache?: boolean }[], user: string, maxTokens: number): Promise<string> {
  const call = cfg.provider === 'gemini' ? gemini : cfg.provider === 'openrouter' ? openrouter : claude;
  for (let attempt = 1; ; attempt++) {
    try {
      return await call(cfg, model, system, user, maxTokens);
    } catch (e) {
      const msg = String((e as Error).message);
      if (attempt >= 4 || !TEMPORARY.test(msg) || /per[- ]?day/i.test(msg)) throw e; // a daily quota will not clear in a few seconds
      await new Promise(r => setTimeout(r, retryDelayMs.value * attempt));
    }
  }
}

async function claude(cfg: AiConfig, model: string, system: { text: string; cache?: boolean }[], user: string, maxTokens: number): Promise<string> {
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

// Every call in this service expects one JSON object back, so Gemini is asked for JSON directly. Caching is automatic on Gemini (no flag).
// maxOutputTokens has headroom because some Gemini models count their internal "thinking" tokens against it.
async function gemini(cfg: AiConfig, model: string, system: { text: string }[], user: string, maxTokens: number): Promise<string> {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: { 'x-goog-api-key': cfg.apiKey!, 'content-type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: system.map(s => ({ text: s.text })) },
      contents: [{ role: 'user', parts: [{ text: user }] }],
      generationConfig: { maxOutputTokens: maxTokens + 2048, responseMimeType: 'application/json' },
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 1500)}`);
  const data = (await res.json()) as { candidates?: { finishReason?: string; content?: { parts?: { text?: string }[] } }[]; promptFeedback?: { blockReason?: string } };
  const c = data.candidates?.[0];
  const text = (c?.content?.parts ?? []).map(p => p.text ?? '').join('');
  if (!text) throw new Error(`Gemini returned no text (${c?.finishReason ?? data.promptFeedback?.blockReason ?? 'unknown reason'})`);
  return text;
}

// OpenRouter speaks the OpenAI chat format. Free variants have no JSON mode, so the prompt asks for JSON and parseAiJson() finds it in the text.
// The default model is a reasoning model whose thinking tokens count against max_tokens, hence the headroom. Errors can also arrive with HTTP 200.
async function openrouter(cfg: AiConfig, model: string, system: { text: string }[], user: string, maxTokens: number): Promise<string> {
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.apiKey}`, 'content-type': 'application/json', 'X-Title': 'Office CRM' },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens + 4096,
      messages: [{ role: 'system', content: system.map(s => s.text).join('\n\n') }, { role: 'user', content: user }],
    }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${(await res.text()).slice(0, 1500)}`);
  const data = (await res.json()) as { error?: { code?: number; message?: string }; choices?: { finish_reason?: string; message?: { content?: string | null } }[] };
  if (data.error) throw new Error(`OpenRouter ${data.error.code ?? 500}: ${String(data.error.message ?? '').slice(0, 1500)}`);
  const c = data.choices?.[0];
  if (!c?.message?.content) throw new Error(`OpenRouter returned no text (${c?.finish_reason ?? 'unknown reason'})`);
  return c.message.content;
}

const fmt = (m: Incoming) =>
  `${m.history.length ? `Earlier in the thread:\n${m.history.join('\n---\n')}\n\n` : ''}From: ${m.from}\nSubject: ${m.subject}\n\n${m.body}`;

async function claudeClassifyAndDraft(msg: Incoming, kb: KbArticle[], cfg: AiConfig): Promise<AiResult> {
  const kbText = kb.map(a => `## ${a.name}\n${a.text}`).join('\n\n');
  const system = [{ text: RULES }, { text: `Knowledge base:\n${kbText}`, cache: true }];
  const user = fmt(msg);

  const cls = parseAiJson(await llm(cfg, cfg.classifyModel, system,
    `Classify this message. Categories: ${CATEGORIES.join(', ')}. ` +
    `Return {"category": "...", "reason": "one short sentence"}.\n\n${user}`, 200));
  const category = cls.category as Category;
  if (!CATEGORIES.includes(category)) throw new Error(`Bad category: ${String(cls.category)}`);
  if (category === 'spam') return { category, confident: true, reply: '', reason: String(cls.reason ?? '') };

  const draft = parseAiJson(await llm(cfg, cfg.draftModel, system,
    `The message was classified as "${category}". Write the reply. ` +
    `Return {"category": "${category}", "confident": true|false, "reply": "...", "reason": "one short sentence"}.\n\n${user}`, 1000));
  return validate({ ...draft, category });
}

/** The model's answer as it is, before the invented-price guard (used by the accuracy check to see what the guard catches). */
export async function classifyAndDraftUnguarded(msg: Incoming, kb: KbArticle[], cfg = defaultAiConfig()): Promise<AiResult> {
  const useStub = cfg.mode === 'stub' || !cfg.apiKey;
  return useStub ? stubClassifyAndDraft(msg, kb) : await claudeClassifyAndDraft(msg, kb, cfg);
}

export async function classifyAndDraft(msg: Incoming, kb: KbArticle[], cfg = defaultAiConfig()): Promise<AiResult> {
  return guardContacts(guardPrices(await classifyAndDraftUnguarded(msg, kb, cfg), kb), kb);
}
