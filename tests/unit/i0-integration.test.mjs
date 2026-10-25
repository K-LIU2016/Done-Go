import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAssistant, validateStoryText } from '../../scripts/ai-assistant.mjs';
import { createTangoServer } from '../../scripts/serve-tango.mjs';

const config = { provider: 'openai', url: 'https://api.example.com/v1/chat/completions', model: 'auto', key: 'fixture-key' };
const reply = text => new Response(JSON.stringify({ choices: [{ message: { content: text } }] }));

test('story mode uses the light tier and rejects forbidden or overlong narrative output', async () => {
  const payloads = [];
  const assistant = createAssistant({
    config,
    env: { TANGO_AI_MODEL_LIGHT: 'story-light' },
    fetch: async (_url, options) => {
      payloads.push(JSON.parse(options.body));
      return reply('本期记下 8 件事\n留白让人更好');
    },
  });
  await assert.rejects(assistant.chat({ mode: 'story', prompt: '统计数字：8 件事\n共 2 行' }), error => error.code === 'TANGO_AI_RESPONSE_INVALID');
  assert.equal(payloads[0].model, 'story-light');
  assert.equal(validateStoryText('本期记下 8 件事\n本周完成 2 次', 2), true);
  assert.equal(validateStoryText('给时间一点留白', 1), false);
});

test('story polish endpoint validates the boundary and falls back to templates on assistant failure', async t => {
  const assistant = {
    configuration: () => ({ available: true }),
    chat: async () => { throw Object.assign(new Error('upstream'), { code: 'TANGO_AI_UPSTREAM_FAILED' }); },
  };
  const server = createTangoServer({ assistant });
  t.after(() => new Promise(resolve => server.close(resolve)));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const response = await fetch(`http://127.0.0.1:${port}/api/story/polish`, {
    method: 'POST',
    headers: { origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json' },
    body: JSON.stringify({ items: [{ kind: 'title', fallback: '本期记下 8 件事', context: '事项 8；接力 2' }] }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { texts: ['本期记下 8 件事'], fallback: true });
});
