import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { guardPrices, parseAiJson, stubClassifyAndDraft, validate, type AiResult } from '../src/ai.ts';
import { decide, skipReason, type Rule } from '../src/email.ts';
import { validSignature } from '../src/index.ts';

const kb = [{ name: 'Website package', text: 'Website + SEO Starter costs USD 799, delivered in 3 weeks. Open Mon-Fri 9-17.' }];
const res = (o: Partial<AiResult> = {}): AiResult => ({ category: 'pricing', confident: true, reply: 'It costs USD 799.', reason: '', ...o });
const rules: Rule[] = ['inquiry', 'pricing', 'complaint', 'other'].map(category => ({ category, channel: 'email', autoSend: true }));

test('price guard: known amount passes, invented amount forces human', () => {
  assert.equal(guardPrices(res(), kb).confident, true);
  assert.equal(guardPrices(res({ reply: 'It costs $500.' }), kb).confident, false);
  assert.equal(guardPrices(res({ reply: 'That is 1,299 USD.' }), kb).confident, false);
  assert.equal(guardPrices(res({ reply: 'USD 799.00 total' }), kb).confident, true);
});

test('validate rejects malformed AI output', () => {
  assert.throws(() => validate({ category: 'nope', confident: true, reply: '' }));
  assert.throws(() => validate({ category: 'pricing', confident: 'yes', reply: '' }));
  assert.throws(() => validate({ category: 'pricing', confident: true, reply: 'x'.repeat(4001) }));
  assert.equal(validate(parseAiJson('Sure! {"category":"pricing","confident":true,"reply":" hi ","reason":"r"} done')).reply, 'hi');
  assert.throws(() => parseAiJson('no json here'));
});

test('decide: auto-send only when confident, allowed, not always-human, not draft-only', () => {
  assert.deepEqual(decide(res(), rules, 'email', false), { aiStatus: 'auto_replied', send: true });
  assert.equal(decide(res(), rules, 'email', true).send, false, 'draft-only mode');
  assert.equal(decide(res({ confident: false }), rules, 'email', false).send, false, 'not confident');
  assert.equal(decide(res({ category: 'inquiry' }), [], 'email', false).send, false, 'no rule');
  assert.equal(decide(res({ category: 'booking' }), rules, 'email', false).send, false, 'category has no rule');
  assert.equal(decide(res({ category: 'complaint' }), rules, 'email', false).send, false, 'complaint always human');
  assert.equal(decide(res({ category: 'other' }), rules, 'email', false).send, false, 'other always human');
  assert.equal(decide(res({ reply: '' }), rules, 'email', false).send, false, 'empty reply');
  assert.deepEqual(decide(res({ category: 'spam' }), rules, 'email', false), { aiStatus: 'ignored', send: false });
  assert.equal(decide(res(), rules, 'instagram', false).send, false, 'rule is per channel');
});

test('skipReason: only real inbound mail is processed', () => {
  const own = new Set(['support@crm.test']);
  const ok = { status: 'Archived', from: 'cust@x.com', name: 'Hello' };
  assert.equal(skipReason(ok, own), null);
  assert.ok(skipReason({ ...ok, status: 'Sent' }, own));
  assert.ok(skipReason({ ...ok, aiStatus: 'needs_human' }, own), 'already processed');
  assert.ok(skipReason({ ...ok, from: 'support@crm.test' }, own), 'own address');
  assert.ok(skipReason({ ...ok, from: 'no-reply@shop.com' }, own));
  assert.ok(skipReason({ ...ok, from: 'noreply@shop.com' }, own));
  assert.ok(skipReason({ ...ok, from: 'newsletter@shop.com' }, own));
  assert.ok(skipReason({ ...ok, from: 'mailer-daemon@x.com' }, own));
  assert.ok(skipReason({ ...ok, name: 'Automatic reply: away' }, own));
  assert.equal(skipReason({ ...ok, from: 'reply.john@x.com' }, own), null, 'normal address is not blocked');
});

test('stub AI categorises and only drafts from the knowledge base', () => {
  const pricing = stubClassifyAndDraft({ from: 'a@b.c', subject: 'Price', body: 'How much is the Website package?', history: [] }, kb);
  assert.equal(pricing.category, 'pricing');
  assert.ok(pricing.reply.includes('USD 799'));
  assert.equal(stubClassifyAndDraft({ from: 'a@b.c', subject: 'Refund', body: 'I want my money back', history: [] }, kb).category, 'refund_legal');
  assert.equal(stubClassifyAndDraft({ from: 'a@b.c', subject: 'x', body: 'You are a lottery winner, click here to claim', history: [] }, kb).category, 'spam');
  assert.equal(stubClassifyAndDraft({ from: 'a@b.c', subject: 'Hi', body: 'zzz qqq', history: [] }, kb).confident, false);
});

test('webhook signature: valid, tampered and missing', () => {
  const body = '[{"id":"abc"}]';
  const sig = Buffer.from('wid:' + createHmac('sha256', 's3cret').update(body).digest('hex')).toString('base64');
  assert.equal(validSignature(body, sig, 's3cret'), true);
  assert.equal(validSignature(body + ' ', sig, 's3cret'), false);
  assert.equal(validSignature(body, sig, 'other'), false);
  assert.equal(validSignature(body, undefined, 's3cret'), false);
  assert.equal(validSignature(body, sig, ''), false);
});

import { contactsIn, guardContacts, unknownContacts } from '../src/ai.ts';

test('contact guard: a link, address or phone that is not in the knowledge base forces a human', () => {
  const kb2 = [{ name: 'Contact', text: 'Visit https://www.acme.test/book or write to hello@acme.test. Call +92 300 1234567. Offer ends 2026-10-31.' }];
  const reply = (t: string) => guardContacts({ category: 'inquiry', confident: true, reply: t, reason: '' }, kb2);
  assert.equal(reply('Book at acme.test/book or hello@acme.test or +92-300-1234567.').confident, true, 'same details, different formatting');
  assert.equal(reply('Pay here: http://evil.example/pay').confident, false);
  assert.equal(reply('Write to support@evil.example').confident, false);
  assert.equal(reply('Call 0900 123 456 789 now').confident, false);
  assert.equal(reply('The offer ends 2026-10-31 and costs nothing extra.').confident, true, 'a date is not a phone number');
  assert.match(reply('see www.evil.example').reason, /not in knowledge base/);
});

test('contact guard: details inside a longer text are found', () => {
  assert.deepEqual(contactsIn('Hi, click https://x.test/a?b=1. Thanks, a@b.co').sort(), ['mail:a@b.co', 'url:x.test/a?b=1']);
  assert.deepEqual(unknownContacts('nothing here, USD 799', 'anything'), []);
});

test('decide: a sender who already got the daily maximum of automatic replies goes to a person', () => {
  const rules2: Rule[] = [{ category: 'pricing', channel: 'email', autoSend: true }];
  const r = { category: 'pricing', confident: true, reply: 'USD 799', reason: '' } as AiResult;
  assert.equal(decide(r, rules2, 'email', false, 4, 5).send, true);
  assert.equal(decide(r, rules2, 'email', false, 5, 5).send, false);
  assert.equal(decide(r, rules2, 'email', false, 5, 5).aiStatus, 'needs_human');
});
