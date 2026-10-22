import assert from 'node:assert/strict';
import { test } from 'node:test';

import '../../web/ai-prompt.js';

const { buildPromptRequest, renderPromptCard } = globalThis.TangoAIPrompt;
assert.ok(globalThis.TangoAIPrompt, 'web/ai-prompt.js must expose TangoAIPrompt');

function userRequestOf(prompt) {
  const start = prompt.indexOf('\nUSER_REQUEST_JSON\n') + '\nUSER_REQUEST_JSON\n'.length;
  const end = prompt.indexOf('\nCONTEXT_JSON\n');
  return JSON.parse(prompt.slice(start, end));
}
function contextOf(prompt) {
  return JSON.parse(prompt.slice(prompt.indexOf('\nCONTEXT_JSON\n') + '\nCONTEXT_JSON\n'.length));
}

test('buildPromptRequest assembles a prompt-mode request from the title and allow-listed context only', () => {
  const request = buildPromptRequest('完成论文大纲', {
    kind: 'create',
    priority: 2,
    notes: '周五前交初稿',
    date: '2026-10-23',
    start: '09:00',
    end: '10:00',
    // 未经授权/白名单外的字段：绝不能进入请求
    id: 'entry:private',
    fingerprint: 'tf1-deadbeef',
    secretNote: '私密备注不许外发',
    done: false
  });
  assert.equal(request.mode, 'prompt');
  assert.equal(request.stream, false);
  assert.deepEqual(
    Object.keys(request.context).sort(),
    ['date', 'end', 'kind', 'notes', 'priority', 'start']
  );
  assert.equal(request.context.notes, '周五前交初稿');
  assert.deepEqual(contextOf(request.prompt), request.context);
  assert.equal(userRequestOf(request.prompt).userRequest.title, '完成论文大纲');
  assert.doesNotMatch(request.prompt, /私密备注|tf1-deadbeef|entry:private/);
});

test('invalid consented values are dropped instead of forwarded', () => {
  const request = buildPromptRequest('跑步 30 分钟', {
    kind: 'party',
    priority: 9,
    notes: '',
    date: '2026-13-40',
    start: '9:00',
    end: '24:30'
  });
  assert.deepEqual(request.context, {});
  const partial = buildPromptRequest('跑步 30 分钟', {
    kind: 'restore',
    priority: '3',
    notes: 'x'.repeat(1001),
    date: '2026-10-23',
    start: '09:00:00'
  });
  assert.deepEqual(partial.context, { kind: 'restore', date: '2026-10-23' });
});

test('a missing or oversized title is rejected loudly, a bare title still works', () => {
  assert.throws(() => buildPromptRequest('', {}), /TANGO_AI_PROMPT_INVALID: title/);
  assert.throws(() => buildPromptRequest('   ', null), /TANGO_AI_PROMPT_INVALID: title/);
  assert.throws(() => buildPromptRequest('x'.repeat(201), {}), /TANGO_AI_PROMPT_INVALID: title/);
  assert.throws(() => buildPromptRequest(42, {}), /TANGO_AI_PROMPT_INVALID: title/);
  assert.throws(() => buildPromptRequest('ok', 'not an object'), /TANGO_AI_PROMPT_INVALID: context/);
  const bare = buildPromptRequest('写周报');
  assert.deepEqual(bare.context, {});
  assert.deepEqual(contextOf(bare.prompt), {});
  assert.equal(userRequestOf(bare.prompt).userRequest.title, '写周报');
});

test('title text is JSON-escaped inside the prompt envelope', () => {
  const title = '写"周报"《要点》\\ 反斜杠';
  assert.equal(userRequestOf(buildPromptRequest(title).prompt).userRequest.title, title);
});

test('renderPromptCard returns three steps, the copyable prompt and the fixed disclaimer', () => {
  const card = renderPromptCard('目标：完成论文大纲。步骤：一、列章节；二、填要点；三、收口。完成标准：大纲过导师一审。', { model: 'auto' });
  assert.equal(card.v, 1);
  assert.equal(card.disclaimer, 'AI 生成 · 未实测');
  assert.equal(card.steps.length, 3);
  assert.match(card.steps[0], /^复制/);
  assert.match(card.prompt, /完成论文大纲/);
  assert.equal(card.model, 'auto');
  assert.equal(renderPromptCard('提示词正文', { model: 123 }).model, '');
  assert.equal(renderPromptCard('提示词正文', {}).model, '');
});

test('LLM failure or timeout renders null instead of a fake card', () => {
  assert.equal(renderPromptCard('提示词正文', { error: 'timeout' }), null);
  assert.equal(renderPromptCard('提示词正文', { ok: false }), null);
  assert.equal(renderPromptCard(null, { model: 'auto' }), null);
  assert.equal(renderPromptCard('', {}), null);
  assert.equal(renderPromptCard('   \n  ', {}), null);
  assert.equal(renderPromptCard('x'.repeat(24001), {}), null);
});

test('reasoning tags and stray code fences are stripped from the copyable prompt', () => {
  const card = renderPromptCard('<think>推理过程</think>\n```\n目标：完成论文大纲。\n```', {});
  assert.equal(card.prompt, '目标：完成论文大纲。');
  assert.equal(card.prompt.indexOf('<think>'), -1);
  assert.equal(renderPromptCard('<think>只有推理没有答案', {}), null);
});
