import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAssistant } from '../../scripts/ai-assistant.mjs';

const config = { provider: 'openai', url: 'https://api.example.com/v1/chat/completions', model: 'test-model', key: 'private-key' };

test('streamChat accepts typed content deltas and a clean close without an explicit done marker', async () => {
  const frames = [
    { choices: [{ delta: { reasoning_content: 'internal reasoning is ignored' } }] },
    { choices: [{ delta: { content: [{ type: 'text', text: '你好' }, { type: 'input_text', text: 'ignored' }] } }] },
    { choices: [{ delta: { content: [{ type: 'text', text: '，探戈' }] } }] }
  ];
  const body = new ReadableStream({ start(controller) {
    for (const frame of frames) controller.enqueue(new TextEncoder().encode('data: ' + JSON.stringify(frame) + '\n\n'));
    controller.close();
  } });
  const app = createAssistant({ config, fetch: async () => new Response(body) });
  const chunks = [];
  for await (const chunk of app.streamChat({ prompt: 'hello', mode: 'chat', stream: true })) chunks.push(chunk);
  assert.deepEqual(chunks, ['你好', '，探戈']);
});
