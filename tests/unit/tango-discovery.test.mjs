import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const now = Date.parse('2026-10-17T00:00:00Z');
const rss = (date = 'Fri, 16 Oct 2026 10:00:00 GMT', url = 'https://huggingface.co/blog/model') => `<rss><channel><item><title>AI model research &amp; learning</title><link>${url}</link><pubDate>${date}</pubDate><description><![CDATA[<p>A new AI model for work</p>]]></description></item></channel></rss>`;

test('discovery parses safe recent RSS and Atom and excludes stale, future and unsafe links', async () => {
  const { parseFeed } = await import('../../scripts/ai-discovery.mjs');
  const source = { id: 'news', type: 'news', source: 'Hugging Face', url: 'https://huggingface.co/blog/feed.xml' };
  const items = parseFeed(rss(), source, now);
  assert.equal(items.length, 1); assert.equal(items[0].title, 'AI model research & learning');
  assert.equal(items[0].excerpt, 'A new AI model for work');
  assert.equal(items[0].retrievedAt, new Date(now).toISOString());
  assert.equal(parseFeed(rss('Fri, 01 May 2026 10:00:00 GMT'), source, now).length, 0);
  assert.equal(parseFeed(rss('Fri, 30 Oct 2026 10:00:00 GMT'), source, now).length, 0);
  assert.equal(parseFeed(rss(undefined, 'javascript:alert(1)'), source, now).length, 0);
  const atom = '<feed><entry><title>AI paper</title><link rel="alternate" href="https://example.com/paper"/><published>2026-10-16T10:00:00Z</published><summary>AI research</summary></entry></feed>';
  assert.equal(parseFeed(atom, source, now)[0].url, 'https://example.com/paper');
});

test('discovery coalesces requests, uses fixed sources and caches for fifteen minutes', async () => {
  const { createDiscovery, DISCOVERY_SOURCES } = await import('../../scripts/ai-discovery.mjs');
  let calls = 0, active = 0, peak = 0, time = now;
  const app = createDiscovery({ now: () => time, fetch: async (url, options) => {
    assert.ok(DISCOVERY_SOURCES.some(source => source.url === url)); assert.equal(options.redirect, 'error');
    calls++; active++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 2)); active--;
    return new Response(rss());
  } });
  const [a, b] = await Promise.all([app.get('all'), app.get('research')]);
  assert.ok(a.items.length > 0); assert.ok(b.items.length > 0);
  assert.equal(calls, DISCOVERY_SOURCES.length); assert.ok(peak <= 2);
  await app.get('all'); assert.equal(calls, DISCOVERY_SOURCES.length);
  time += 15 * 60 * 1000 + 1;
  await app.get('all'); assert.equal(calls, DISCOVERY_SOURCES.length * 2);
  await assert.rejects(app.get('https://evil.example'), e => e.code === 'TANGO_DISCOVERY_TOPIC_INVALID');
});

test('discovery failures and empty sources remain explicit without fabricated items', async () => {
  const { createDiscovery } = await import('../../scripts/ai-discovery.mjs');
  const app = createDiscovery({ now: () => now, fetch: async () => new Response('private raw failure', { status: 403 }) });
  const report = await app.get('all');
  assert.deepEqual(report.items, []); assert.equal(report.stale, true); assert.ok(report.failures.length > 0);
  assert.equal(JSON.stringify(report).includes('private raw failure'), false);
  const empty = await createDiscovery({ now: () => now, fetch: async () => new Response('<rss><channel></channel></rss>') }).get('all');
  assert.deepEqual(empty.items, []); assert.ok(empty.failures.every(f => f.code === 'no-recent-items'));
});

test('discovery only labels audio entries as podcasts and strips unsafe markup', async () => {
  const { parseFeed } = await import('../../scripts/ai-discovery.mjs');
  const source = { id: 'pod', type: 'podcast', source: 'AI Podcast' };
  assert.equal(parseFeed(rss(), source, now).length, 0);
  const xml = rss().replace('</item>', '<enclosure url="https://example.com/audio.mp3" type="audio/mpeg"/></item>');
  assert.equal(parseFeed(xml, source, now)[0].type, 'podcast');
  assert.equal(parseFeed('<!DOCTYPE rss [<!ENTITY x SYSTEM "file:///etc/passwd">]>' + xml, source, now).length, 0);
});

test('discovery bounds large or hanging feeds and returns explicitly stale cached content on later failure', async () => {
  const { createDiscovery } = await import('../../scripts/ai-discovery.mjs');
  const oversized = await createDiscovery({ now: () => now, fetch: async () => new Response('x'.repeat(1600 * 1024)) }).get('all');
  assert.ok(oversized.failures.every(failure => failure.code === 'feed-too-large'));
  const timeout = await createDiscovery({ now: () => now, timeoutMs: 5, fetch: async () => new Promise(() => {}) }).get('all');
  assert.ok(timeout.failures.every(failure => failure.code === 'feed-timeout'));
  let time = now, fail = false;
  const app = createDiscovery({ now: () => time, fetch: async () => fail ? new Response('bad', { status: 503 }) : new Response(rss()) });
  const first = await app.get('all'); assert.ok(first.items.length > 0);
  const firstRetrievedAt = first.items[0].retrievedAt;
  assert.equal(firstRetrievedAt, new Date(time).toISOString());
  time += 16 * 60 * 1000; fail = true;
  const stale = await app.get('all'); assert.equal(stale.stale, true); assert.ok(stale.items.length > 0);
  assert.equal(stale.retrievedAt, new Date(time).toISOString(), 'response timestamp records the latest retrieval attempt');
  assert.equal(stale.items[0].retrievedAt, firstRetrievedAt, 'cached item keeps its original successful retrieval timestamp');
  time += 46 * 24 * 60 * 60 * 1000;
  assert.equal((await app.get('all')).items.length, 0);
});

test('topic selection happens before the thirty-item response limit and survives shared cache reuse', async () => {
  const { createDiscovery } = await import('../../scripts/ai-discovery.mjs');
  const entry = (id, title, date) => `<item><title>${title}</title><link>https://example.com/${id}</link><pubDate>${date}</pubDate><description>AI content</description></item>`;
  const xml = '<rss><channel>' + Array.from({ length: 35 }, (_, i) => entry(i, 'AI model research', '2026-10-16T10:00:00Z')).join('') + entry('learn', 'AI learning guide', '2026-10-15T10:00:00Z') + '</channel></rss>';
  let calls = 0;
  const app = createDiscovery({ now: () => now, fetch: async url => { calls++; return new Response(url.includes('openai.com') ? xml : '<rss><channel></channel></rss>'); } });
  assert.equal((await app.get('all')).items.length, 30);
  const learning = await app.get('learning');
  assert.equal(learning.items.length, 1);
  assert.equal(learning.items[0].url, 'https://example.com/learn');
  assert.equal((await app.get('research')).items.length, 30);
  assert.equal((await app.get('learning')).items.length, 1);
  assert.equal(calls, 4);
});

test('malformed unterminated items and angle-heavy text parse within an isolated process safety limit', () => {
  const code = `
    import { parseFeed } from './scripts/ai-discovery.mjs';
    const source = { id: 'test', type: 'news', source: 'test' };
    const time = Date.parse('2026-10-17T00:00:00Z');
    const bad = '<rss>' + '<item>'.repeat(150000) + '</rss>';
    const blockItems = parseFeed(bad, source, time).length;
    const text = '<rss><channel><item><title><![CDATA[' + '<'.repeat(200000) + ']]></title><link>https://example.com/ai</link><pubDate>2026-10-16T10:00:00Z</pubDate><description>AI research</description></item></channel></rss>';
    const textItems = parseFeed(text, source, time).length;
    console.log(JSON.stringify({ bytes: Buffer.byteLength(bad), blockItems, textItems }));
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: fileURLToPath(new URL('../../', import.meta.url)), encoding: 'utf8', timeout: 4000 });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { bytes: 900011, blockItems: 0, textItems: 1 });
});
