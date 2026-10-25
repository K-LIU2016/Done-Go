import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HOME_SLOT_IDS, renderHomeSlots, hasHomeSlots } from '../../web/relay/slots.js';

test('home slot contract exposes banner and next-action mounts', () => {
  assert.deepEqual(HOME_SLOT_IDS, ['relay-home-banner', 'relay-home-next']);
  const html = renderHomeSlots();
  assert.match(html, /id="relay-home-banner"/);
  assert.match(html, /id="relay-home-next"/);
  assert.equal(hasHomeSlots(html), true);
});

test('home slot contract rejects markup missing either named slot', () => {
  assert.equal(hasHomeSlots('<div id="relay-home-banner"></div>'), false);
  assert.equal(hasHomeSlots('<div id="relay-home-next"></div>'), false);
});
