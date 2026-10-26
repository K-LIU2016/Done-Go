import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import WebSocket from 'ws';
import { createVoiceV3Gateway, VOICE_V3_PATH, shanghaiNow } from '../../scripts/voice-pipeline/gateway.mjs';

// 假 ASR：每收到一包就出实时字；finish 时把每 2 包当一句给出双路定稿
function fakeEngine() {
  return {
    createSession({ onPartial, onFinal, onAlt }) {
      let packets = 0, seg = 0;
      const script = [{ a: '嗯， 明天下午三点开组会。', b: '明天下午三点开组会' }, { a: '然后周五前交报告。', b: '周五前交报告' }];
      return {
        get receivedMs() { return packets * 100; },
        accept() { packets += 1; onPartial(seg, '实时' + packets); if (packets % 2 === 0 && seg < script.length) { const s = seg++; onFinal(s, { a: script[s].a, msA: 5 }); onAlt(s, { b: script[s].b, msB: 9 }); } },
        async finish() {},
      };
    },
  };
}

async function harness(t, opts = {}) {
  const gw = createVoiceV3Gateway({
    engine: fakeEngine(), authenticate: () => ({ id: 'u' }), requestAllowed: () => true,
    clean: async ({ a }) => ({ text: a.replace(/嗯， /, ''), source: 'local' }),
    structure: async ({ a }) => ({ clean: a, items: [{ title: 'from:' + a.length }], source: 'cloud' }),
    now: () => '2026-10-26T09:00:00+08:00', ...opts,
  });
  const server = createServer();
  server.on('upgrade', (req, socket, head) => (req.url === VOICE_V3_PATH ? gw.handleUpgrade(req, socket, head) : socket.destroy()));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => { gw.close(); server.close(); });
  return `ws://127.0.0.1:${server.address().port}${VOICE_V3_PATH}`;
}

function talk(url, steps, start = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url); const got = [];
    ws.on('unexpected-response', (_, res) => resolve({ rejected: res.statusCode }));
    ws.on('error', reject);
    ws.on('message', d => { const m = JSON.parse(String(d)); got.push(m); if (m.type === 'ready') steps(ws); });
    ws.on('open', () => ws.send(JSON.stringify({ type: 'start', sampleRate: 16000, ...start })));
    ws.on('close', () => resolve({ got }));
  });
}

test('one utterance streams partial → final → clean → items, then one final items message and end', async t => {
  const url = await harness(t);
  const { got } = await talk(url, ws => { for (let i = 0; i < 4; i++) ws.send(Buffer.alloc(3200)); setTimeout(() => ws.send(JSON.stringify({ type: 'stop' })), 50); });
  const types = got.map(m => m.type);
  assert.ok(types.includes('partial'));
  assert.deepEqual(got.filter(m => m.type === 'final').map(m => m.text), ['明天下午三点开组会。', '周五前交报告。'], 'final text is rule-cleaned instantly');
  assert.deepEqual(got.filter(m => m.type === 'clean').map(m => m.text), ['明天下午三点开组会。', '然后周五前交报告。'] /* clean 由假模型给出，原样透传 */);
  assert.equal(got.filter(m => m.type === 'items' && m.final).length, 1, 'exactly one final items message, no rule placeholder cards');
  const last = got.filter(m => m.type === 'items').at(-1);
  assert.equal(last.final, true);
  assert.equal(last.source, 'cloud');
  assert.equal(types.at(-1), 'end');
});

test('an edited segment is never overwritten and feeds the next structuring pass', async t => {
  const seen = [];
  const url = await harness(t, { structure: async ({ a }) => { seen.push(a); return { clean: a, items: [], source: 'cloud' }; } });
  await talk(url, ws => {
    ws.send(Buffer.alloc(3200)); ws.send(Buffer.alloc(3200));
    setTimeout(() => { ws.send(JSON.stringify({ type: 'edit', seg: 0, text: '后天上午十点开组会' })); setTimeout(() => ws.send(JSON.stringify({ type: 'stop' })), 30); }, 30);
  });
  assert.ok(seen.at(-1).includes('后天上午十点开组会'));
});

test('rejects upgrades without a session or from a foreign origin', async t => {
  const noAuth = await harness(t, { authenticate: () => { throw new Error('AUTH_REQUIRED'); } });
  assert.equal((await talk(noAuth, () => {})).rejected, 401);
  const foreign = await harness(t, { requestAllowed: () => false });
  assert.equal((await talk(foreign, () => {})).rejected, 403);
});

test('shanghaiNow formats the current time with the +08:00 offset', () => {
  assert.equal(shanghaiNow(new Date('2026-10-26T01:00:00Z')), '2026-10-26T09:00:00+08:00');
});

test('the user vocabulary from start reaches every structuring call, deduped and sanitized', async t => {
  const seen = [];
  const url = await harness(t, { structure: async (input, opts) => { seen.push(opts.vocab); return { clean: input.a, items: [], source: 'cloud' }; } });
  const vocab = ['Argus', 'Mystic', 'Argus', 42, '  ', 'x'.repeat(50)];
  await talk(url, ws => { for (let i = 0; i < 4; i++) ws.send(Buffer.alloc(3200)); setTimeout(() => ws.send(JSON.stringify({ type: 'stop' })), 50); }, { vocab });
  assert.ok(seen.length >= 1);
  for (const v of seen) assert.deepEqual(v, ['Argus', 'Mystic', 'x'.repeat(30)]);
});

test('a throwing structurer or cleaner never crashes the process and the client still gets end', async t => {
  const logs = [];
  const url = await harness(t, { structure: async () => { throw new Error('boom'); }, clean: async () => { throw new Error('bad clean'); }, log: e => logs.push(e) });
  const { got } = await talk(url, ws => { for (let i = 0; i < 4; i++) ws.send(Buffer.alloc(3200)); setTimeout(() => ws.send(JSON.stringify({ type: 'stop' })), 50); });
  assert.equal(got.at(-1).type, 'end');
  assert.ok(logs.some(e => e.event === 'voice-v3-error'));
});
