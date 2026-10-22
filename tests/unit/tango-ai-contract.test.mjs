import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAssistant } from '../../scripts/ai-assistant.mjs';
import { PARSE_KINDS, validateAndExtract } from '../../web/ai-parse.js';

// R1 leftover contract closure + D20 tier wiring.
//
// The server's PARSE_SYSTEM may only teach what web/ai-parse.js accepts:
// exactly the PARSE_KINDS enum and the 30-character title cap (TITLE_MAX).
// Anything else would make the model emit replies the client must discard.
// D20: TANGO_AI_MODEL_LIGHT / TANGO_AI_MODEL_STANDARD pin the light/standard
// tiers while heavy keeps the configured model (production: auto).

const config = { provider: 'openai', url: 'https://api.example.com/v1/chat/completions', model: 'auto', key: 'synthetic-test-key' };
const openaiReply = text => new Response(JSON.stringify({ choices: [{ message: { content: text } }] }));
const pad = n => (n < 10 ? '0' : '') + n;
const ymd = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());

async function capturedSystem(mode, prompt) {
  let system;
  const app = createAssistant({ config, env: {}, fetch: async (_url, options) => {
    const payload = JSON.parse(options.body);
    system = payload.messages[0].content;
    return openaiReply('ok');
  } });
  await app.chat({ prompt, mode });
  return system;
}

test('PARSE_SYSTEM teaches exactly the client kind enum and title cap', async () => {
  const system = await capturedSystem('parse', '<user_input>晚上10点复盘会</user_input>');
  for (const kind of PARSE_KINDS) assert.ok(system.includes(kind), 'system must teach ' + kind);
  assert.match(system, new RegExp(PARSE_KINDS.join('.*')), 'kinds must appear in the client canonical order');
  for (const stale of ['"task"', '"event"', '"reminder"']) assert.ok(!system.includes(stale), 'stale kind ' + stale + ' must not be taught');
  const cap = system.match(/不超过 (\d+) 字/);
  assert.ok(cap, 'system must state the title cap');
  assert.equal(Number(cap[1]), 30, 'the taught title cap must equal the client TITLE_MAX');
});

test('the client truncation boundary matches the cap the server teaches', () => {
  const now = new Date(), today = ymd(now);
  const reply = title => JSON.stringify({ date: today, start: null, end: null, title, kind: PARSE_KINDS[0], prio: 3 });
  const exact = validateAndExtract(reply('标'.repeat(30)), '整理一下', null, now);
  assert.equal(exact ? exact.title.length : -1, 30);
  const trimmed = validateAndExtract(reply('标'.repeat(40)), '整理一下', null, now);
  assert.equal(trimmed ? trimmed.title.length : -1, 30, 'titles over the cap are truncated, never rejected');
});

test('every kind PARSE_SYSTEM teaches survives client validation', () => {
  const now = new Date(), today = ymd(now);
  for (const kind of PARSE_KINDS) {
    const item = validateAndExtract(JSON.stringify({ date: today, start: '09:00', end: null, title: '事项', kind, prio: 2 }), '今天9点的事项', null, now);
    assert.equal(item && item.kind, kind);
  }
});

test('D20 wiring: light/standard tiers follow TANGO_AI_MODEL_LIGHT/STANDARD, heavy stays on the configured model', async () => {
  const payloads = [];
  const app = createAssistant({ config, env: { TANGO_AI_MODEL_LIGHT: 'glm-5.3-flash', TANGO_AI_MODEL_STANDARD: 'glm-5.3-flash' }, fetch: async (_url, options) => {
    payloads.push(JSON.parse(options.body));
    return openaiReply('ok');
  } });
  const expected = { chat: 'auto', priorities: 'glm-5.3-flash', models: 'glm-5.3-flash', reflection: 'glm-5.3-flash', test: 'glm-5.3-flash', parse: 'glm-5.3-flash', prompt: 'glm-5.3-flash' };
  const prompts = { parse: '<user_input>晚上10点复盘会</user_input>', prompt: 'USER_REQUEST_JSON\n{"userRequest":{"title":"写周报"}}' };
  for (const mode of Object.keys(expected)) await app.chat({ prompt: prompts[mode] || 'hello', mode });
  assert.deepEqual(Object.fromEntries(Object.keys(expected).map((mode, index) => [mode, payloads[index].model])), expected);
  let heavyPayload;
  const heavy = createAssistant({ config, env: { TANGO_AI_MODEL_HEAVY: 'heavy-fixture' }, fetch: async (_url, options) => { heavyPayload = JSON.parse(options.body); return openaiReply('ok'); } });
  await heavy.chat({ prompt: 'hello', mode: 'chat' });
  assert.equal(heavyPayload.model, 'heavy-fixture');
});
