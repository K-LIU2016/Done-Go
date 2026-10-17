import { createHash } from 'node:crypto';
import { assistantError, boundedOperation, readLimited } from './ai-assistant.mjs';

export const DISCOVERY_SOURCES = Object.freeze([
  { id: 'openai', type: 'news', source: 'OpenAI News', url: 'https://openai.com/news/rss.xml' },
  { id: 'huggingface', type: 'news', source: 'Hugging Face Blog', url: 'https://huggingface.co/blog/feed.xml' },
  { id: 'google-research', type: 'news', source: 'Google Research', url: 'https://research.google/blog/rss/' },
  { id: 'latent-space', type: 'podcast', source: 'Latent Space', url: 'https://www.latent.space/feed' },
].map(Object.freeze));
const MAX_AGE = 45 * 24 * 60 * 60 * 1000;
const MAX_FEED_ITEMS = 120;
const MAX_CANDIDATES = MAX_FEED_ITEMS * DISCOVERY_SOURCES.length;
const TOPICS = { all: null, research: /research|paper|science|model|reasoning|研究|论文|模型/i, work: /agent|code|coding|work|tool|product|工作|编程|工具|智能体/i, learning: /learn|education|tutorial|guide|course|学习|教育|教程/i };
function plain(value) {
  value = value.split('<![CDATA[').join('').split(']]>').join('').replace(/&#(x[\da-f]+|\d+);/gi, (_match, n) => { const code = n[0].toLowerCase() === 'x' ? parseInt(n.slice(1), 16) : Number(n); return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ''; }).replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (_match, n) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }[n]));
  const parts = []; let cursor = 0;
  for (;;) {
    const start = value.indexOf('<', cursor);
    if (start < 0) break;
    const end = value.indexOf('>', start + 1);
    if (end < 0) break;
    parts.push(value.slice(cursor, start), ' '); cursor = end + 1;
  }
  parts.push(value.slice(cursor));
  return parts.join('').replace(/\s+/g, ' ').trim();
}
// Every cursor advances past the token it scans; malformed nesting cannot cause
// repeated searches over the remainder of a feed. CDATA/comments are opaque.
function walkTags(xml, visit) {
  let cursor = 0;
  while (cursor < xml.length) {
    const start = xml.indexOf('<', cursor);
    if (start < 0) return;
    if (xml.startsWith('<![CDATA[', start) || xml.startsWith('<!--', start)) {
      const cdata = xml.startsWith('<![CDATA[', start), marker = cdata ? ']]>' : '-->';
      const end = xml.indexOf(marker, start + (cdata ? 9 : 4));
      if (end < 0) return;
      cursor = end + marker.length; continue;
    }
    const end = xml.indexOf('>', start + 1);
    if (end < 0) return;
    cursor = end + 1;
    let token = xml.slice(start + 1, end).trim();
    const closing = token[0] === '/'; if (closing) token = token.slice(1).trimStart();
    const match = token.match(/^([A-Za-z][A-Za-z0-9:_.-]*)/);
    if (!match) continue;
    if (visit({ name: match[1].toLowerCase(), closing, attributes: token.slice(match[1].length), start, end: cursor, selfClosing: token.endsWith('/') }) === false) return;
  }
}
function attribute(raw, name) {
  const lower = raw.toLowerCase(); let cursor = 0;
  for (;;) {
    const start = lower.indexOf(name, cursor);
    if (start < 0) return '';
    cursor = start + name.length;
    if (start > 0 && !/\s/.test(raw[start - 1])) continue;
    let index = cursor; while (/\s/.test(raw[index] || '') && index < raw.length) index++;
    if (raw[index++] !== '=') continue;
    while (/\s/.test(raw[index] || '') && index < raw.length) index++;
    const quote = raw[index++]; if (quote !== '"' && quote !== "'") continue;
    const end = raw.indexOf(quote, index);
    return end < 0 ? '' : raw.slice(index, end);
  }
}
function feedBlocks(xml) {
  const blocks = []; let active = null;
  walkTags(xml, token => {
    if (token.name !== 'item' && token.name !== 'entry') return;
    if (!token.closing && !token.selfClosing) active = { name: token.name, start: token.end };
    else if (token.closing && active?.name === token.name) {
      blocks.push(xml.slice(active.start, token.start)); active = null;
      if (blocks.length >= MAX_FEED_ITEMS) return false;
    }
  });
  return blocks;
}
function feedFields(block) {
  const fields = Object.create(null); let active = null;
  const names = new Set(['title', 'description', 'summary', 'content', 'pubdate', 'published', 'updated', 'dc:date', 'link']);
  walkTags(block, token => {
    if (active) {
      if (token.closing && token.name === active.name) { fields[active.name] = block.slice(active.start, token.start); active = null; }
      return;
    }
    if (token.closing) return;
    if (token.name === 'enclosure' && attribute(token.attributes, 'type').toLowerCase().startsWith('audio/') || token.name === 'itunes:duration') fields.audio = true;
    if (token.name === 'link') {
      const href = attribute(token.attributes, 'href'), rel = attribute(token.attributes, 'rel').toLowerCase();
      if (href) { if (!fields.link && rel !== 'self' && rel !== 'enclosure') fields.link = href; return; }
    }
    if (names.has(token.name) && fields[token.name] == null && !token.selfClosing) active = { name: token.name, start: token.end };
  });
  return fields;
}
export function parseFeed(xml, source, now = Date.now()) {
  if (typeof xml !== 'string' || /<!DOCTYPE|<!ENTITY/i.test(xml) || !/<(?:rss|feed)\b/i.test(xml)) return [];
  const blocks = feedBlocks(xml);
  const items = [];
  for (const block of blocks) {
    const fields = feedFields(block);
    const title = plain(fields.title || '').slice(0, 180), excerpt = plain(fields.description || fields.summary || fields.content || '').slice(0, 200);
    const published = Date.parse(plain(fields.pubdate || fields.published || fields.updated || fields['dc:date'] || ''));
    if (!title || !Number.isFinite(published) || published > now || now - published > MAX_AGE) continue;
    const link = plain(fields.link || '');
    let url; try { url = new URL(link); if (url.protocol !== 'https:' || url.username || url.password) continue; } catch { continue; }
    if (source.type === 'news' && !/\bAI\b|artificial intelligence|machine learning|deep learning|\bLLM\b|GPT|Claude|Gemini|robot|模型|人工智能/i.test(title + ' ' + excerpt)) continue;
    // A mixed newsletter feed counts as podcast only when this entry has audio.
    if (source.type === 'podcast' && !fields.audio) continue;
    items.push({ id: createHash('sha256').update(source.id + ':' + url.href).digest('hex').slice(0, 24), type: source.type, title, url: url.href, source: source.source, publishedAt: new Date(published).toISOString(), excerpt });
  }
  return items;
}

export function createDiscovery(options = {}) {
  const send = options.fetch || globalThis.fetch, now = options.now || Date.now;
  let cache = null, expires = 0, inFlight = null;
  async function refresh() {
    const time = now(), groups = new Array(DISCOVERY_SOURCES.length); let cursor = 0;
    async function worker() {
      while (cursor < DISCOVERY_SOURCES.length) {
        const index = cursor++, source = DISCOVERY_SOURCES[index];
        try {
          const items = await boundedOperation(async signal => {
            const response = await send(source.url, { redirect: 'error', signal, headers: { Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml', 'User-Agent': 'TangoDiscovery/1.0' } });
            if (!response.ok) { await response.body?.cancel().catch(() => {}); throw new Error('feed-unavailable'); }
            return parseFeed(await readLimited(response, 1536 * 1024, signal), source, time);
          }, options.timeoutMs || 8000);
          groups[index] = { items, failure: items.length ? null : { source: source.source, code: 'no-recent-items' } };
        } catch (error) { groups[index] = { items: [], failure: { source: source.source, code: error.code === 'TANGO_AI_TIMEOUT' ? 'feed-timeout' : error.code === 'TANGO_AI_RESPONSE_TOO_LARGE' ? 'feed-too-large' : 'feed-unavailable' } }; }
      }
    }
    await Promise.all([worker(), worker()]);
    const failures = groups.map(group => group.failure).filter(Boolean), fresh = groups.flatMap(group => group.items);
    const fallback = cache && failures.length ? cache.items.filter(item => time - Date.parse(item.publishedAt) <= MAX_AGE && failures.some(failure => failure.source === item.source)) : [];
    const seen = new Set(), items = fresh.concat(fallback).sort((a, b) => b.publishedAt.localeCompare(a.publishedAt)).filter(item => { if (seen.has(item.url)) return false; seen.add(item.url); return true; }).slice(0, MAX_CANDIDATES);
    cache = { items, retrievedAt: new Date(time).toISOString(), stale: failures.length > 0, failures }; expires = time + 15 * 60 * 1000;
    return cache;
  }
  return { async get(topic = 'all') {
    if (typeof topic !== 'string' || !Object.prototype.hasOwnProperty.call(TOPICS, topic)) throw assistantError('TANGO_DISCOVERY_TOPIC_INVALID', 400);
    if (!cache || now() >= expires) {
      if (!inFlight) inFlight = refresh().finally(() => { inFlight = null; });
      await inFlight;
    }
    const filter = TOPICS[topic];
    return { ...cache, items: cache.items.filter(item => now() - Date.parse(item.publishedAt) <= MAX_AGE && (!filter || filter.test(item.title + ' ' + item.excerpt))).slice(0, 30).map(item => ({ ...item })), failures: cache.failures.map(failure => ({ ...failure })) };
  } };
}
