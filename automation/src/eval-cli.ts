// AI accuracy check (plan M3 acceptance and M4 spot-check). Runs inside the automation container, so it uses the real API key.
//
//   Emails: 100 real past emails with the correct category -> accuracy, confusions, invented prices, dangerous mistakes
//     docker compose exec -T automation node src/eval-cli.ts emails - < my-100-emails.csv
//     CSV columns: subject, body, expected_category   (inquiry | pricing | booking | complaint | refund_legal | lead_reply | spam | other)
//
//   Proposals: spot-check generated proposals of a brief (default 30 random ones)
//     docker compose exec -T automation node src/eval-cli.ts proposals "Name of the brief" [30]
//
// Exit code 0 = passed, 1 = failed. On a dev machine: node --env-file=.env automation/src/eval-cli.ts ...
import { readFileSync } from 'node:fs';
import { Espo } from './espo.ts';
import { classifyAndDraftUnguarded, defaultAiConfig, guardContacts, guardPrices, type KbArticle } from './ai.ts';
import { isCategory, parseCsv, score, type Case } from './eval.ts';
import { proposalProblem } from './lead-ai.ts';

const strip = (s: string) => s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const espo = new Espo(process.env.ESPO_URL ?? 'http://localhost:8080', process.env.ESPO_API_KEY ?? '');
const cfg = defaultAiConfig();
const stub = cfg.mode === 'stub' || !cfg.apiKey;
const banner = () => console.log(stub
  ? 'AI: STUB (keyword rules). These numbers say nothing about Claude: set ANTHROPIC_API_KEY and leave AI_MODE empty.\n'
  : `AI: Claude (${cfg.classifyModel} classifies, ${cfg.draftModel} drafts)\n`);

async function knowledgeBase(): Promise<KbArticle[]> {
  const list = await espo.list('KnowledgeBaseArticle', { 'where[0][type]': 'equals', 'where[0][attribute]': 'status', 'where[0][value]': 'Published', select: 'name,bodyPlain,body' });
  return list.map((a: any) => ({ name: a.name, text: a.bodyPlain || strip(a.body ?? '') }));
}

async function pool<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i]); } }));
  return out;
}

async function emails(file: string): Promise<boolean> {
  const text = file === '-' ? readFileSync(0, 'utf8') : readFileSync(file, 'utf8');
  const rows = parseCsv(text);
  const bad = rows.map((r, i) => ({ r, i })).filter(({ r }) => !isCategory(r.expected_category) || !r.body);
  if (!rows.length || bad.length) {
    console.error(`CSV problem: ${rows.length ? `${bad.length} row(s) with a missing body or unknown expected_category, e.g. row ${bad[0].i + 2}: "${bad[0].r.expected_category}"` : 'no rows'}`);
    return false;
  }
  banner();
  const kb = await knowledgeBase();
  const kbText = kb.map(a => a.text).join('\n');
  console.log(`${rows.length} emails, knowledge base: ${kb.length} published articles\n`);

  const cases = await pool(rows, 4, async r => {
    const raw = await classifyAndDraftUnguarded({ from: r.from || 'customer@example.com', subject: r.subject, body: r.body, history: [] }, kb).catch(e => ({ category: 'other' as const, confident: false, reply: '', reason: String(e) }));
    return { subject: r.subject || r.body.slice(0, 50), expected: r.expected_category, got: raw.category, confident: raw.confident, reply: raw.reply, guardedConfident: guardContacts(guardPrices(raw, kb), kb).confident } as Case;
  });
  const s = score(cases, kbText);

  console.log(`Accuracy: ${s.correct}/${s.total} = ${(s.accuracy * 100).toFixed(1)}%   (target >= 90%)`);
  console.log('Per category:'); for (const [c, v] of Object.entries(s.perCategory)) console.log(`  ${c.padEnd(13)} ${v.correct}/${v.total}`);
  if (s.confusions.length) { console.log('\nWrong category:'); for (const c of s.confusions) console.log(`  [${c.expected} -> ${c.got}] ${c.subject}`); }
  console.log(`\nInvented prices (an amount in a draft that is not in the knowledge base): ${s.inventedPrices.length}   (target 0; the guard sends these to a human)`);
  for (const c of s.inventedPrices) console.log(`  ${c.subject}: ${c.reply.replace(/\s+/g, ' ')}`);
  console.log(`Dangerous (complaint/refund/legal that could have been answered automatically): ${s.dangerous.length}   (target 0)`);
  for (const c of s.dangerous) console.log(`  [${c.expected} -> ${c.got}] ${c.subject}`);
  console.log(`\n${s.pass ? 'PASS' : 'FAIL'}`);
  return s.pass;
}

async function proposals(briefName: string, n: number): Promise<boolean> {
  banner();
  const brief = (await espo.list('ProposalBrief', { 'where[0][type]': 'equals', 'where[0][attribute]': 'name', 'where[0][value]': briefName, maxSize: '1' }))[0];
  if (!brief) { console.error(`No proposal brief named "${briefName}".`); return false; }
  const leads: any[] = [];
  for (let offset = 0; ; offset += 200) {
    const page = await espo.get<{ list: any[] }>(`TargetList/${brief.targetListId}/leads?${new URLSearchParams({ select: 'name,accountName,industryText,addressCity,interestTopic,description,aiProposalSubject,aiProposalBody', maxSize: '200', offset: String(offset) })}`);
    leads.push(...page.list);
    if (page.list.length < 200) break;
  }
  const withProposal = leads.filter(l => l.aiProposalBody);
  if (!withProposal.length) { console.error('No generated proposals in that brief yet.'); return false; }
  const sample = withProposal.sort(() => Math.random() - 0.5).slice(0, n);
  const kb = await knowledgeBase();
  const allowed = `${brief.instructions}\n${kb.map(a => a.text).join('\n')}`;
  const problems = sample.map(l => ({ l, p: proposalProblem({ subject: l.aiProposalSubject ?? '', body: l.aiProposalBody }, { instructions: brief.instructions, wordLimit: brief.wordLimit }, allowed) })).filter(x => x.p);
  console.log(`${sample.length} random proposals of ${withProposal.length} (word limit ${brief.wordLimit})`);
  console.log(`Automatic checks (placeholders, word limit, prices/discounts not in the brief or knowledge base): ${problems.length} problem(s)`);
  for (const { l, p } of problems) console.log(`  ${l.name}: ${p}`);
  console.log('\nNow READ these 5 yourself (the facts about the lead must come from the lead data shown):');
  for (const l of sample.slice(0, 5)) {
    console.log(`\n--- lead: ${[l.name, l.accountName, l.industryText, l.addressCity, l.interestTopic, l.description].filter(Boolean).join(' | ')}`);
    console.log(`Subject: ${l.aiProposalSubject}\n${l.aiProposalBody}`);
  }
  console.log(`\n${problems.length ? 'FAIL' : 'PASS (automatic checks; the reading is yours)'}`);
  return problems.length === 0;
}

if (import.meta.main) {
  const [mode, a, b] = process.argv.slice(2);
  const ok = mode === 'emails' && a ? await emails(a)
    : mode === 'proposals' && a ? await proposals(a, Number(b) || 30)
    : (console.error('Usage:\n  eval-cli.ts emails <file.csv | -> \n  eval-cli.ts proposals "<brief name>" [count]'), false);
  process.exit(ok ? 0 : 1);
}
