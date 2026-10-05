// AI for leads (M4): personalised proposals, and interest tagging of replies to them.
// Same pattern as ai.ts: real AI (Claude or Gemini) when a key is set, keyword stub otherwise; everything validated before use.
import { AMOUNT, llm, defaultAiConfig, digits, parseAiJson, unknownContacts, type AiConfig, type KbArticle } from './ai.ts';

export interface Lead {
  id: string; firstName?: string | null; lastName?: string | null; name?: string | null; accountName?: string | null;
  industryText?: string | null; addressCity?: string | null; interestTopic?: string | null; description?: string | null;
}
export interface Brief { instructions: string; wordLimit: number }
export interface Proposal { subject: string; body: string }

const PLACEHOLDER = /\{\{|\}\}|\{[A-Za-z_.]+\}|\[[^\]\n]{1,40}\]|<[A-Za-z][A-Za-z _-]{0,30}>|lorem ipsum|\bTBD\b|\bundefined\b|\bnull\b|\bNaN\b/i;
const PERCENT = /\d+(?:\.\d+)?\s?%/g;

/** Returns why a proposal must be rejected, or null when it is safe to store. */
export function proposalProblem(p: Proposal, brief: Brief, allowedText: string): string | null {
  if (!p.subject.trim() || p.subject.length > 150 || /[\r\n]/.test(p.subject)) return 'bad subject';
  if (!p.body.trim()) return 'empty body';
  const words = p.body.trim().split(/\s+/).length;
  if (words > brief.wordLimit) return `too long: ${words} > ${brief.wordLimit} words`;
  const text = `${p.subject}\n${p.body}`;
  if (PLACEHOLDER.test(text)) return 'contains a placeholder';
  const known = new Set((allowedText.match(AMOUNT) ?? []).map(digits));
  const badAmount = (text.match(AMOUNT) ?? []).map(digits).find(d => !known.has(d));
  if (badAmount) return `amount not in brief or knowledge base: ${badAmount}`;
  const knownPct = new Set((allowedText.match(PERCENT) ?? []).map(digits));
  const badPct = (text.match(PERCENT) ?? []).map(digits).find(d => !knownPct.has(d));
  if (badPct) return `percentage not in brief or knowledge base: ${badPct}%`;
  const badContact = unknownContacts(text, allowedText)[0];
  if (badContact) return `contact detail not in brief or knowledge base: ${badContact}`;
  return null;
}

const clean = (v?: string | null) => (v ?? '').replace(/\s+/g, ' ').trim();
const nonEmpty = (lead: Lead): Record<string, string> =>
  Object.fromEntries(Object.entries({
    firstName: lead.firstName, lastName: lead.lastName, company: lead.accountName, industry: lead.industryText,
    city: lead.addressCity, interestedIn: lead.interestTopic, notes: lead.description,
  }).map(([k, v]) => [k, clean(v)]).filter(([, v]) => v));

export function stubProposal(lead: Lead, brief: Brief): Proposal {
  const f = nonEmpty(lead);
  const offer = brief.instructions.split(/(?<=[.!?])\s+|\n/).map(s => s.trim())
    .filter(s => /\d|discount|deliver|offer/i.test(s) && !/^(sign as|max|friendly|ask )/i.test(s)).join(' ');
  const sign = /sign as:\s*(.+)/i.exec(brief.instructions)?.[1]?.trim().replace(/\.$/, '') ?? 'The Team';
  const optional = [
    f.company && f.industry ? `I noticed ${f.company} works in ${f.industry}${f.city ? ` in ${f.city}` : ''}.` : f.company ? `I came across ${f.company}.` : '',
    f.notes ? `I saw this about you: ${f.notes.replace(/[.!]+$/, '')}.` : '',
    f.interestedIn ? `I understand you are interested in ${f.interestedIn}.` : '',
  ].filter(Boolean);
  const build = (extra: string[]) =>
    [`Hi ${f.firstName ?? 'there'},`, ...extra, offer, 'Would you be open to a 15-minute call this week?', `Best regards,\n${sign}`].filter(Boolean).join('\n\n');

  let extra = optional; // drop optional sentences until the word limit is respected
  while (extra.length && build(extra).split(/\s+/).length > brief.wordLimit) extra = extra.slice(0, -1);
  return {
    subject: f.company ? `A proposal for ${f.company}` : `A proposal for ${f.firstName ?? 'you'}`,
    body: build(extra),
  };
}

const PROPOSAL_RULES = `You write one short, personalised cold-outreach email per lead for a small company.
Rules: follow the owner's instructions exactly. Use ONLY offers, prices, discounts and dates that appear in the owner's instructions or the knowledge base.
Never invent facts about the lead or their business; use only the lead fields provided; skip empty fields naturally.
Plain text, no markdown. Respect the word limit. Never leave placeholders, brackets or template variables.
Output ONLY one JSON object: {"subject": "...", "body": "..."}.`;

async function claudeProposal(lead: Lead, brief: Brief, kb: KbArticle[], cfg: AiConfig, problem?: string): Promise<Proposal> {
  const system = [
    { text: PROPOSAL_RULES },
    { text: `Knowledge base:\n${kb.map(a => `## ${a.name}\n${a.text}`).join('\n\n')}\n\nOwner instructions:\n${brief.instructions}\nWord limit: ${brief.wordLimit}`, cache: true },
  ];
  const user = `Lead (empty fields omitted):\n${JSON.stringify(nonEmpty(lead))}${problem ? `\n\nYour previous attempt was rejected: ${problem}. Fix it.` : ''}`;
  const raw = parseAiJson(await llm(cfg, cfg.draftModel, system, user, 700));
  if (typeof raw.subject !== 'string' || typeof raw.body !== 'string') throw new Error('proposal JSON needs subject and body');
  return { subject: raw.subject.trim(), body: raw.body.trim() };
}

/** One validated proposal per lead; one retry with the rejection reason, then it throws. */
export async function generateProposal(lead: Lead, brief: Brief, kb: KbArticle[], cfg = defaultAiConfig()): Promise<Proposal> {
  const useStub = cfg.mode === 'stub' || !cfg.apiKey;
  const allowed = `${brief.instructions}\n${kb.map(a => a.text).join('\n')}`;
  let problem: string | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const p = useStub ? stubProposal(lead, brief) : await claudeProposal(lead, brief, kb, cfg, problem ?? undefined);
    problem = proposalProblem(p, brief, allowed);
    if (!problem) return p;
    if (useStub) break; // deterministic: a retry cannot change the outcome
  }
  throw new Error(`proposal rejected: ${problem}`);
}

export const INTERESTS = ['interested', 'not_interested', 'question', 'out_of_office'] as const;
export type Interest = (typeof INTERESTS)[number];

export function stubInterest(text: string): Interest {
  if (/out of office|away until|automatic reply|on (annual )?leave|auto-?reply/i.test(text)) return 'out_of_office';
  if (/not interested|no thanks|no thank you|remove me|unsubscribe|stop (emailing|contacting)|don'?t contact/i.test(text)) return 'not_interested';
  if (/\binterested\b|sounds good|let'?s (talk|chat|meet|schedule|do it)|call me|\byes\b|i'?d like|book a call/i.test(text)) return 'interested';
  return 'question';
}

export async function classifyInterest(text: string, cfg = defaultAiConfig()): Promise<Interest> {
  if (cfg.mode === 'stub' || !cfg.apiKey) return stubInterest(text);
  const system = [{ text: "Classify a lead's reply to a sales proposal email. Output ONLY JSON: {\"interest\": \"interested|not_interested|question|out_of_office\"}." }];
  const out = parseAiJson(await llm(cfg, cfg.classifyModel, system, text.slice(0, 4000), 50));
  if (!INTERESTS.includes(out.interest as Interest)) throw new Error(`Bad interest: ${String(out.interest)}`);
  return out.interest as Interest;
}
