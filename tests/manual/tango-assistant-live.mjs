// Opt-in: makes four billable requests through the already configured local server.
// Uses synthetic fixtures only. Never reads credentials, browser storage or user records.
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const scope = { window: {} };
vm.runInNewContext(await readFile(new URL('../../web/assistant-core.js', import.meta.url), 'utf8'), scope);
const core = scope.window.TangoAssistant;
const session = { v: 1, messages: [], notes: '合成验收数据：任务截止时间为11:00，先保留午间休息。', useChatForSuggestions: false };
const task = { id: 'entry:synthetic-paper', title: '合成验收：论文修改', date: '2026-10-17', start: '09:00', end: '10:00', prio: 3, kind: 'create', done: false };
const evidence = [{ modelId: 'gpt-5.4', availability: 'available' }, { modelId: 'claude-sonnet-5.5', availability: 'unavailable' }, { modelId: 'gemini-3.1-pro-preview', availability: 'unavailable' }];
const metrics = { period: { from: '2026-10-17', to: '2026-10-17' }, dataMode: 'demo', samples: 1, pending: 0, before: 60, after: 45, difference: 15, recording: 2, unknownRecording: 0, netDifference: 13, preparation: 5, execution: 30, checking: 8, rework: 2, timeUse: { create: 45, connect: 30, restore: 20 }, personalTime: { reserved: 15, confirmedUsed: 10, unconfirmed: 0, taskLinkedUsed: 10 } };
const requests = [
  ['chat', '这是合成连通验收，不是真实生活记录。请用一两句话陪我理清今天的安排，先问一个问题。'],
  ['priorities', '这是合成验收事项，截止11:00，必须先完成才能提交；我已决定优先级1、分类create。请对已共享事项给出这一条待本人确认的建议，理由注明截止与依赖。'],
  ['models', '这是合成验收。共享事项是短文润色，资料可以分享，预算已确认，gpt-5.4账户已核验可用。请给这一事项一条modelId候选建议；不必修改优先级和分类，不声称已证明任何型号最优。'],
  ['reflection', '这是合成验收。请根据示例汇总简短提出一个反思问题，说明不能把计划差值当作AI因果收益，也不能把示例当本人真实数据。'],
];
async function verify([mode, message]) {
  const context = core.buildContext({ mode, session, tasks: [task], metrics, modelEvidence: evidence, includeTasks: mode === 'priorities' || mode === 'models', includeMetrics: mode === 'reflection', includeNotes: true });
  const prompt = core.buildPrompt({ mode, message, context });
  const started = Date.now();
  try {
    const response = await fetch('http://localhost:5207/api/assistant/chat', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:5207' }, body: JSON.stringify({ prompt }), signal: AbortSignal.timeout(135000) });
    const body = await response.json();
    if (!response.ok) throw new Error(body.code || 'TANGO_LIVE_HTTP_' + response.status);
    const text = body.content.filter(item => item.type === 'text').map(item => item.text).join('');
    const raw = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
    const checked = core.validateReply(raw, context);
    if (mode === 'priorities' && !checked.suggestions.some(item => item.priority === 1 && item.kind === 'create')) throw new Error('TANGO_LIVE_PRIORITY_NOT_RETURNED');
    if (mode === 'models' && !checked.suggestions.some(item => item.modelId === 'gpt-5.4')) throw new Error('TANGO_LIVE_MODEL_NOT_RETURNED');
    return { mode, ok: true, elapsedMs: Date.now() - started, suggestions: checked.suggestions.length, reply: checked.reply };
  } catch (error) { return { mode, ok: false, elapsedMs: Date.now() - started, code: /^[A-Z0-9_]+$/.test(error.message) ? error.message : 'TANGO_LIVE_RESPONSE_INVALID' }; }
}
const results = [];
for (let i = 0; i < requests.length; i += 2) {
  const pair = await Promise.all(requests.slice(i, i + 2).map(verify));
  results.push(...pair); pair.forEach(result => process.stdout.write(JSON.stringify(result) + '\n'));
}
process.stdout.write(JSON.stringify({ syntheticOnly: true, passed: results.filter(result => result.ok).length, total: results.length }) + '\n');
if (results.some(result => !result.ok)) process.exitCode = 1;
