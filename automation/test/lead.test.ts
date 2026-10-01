import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateProposal, proposalProblem, stubInterest, stubProposal } from '../src/lead-ai.ts';

const brief = {
  wordLimit: 140,
  instructions: `Offer our Website + SEO Starter package (USD 799, delivered in 3 weeks).
Mention something specific about their industry and their notes if present.
Give 10% discount if they reply before 31 October.
Friendly, professional tone. Max 140 words. Ask for a 15-minute call this week.
Sign as: Ahmed, Business Development, Acme Web Studio.`,
};
const full = { id: '1', firstName: 'Ali', accountName: 'Bright Dental', industryText: 'Healthcare', addressCity: 'Lahore', interestTopic: 'Website', description: 'Site not mobile friendly' };
const allowed = brief.instructions;

test('stub proposal: personalised, within limit, no placeholders, only brief facts', () => {
  const p = stubProposal(full, brief);
  assert.match(p.body, /^Hi Ali,/);
  assert.match(p.body, /Bright Dental works in Healthcare in Lahore/);
  assert.match(p.body, /Site not mobile friendly/);
  assert.match(p.body, /USD 799/);
  assert.match(p.body, /10% discount/);
  assert.match(p.body, /Ahmed, Business Development, Acme Web Studio/);
  assert.equal(proposalProblem(p, brief, allowed), null);
});

test('stub proposal: empty fields are skipped naturally', () => {
  const p = stubProposal({ id: '2' }, brief);
  assert.match(p.body, /^Hi there,/);
  assert.doesNotMatch(`${p.subject}\n${p.body}`, /undefined|null|\bnull\b|, ,|\(\)/);
  assert.equal(proposalProblem(p, brief, allowed), null);
  assert.equal(stubProposal({ id: '3', accountName: 'Only Co' }, brief).body.includes('I came across Only Co.'), true);
});

test('stub proposal: drops optional sentences to honour a tight word limit', () => {
  const p = stubProposal(full, { ...brief, wordLimit: 60 });
  assert.ok(p.body.split(/\s+/).length <= 60);
  assert.equal(proposalProblem(p, { ...brief, wordLimit: 60 }, allowed), null);
});

test('proposal checks reject invented facts and leftovers', () => {
  const ok = { subject: 'Hello', body: 'Hi Ali,\n\nUSD 799 for the starter package.' };
  assert.equal(proposalProblem(ok, brief, allowed), null);
  assert.match(proposalProblem({ ...ok, body: 'Hi Ali, only USD 499 today.' }, brief, allowed)!, /amount/);
  assert.match(proposalProblem({ ...ok, body: 'Hi Ali, 25% off for you.' }, brief, allowed)!, /percentage/);
  assert.match(proposalProblem({ ...ok, body: 'Hi {{firstName}}, USD 799.' }, brief, allowed)!, /placeholder/);
  assert.match(proposalProblem({ ...ok, body: 'Hi [Name], USD 799.' }, brief, allowed)!, /placeholder/);
  assert.match(proposalProblem({ ...ok, body: 'Hi undefined, USD 799.' }, brief, allowed)!, /placeholder/);
  assert.match(proposalProblem({ ...ok, body: 'word '.repeat(141) }, brief, allowed)!, /too long/);
  assert.match(proposalProblem({ ...ok, subject: ' ' }, brief, allowed)!, /subject/);
  assert.match(proposalProblem({ ...ok, body: ' ' }, brief, allowed)!, /empty/);
  assert.equal(proposalProblem({ ...ok, body: 'Hi, USD 799.00 and 10% off.' }, brief, allowed), null, 'same number, different formatting');
});

test('a brief containing a placeholder makes generation fail instead of sending it', async () => {
  const bad = { ...brief, instructions: brief.instructions.replace('Acme Web Studio', '<Company>') };
  await assert.rejects(generateProposal(full, bad, [], { mode: 'stub', classifyModel: '', draftModel: '' }), /placeholder/);
});

test('interest tagging of replies', () => {
  assert.equal(stubInterest('Yes, interested! Let us talk on Monday.'), 'interested');
  assert.equal(stubInterest('Sounds good, call me tomorrow'), 'interested');
  assert.equal(stubInterest('Not interested, please remove me from your list'), 'not_interested');
  assert.equal(stubInterest('Automatic reply: I am out of office until 5 Oct'), 'out_of_office');
  assert.equal(stubInterest('What is included in the package?'), 'question');
  assert.equal(stubInterest('hmm'), 'question');
});
