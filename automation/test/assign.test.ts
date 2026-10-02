import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OWNER_ONLY, pick } from '../src/assign.ts';

test('pick: nobody available gives nobody', () => {
  assert.equal(pick([]), undefined);
});

test('pick: the employee with the fewest waiting messages gets the next one', () => {
  assert.equal(pick([{ id: 'a', load: 3 }, { id: 'b', load: 1 }, { id: 'c', load: 2 }]), 'b');
  assert.equal(pick([{ id: 'a', load: 0 }]), 'a');
});

test('pick: ties are spread at random, never always the first', () => {
  const c = [{ id: 'a', load: 1 }, { id: 'b', load: 1 }, { id: 'c', load: 5 }];
  assert.equal(pick(c, () => 0), 'a');
  assert.equal(pick(c, () => 0.99), 'b');
  const seen = new Set(Array.from({ length: 50 }, () => pick(c)));
  assert.deepEqual([...seen].sort(), ['a', 'b'], 'the overloaded one is never picked');
});

test('the owner keeps complaints, refund/legal and spam', () => {
  assert.deepEqual([...OWNER_ONLY].sort(), ['complaint', 'refund_legal', 'spam']);
});
