// Scoring for the AI accuracy check (plan M3 acceptance: >= 90% of real emails correctly categorised, zero invented prices).
import { AMOUNT, CATEGORIES, digits, type Category } from './ai.ts';

/** RFC 4180 CSV: quoted fields, doubled quotes, commas and newlines inside quotes. First row = header. */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some(f => f.trim() !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some(f => f.trim() !== '')) rows.push(row);
  const [head, ...body] = rows;
  if (!head) return [];
  const names = head.map(h => h.trim());
  return body.map(r => Object.fromEntries(names.map((n, i) => [n, (r[i] ?? '').trim()])));
}

export interface Case { subject: string; expected: Category; got: Category; confident: boolean; reply: string; guardedConfident: boolean }

// Categories the AI may answer without a person (when allowed by the Auto Reply Rules). Sending one of these to an
// angry or legal message is the mistake that matters most.
const AUTO_OK = new Set<Category>(['inquiry', 'pricing', 'booking']);
const MUST_BE_HUMAN = new Set<Category>(['complaint', 'refund_legal']);

export const amountsIn = (text: string) => (text.match(AMOUNT) ?? []).map(digits);

export function score(cases: Case[], kbText: string, threshold = 0.9) {
  const known = new Set(amountsIn(kbText));
  const correct = cases.filter(c => c.got === c.expected);
  const wrong = cases.filter(c => c.got !== c.expected);
  const invented = cases.filter(c => amountsIn(c.reply).some(a => !known.has(a)));
  const dangerous = cases.filter(c => MUST_BE_HUMAN.has(c.expected) && AUTO_OK.has(c.got) && c.guardedConfident);
  const perCategory: Record<string, { total: number; correct: number }> = {};
  for (const c of cases) {
    const p = (perCategory[c.expected] ??= { total: 0, correct: 0 });
    p.total++; if (c.got === c.expected) p.correct++;
  }
  const accuracy = cases.length ? correct.length / cases.length : 0;
  return {
    total: cases.length, correct: correct.length, accuracy, perCategory,
    confusions: wrong.map(c => ({ subject: c.subject, expected: c.expected, got: c.got })),
    inventedPrices: invented.map(c => ({ subject: c.subject, reply: c.reply.slice(0, 200) })),
    dangerous: dangerous.map(c => ({ subject: c.subject, expected: c.expected, got: c.got })),
    pass: cases.length >= 1 && accuracy >= threshold && invented.length === 0 && dangerous.length === 0,
  };
}

export const isCategory = (v: string): v is Category => (CATEGORIES as readonly string[]).includes(v);
