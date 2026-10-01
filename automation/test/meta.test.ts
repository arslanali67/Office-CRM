import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { parseMetaPayload, validMetaSignature, windowOpen, toEspoDate } from '../src/meta.ts';

const fb = (messaging: unknown[]) => ({ object: 'page', entry: [{ id: 'PAGE', time: 1, messaging }] });

test('meta signature: valid, tampered, wrong secret, missing, wrong prefix', () => {
  const body = '{"object":"page"}';
  const sig = 'sha256=' + createHmac('sha256', 'app-secret').update(body).digest('hex');
  assert.equal(validMetaSignature(body, sig, 'app-secret'), true);
  assert.equal(validMetaSignature(body + ' ', sig, 'app-secret'), false);
  assert.equal(validMetaSignature(body, sig, 'other'), false);
  assert.equal(validMetaSignature(body, undefined, 'app-secret'), false);
  assert.equal(validMetaSignature(body, sig.replace('sha256=', 'sha1='), 'app-secret'), false);
  assert.equal(validMetaSignature(body, sig, ''), false);
});

test('parse: Facebook and Instagram messages, channel from `object`', () => {
  const ev = { sender: { id: 'CUST' }, recipient: { id: 'PAGE' }, timestamp: 1700000000000, message: { mid: 'm1', text: 'hi' } };
  const [a] = parseMetaPayload(fb([ev]));
  assert.deepEqual([a.channel, a.customerId, a.mid, a.text, a.isEcho], ['facebook', 'CUST', 'm1', 'hi', false]);
  const [b] = parseMetaPayload({ object: 'instagram', entry: [{ id: 'IG', messaging: [ev] }] });
  assert.equal(b.channel, 'instagram');
});

test('parse: echoes keep the customer as recipient, attachments flagged, non-message events dropped', () => {
  const echo = { sender: { id: 'PAGE' }, recipient: { id: 'CUST' }, timestamp: 1, message: { mid: 'm2', text: 'our reply', is_echo: true } };
  const att = { sender: { id: 'CUST' }, recipient: { id: 'PAGE' }, timestamp: 2, message: { mid: 'm3', attachments: [{ type: 'image' }] } };
  const delivery = { sender: { id: 'CUST' }, recipient: { id: 'PAGE' }, delivery: { mids: ['m2'] } };
  const out = parseMetaPayload(fb([echo, att, delivery]));
  assert.equal(out.length, 2);
  assert.deepEqual([out[0].isEcho, out[0].customerId], [true, 'CUST']);
  assert.deepEqual([out[1].text, out[1].hasAttachment], ['', true]);
});

test('parse: garbage and unknown objects give nothing', () => {
  assert.deepEqual(parseMetaPayload(null), []);
  assert.deepEqual(parseMetaPayload({ object: 'whatsapp', entry: [] }), []);
  assert.deepEqual(parseMetaPayload({ object: 'page' }), []);
  assert.deepEqual(parseMetaPayload(fb([{ sender: {}, message: { mid: 'x', text: 'y' } }])), [], 'no sender id');
});

test('24-hour window', () => {
  const now = Date.parse('2026-10-01T12:00:00Z');
  assert.equal(windowOpen('2026-10-01 12:00:01', now), true);
  assert.equal(windowOpen('2026-10-01 12:00:00', now), false);
  assert.equal(windowOpen('2026-09-30 11:00:00', now), false);
  assert.equal(windowOpen(null, now), false);
  assert.equal(windowOpen('garbage', now), false);
  assert.equal(toEspoDate(Date.parse('2026-10-01T12:34:56Z') + 24 * 3600e3), '2026-10-02 12:34:56');
});
