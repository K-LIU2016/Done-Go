import assert from 'node:assert/strict';
import { test } from 'node:test';
import { persistVoiceItems } from '../../web/relay/home.js';

function memoryStorage(initial) {
  const map = new Map(initial ? [['tango-donego.web.v1', JSON.stringify(initial)]] : []);
  return {
    map,
    getItem(key) { return map.get(key) ?? null; },
    setItem(key, value) { map.set(key, String(value)); },
  };
}

test('persistVoiceItems writes confirmed timed items to the existing web.v1 entries and untimed items to drafts', () => {
  const storage = memoryStorage({ v: 1, pv: 5, mode: 'real', wake: 960, entries: [], drafts: [], trials: [], fw: {} });
  const result = persistVoiceItems(storage, [
    { title: '和导师开组会', kind: 'necessary', date: '2026-10-26', start: '15:00', end: '16:00', priority: 2 },
    { title: '整理材料', kind: 'create', date: '2026-10-26', start: null, end: null, priority: 3 },
  ], new Date('2026-10-25T10:00:00+08:00'));
  assert.equal(result.ok, true);
  assert.equal(result.added, 2);
  const saved = JSON.parse(storage.getItem('tango-donego.web.v1'));
  assert.equal(saved.entries.length, 1);
  assert.equal(saved.entries[0].title, '和导师开组会');
  assert.equal(saved.entries[0].prio, 2);
  assert.equal(saved.drafts.length, 1);
  assert.equal(saved.drafts[0].title, '整理材料');
});

test('persistVoiceItems rejects malformed storage without claiming an item was added', () => {
  const storage = { getItem() { return '{bad'; }, setItem() { throw new Error('blocked'); } };
  const result = persistVoiceItems(storage, [{ title: '事项', kind: 'create' }], new Date('2026-10-25T10:00:00+08:00'));
  assert.equal(result.ok, false);
  assert.equal(result.added, 0);
});
