import assert from 'node:assert/strict';
import { test } from 'node:test';
// VI·V2流客户端 — web/voice/stream-client.js 单测（先 RED 后 GREEN）。
// 唯一标准 design/voice-intent/SPEC.md：
//   §2.2 客户端先发 {"type":"start","sampleRate":16000} → 二进制 PCM 帧 → {"type":"stop"}；
//        网关回 partial/final/end/error；asr-unavailable → 前端降级 webkitSpeechRecognition，
//        再不可用提示「语音暂时不可用，打字也行」。
//   §3   stream-client：WebSocket 协议、重连一次、按 seg 合并 partial 和 final。
// 契约（web/voice/contracts.js，commit 77a59d5）：applyServerMessage 的 seg 合并语义为本线唯一合并实现。
// 全部用内存假 WS / 假 SpeechRecognition，零网络、零 DOM。
import {
  VOICE_SAMPLE_RATE,
  VOICE_ERROR_CODES,
} from '../../web/voice/contracts.js';
import {
  createVoiceStream,
  voiceStreamUrl,
  speechResultsToMessages,
  getSpeechRecognitionCtor,
  STREAM_STATUS,
} from '../../web/voice/stream-client.js';

// —— 内存假 WebSocket ——
class FakeWS {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    this.bufferedAmount = 0;
    this.onopen = null;
    this.onclose = null;
    this.onerror = null;
    this.onmessage = null;
  }
  send(data) { this.sent.push(data); }
  close(code = 1000) {
    if (this.readyState >= 2) return;
    this.readyState = 3;
    this.onclose?.({ code });
  }
  // —— 测试驱动 ——
  open() { this.readyState = 1; this.onopen?.(); }
  message(obj) { this.onmessage?.({ data: JSON.stringify(obj) }); }
  raw(text) { this.onmessage?.({ data: text }); }
  drop(code = 1006) { this.readyState = 3; this.onclose?.({ code }); } // 异常断开（未收到 end）
  failBeforeOpen() { this.onerror?.({}); this.readyState = 3; this.onclose?.({ code: 1006 }); }
  texts() { return this.sent.filter((d) => typeof d === 'string').map((d) => JSON.parse(d)); }
  binaries() { return this.sent.filter((d) => typeof d !== 'string'); }
}

// —— 内存假 webkitSpeechRecognition ——
class FakeSR {
  constructor() {
    this.lang = '';
    this.continuous = false;
    this.interimResults = false;
    this.onresult = null;
    this.onerror = null;
    this.onend = null;
    this.started = 0;
    this.stopped = 0;
  }
  start() { this.started++; }
  stop() { this.stopped++; }
  result(results) { this.onresult?.({ results, resultIndex: 0 }); }
  err(error = 'network') { this.onerror?.({ error }); }
  end() { this.onend?.(); }
}
const alt = (t) => ({ transcript: t });

// —— 组装被测客户端 ——
function makeClient(over = {}) {
  const sockets = [];
  const srs = [];
  const statuses = [];
  const updates = [];
  const messages = [];
  const client = createVoiceStream({
    url: 'ws://t/api/voice/stream',
    socketFactory: (u) => { const s = new FakeWS(u); sockets.push(s); return s; },
    speechRecognitionFactory: () => { const r = new FakeSR(); srs.push(r); return r; },
    reconnectDelayMs: 0,
    reconnectAttempts: 1, // SPEC §3：重连一次
    onUpdate: (v) => updates.push({ ...v }),
    onStatus: (s, d) => statuses.push({ s, d }),
    onMessage: (m) => messages.push(m),
    ...over,
  });
  return { client, sockets, srs, statuses, updates, messages };
}

async function waitFor(fn, ms = 1000) {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error(`waitFor timeout: ${fn}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}
const last = (arr) => arr[arr.length - 1];

// ============ 纯函数：URL 与降级探测 ============

test('voiceStreamUrl：https → wss，http → ws，路径 /api/voice/stream（SPEC §2）', () => {
  assert.equal(voiceStreamUrl({ protocol: 'https:', host: 'a.b' }), 'wss://a.b/api/voice/stream');
  assert.equal(voiceStreamUrl({ protocol: 'http:', host: '127.0.0.1:17550' }), 'ws://127.0.0.1:17550/api/voice/stream');
});

test('getSpeechRecognitionCtor：优先 SpeechRecognition，回退 webkit 前缀，无则 null', () => {
  class A {} class B {}
  assert.equal(getSpeechRecognitionCtor({ SpeechRecognition: A, webkitSpeechRecognition: B }), A);
  assert.equal(getSpeechRecognitionCtor({ webkitSpeechRecognition: B }), B);
  assert.equal(getSpeechRecognitionCtor({}), null);
});

test('speechResultsToMessages：interim→partial，final→final，seg=结果下标（喂同一 seg 合并机）', () => {
  // 只有 interim：全部映射为 partial
  assert.deepEqual(
    speechResultsToMessages({ results: [{ isFinal: false, 0: alt('明天') }] }),
    [{ type: 'partial', seg: 0, text: '明天' }],
  );
  // 按序定稿：final 前缀 + 灰字尾巴
  assert.deepEqual(
    speechResultsToMessages({ results: [{ isFinal: true, 0: alt('明天下午三点，') }, { isFinal: false, 0: alt('和导师') }] }),
    [
      { type: 'final', seg: 0, text: '明天下午三点，' },
      { type: 'partial', seg: 1, text: '和导师' },
    ],
  );
  // 防御定序：后句已 final 而前句仍 interim → 前句冻结为 final（前缀稳定不变量）
  assert.deepEqual(
    speechResultsToMessages({ results: [{ isFinal: false, 0: alt('明天') }, { isFinal: true, 0: alt('下午三点') }] }),
    [
      { type: 'final', seg: 0, text: '明天' },
      { type: 'final', seg: 1, text: '下午三点' },
    ],
  );
});

// ============ 初始状态与 WS 协议握手 ============

test('初始状态：idle / mode ws / 空视图 / 0 次重连', () => {
  const { client } = makeClient();
  assert.equal(client.getStatus(), 'idle');
  assert.equal(client.getMode(), 'ws');
  assert.equal(client.getError(), null);
  assert.deepEqual(client.getView(), { finalText: '', partialText: '' });
  assert.equal(client.getReconnectCount(), 0);
});

test('握手：open 后发 {"type":"start","sampleRate":16000}，状态 connecting→open（SPEC §2.2）', async () => {
  const { client, sockets, statuses } = makeClient();
  client.start();
  assert.equal(sockets.length, 1);
  assert.equal(client.getStatus(), STREAM_STATUS.CONNECTING);
  sockets[0].open();
  await waitFor(() => client.getStatus() === STREAM_STATUS.OPEN);
  assert.deepEqual(sockets[0].texts(), [{ type: 'start', sampleRate: VOICE_SAMPLE_RATE }]);
  assert.equal(statuses[0].s, STREAM_STATUS.CONNECTING);
  assert.equal(last(statuses).s, STREAM_STATUS.OPEN);
});

test('音频透传：OPEN 时二进制帧原样发送；未 OPEN 静默丢弃', async () => {
  const { client, sockets } = makeClient();
  client.start();
  const pcm = new Int16Array([1, -2, 3]);
  client.sendAudio(pcm); // 未连接 → 丢弃
  sockets[0].open();
  await waitFor(() => client.getStatus() === STREAM_STATUS.OPEN);
  client.sendAudio(pcm);
  assert.equal(sockets[0].binaries().length, 1);
  assert.equal(sockets[0].binaries()[0], pcm);
});

test('背压保护：bufferedAmount 超限跳过该帧，回落后再恢复发送', async () => {
  const { client, sockets } = makeClient({ bufferedAmountLimit: 1024 });
  client.start();
  sockets[0].open();
  await waitFor(() => client.getStatus() === STREAM_STATUS.OPEN);
  sockets[0].bufferedAmount = 4096;
  client.sendAudio(new Int16Array([1]));
  assert.equal(sockets[0].binaries().length, 0);
  sockets[0].bufferedAmount = 0;
  client.sendAudio(new Int16Array([2]));
  assert.equal(sockets[0].binaries().length, 1);
});

test('stop：发送 {"type":"stop"}，幂等；ended 后音频丢弃', async () => {
  const { client, sockets } = makeClient();
  client.start();
  sockets[0].open();
  await waitFor(() => client.getStatus() === STREAM_STATUS.OPEN);
  client.stop();
  client.stop();
  const texts = sockets[0].texts();
  assert.equal(texts.filter((m) => m.type === 'stop').length, 1);
  sockets[0].message({ type: 'final', seg: 0, text: '明天下午三点' });
  sockets[0].message({ type: 'end' });
  await waitFor(() => client.getStatus() === STREAM_STATUS.ENDED);
  client.sendAudio(new Int16Array([9]));
  assert.equal(sockets[0].binaries().length, 0);
  assert.equal(sockets[0].readyState, FakeWS.CLOSED); // end 后干净关连接
});

// ============ 按 seg 合并（走 contracts.applyServerMessage）============

test('seg 合并：partial 同句原地替换、final 定稿、迟到 partial 不回退、视图=黑前缀+灰尾巴', async () => {
  const { client, sockets, updates } = makeClient();
  client.start();
  sockets[0].open();
  await waitFor(() => client.getStatus() === STREAM_STATUS.OPEN);
  sockets[0].message({ type: 'partial', seg: 0, text: '明天' });
  sockets[0].message({ type: 'partial', seg: 0, text: '明天下午' });
  sockets[0].message({ type: 'final', seg: 0, text: '明天下午三点，' });
  sockets[0].message({ type: 'partial', seg: 0, text: '明天' }); // 迟到 partial，不得回退定稿
  sockets[0].message({ type: 'partial', seg: 1, text: '和导师开' });
  sockets[0].message({ type: 'final', seg: 1, text: '和导师开组会。' });
  assert.deepEqual(last(updates), { finalText: '明天下午三点，和导师开组会。', partialText: '' });
  // 已确认前缀单调稳定（SPEC §3：final 前缀永不变化）
  const finals = updates.map((u) => u.finalText);
  for (let i = 1; i < finals.length; i++) assert.ok(finals[i].startsWith(finals[i - 1]),
    `final 前缀回退: ${finals[i - 1]} → ${finals[i]}`);
  assert.deepEqual(client.getView(), { finalText: '明天下午三点，和导师开组会。', partialText: '' });
});

test('非法帧不致命：非 JSON / 缺字段帧被忽略，连接继续可用', async () => {
  const { client, sockets, updates } = makeClient();
  client.start();
  sockets[0].open();
  await waitFor(() => client.getStatus() === STREAM_STATUS.OPEN);
  sockets[0].raw('not json at all');
  sockets[0].raw('{"type":"partial","text":"缺 seg"}');
  sockets[0].raw('{"type":"partial","seg":0,"text":"合法"}');
  assert.deepEqual(last(updates), { finalText: '', partialText: '合法' });
  assert.equal(client.getStatus(), STREAM_STATUS.OPEN);
});

// ============ 断线重连一次 ============

test('异常断开 → 重连一次：新连接重发 start，已定稿状态保留（前缀稳定）', async () => {
  const { client, sockets, statuses } = makeClient();
  client.start();
  sockets[0].open();
  await waitFor(() => client.getStatus() === STREAM_STATUS.OPEN);
  sockets[0].message({ type: 'final', seg: 0, text: '明天下午三点，' });
  sockets[0].drop(1006);
  await waitFor(() => client.getStatus() === STREAM_STATUS.RECONNECTING);
  await waitFor(() => sockets.length === 2);
  sockets[1].open();
  await waitFor(() => client.getStatus() === STREAM_STATUS.OPEN);
  assert.deepEqual(sockets[1].texts(), [{ type: 'start', sampleRate: VOICE_SAMPLE_RATE }]);
  assert.equal(client.getReconnectCount(), 1);
  assert.ok(statuses.some((x) => x.s === STREAM_STATUS.RECONNECTING));
  // 状态保留：重连后继续 seg 1
  sockets[1].message({ type: 'partial', seg: 1, text: '和导师开组会' });
  assert.deepEqual(client.getView(), { finalText: '明天下午三点，', partialText: '和导师开组会' });
  sockets[1].message({ type: 'end' });
  await waitFor(() => client.getStatus() === STREAM_STATUS.ENDED);
});

test('重连后正常收尾：stop + end → ended，不再重连', async () => {
  const { client, sockets } = makeClient();
  client.start();
  sockets[0].open();
  await waitFor(() => client.getStatus() === STREAM_STATUS.OPEN);
  sockets[0].drop();
  await waitFor(() => sockets.length === 2);
  sockets[1].open();
  await waitFor(() => client.getStatus() === STREAM_STATUS.OPEN);
  client.stop();
  sockets[1].message({ type: 'end' });
  await waitFor(() => client.getStatus() === STREAM_STATUS.ENDED);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(sockets.length, 2);
});

test('stop 待发时断线：重连握手后立即补发 stop 收尾', async () => {
  const { client, sockets } = makeClient();
  client.start();
  sockets[0].open();
  await waitFor(() => client.getStatus() === STREAM_STATUS.OPEN);
  client.stop();
  sockets[0].drop(); // stop 发出后、end 到达前断线
  await waitFor(() => sockets.length === 2);
  sockets[1].open();
  await waitFor(() => client.getStatus() === STREAM_STATUS.OPEN);
  assert.deepEqual(sockets[1].texts(), [
    { type: 'start', sampleRate: VOICE_SAMPLE_RATE },
    { type: 'stop' },
  ]);
});

test('连接失败（open 前 error+close）同样只重连一次，两次皆败 → 降级', async () => {
  const { client, sockets, srs } = makeClient();
  client.start();
  sockets[0].failBeforeOpen();
  await waitFor(() => sockets.length === 2);
  sockets[1].failBeforeOpen();
  await waitFor(() => srs.length === 1); // WS 路径失败 → 降级
  assert.equal(client.getMode(), 'fallback');
  assert.equal(sockets.length, 2); // 没有第三次连接
});

test('close() 取消挂起重连：不再建新连接，状态 closed', async () => {
  const { client, sockets } = makeClient({ reconnectDelayMs: 50 });
  client.start();
  sockets[0].open();
  await waitFor(() => client.getStatus() === STREAM_STATUS.OPEN);
  sockets[0].drop();
  await waitFor(() => client.getStatus() === STREAM_STATUS.RECONNECTING);
  client.close();
  assert.equal(client.getStatus(), STREAM_STATUS.CLOSED);
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(sockets.length, 1);
  assert.equal(client.getReconnectCount(), 0);
});

// ============ error 帧：asr-unavailable 立即降级，其余终态失败 ============

test('asr-unavailable → 立即降级，不重连；SR 结果进同一 seg 合并机（SPEC §2.2）', async () => {
  const { client, sockets, srs, statuses, updates } = makeClient();
  client.start();
  sockets[0].open();
  await waitFor(() => client.getStatus() === STREAM_STATUS.OPEN);
  sockets[0].message({ type: 'error', code: VOICE_ERROR_CODES.ASR_UNAVAILABLE });
  await waitFor(() => client.getMode() === 'fallback');
  assert.equal(sockets.length, 1); // 不重连
  assert.equal(srs.length, 1);
  assert.equal(srs[0].lang, 'zh-CN');
  assert.ok(srs[0].continuous && srs[0].interimResults);
  assert.ok(statuses.some((x) => x.s === STREAM_STATUS.FALLBACK && x.d?.reason === 'asr-unavailable'));
  // 真实 SR 连续听写序列：results 累积，下标=句序；同句 interim 反复修订后 final 定稿
  srs[0].result([{ isFinal: false, 0: alt('后天') }]);
  srs[0].result([{ isFinal: false, 0: alt('后天下午') }]);
  srs[0].result([{ isFinal: true, 0: alt('后天下午两点，') }]);
  srs[0].result([{ isFinal: true, 0: alt('后天下午两点，') }, { isFinal: false, 0: alt('和导师') }]);
  assert.deepEqual(last(updates), { finalText: '后天下午两点，', partialText: '和导师' });
  // 原会话已收到的定稿在降级后仍保留（不清空转写）
  assert.deepEqual(client.getView(), { finalText: '后天下午两点，', partialText: '和导师' });
});

test('daily-limit 等其余错误码：终态 failed，不重连、不降级', async () => {
  const { client, sockets, srs } = makeClient();
  client.start();
  sockets[0].open();
  await waitFor(() => client.getStatus() === STREAM_STATUS.OPEN);
  sockets[0].message({ type: 'error', code: VOICE_ERROR_CODES.DAILY_LIMIT });
  await waitFor(() => client.getStatus() === STREAM_STATUS.FAILED);
  assert.equal(client.getError(), VOICE_ERROR_CODES.DAILY_LIMIT);
  assert.equal(sockets.length, 1);
  assert.equal(srs.length, 0);
  assert.equal(sockets[0].readyState, FakeWS.CLOSED);
});

// ============ 降级 webkitSpeechRecognition 分支 ============

test('降级后正常收尾：stop() → SR.stop → onend → ended', async () => {
  const { client, sockets, srs } = makeClient();
  client.start();
  sockets[0].open();
  await waitFor(() => client.getStatus() === STREAM_STATUS.OPEN);
  sockets[0].message({ type: 'error', code: VOICE_ERROR_CODES.ASR_UNAVAILABLE });
  await waitFor(() => client.getMode() === 'fallback');
  client.stop();
  assert.equal(srs[0].stopped, 1);
  srs[0].end();
  await waitFor(() => client.getStatus() === STREAM_STATUS.ENDED);
});

test('降级 SR 也失败 → failed，提示「语音暂时不可用，打字也行」（SPEC §2.2）', async () => {
  const sockets = [];
  let sr = null;
  const statuses = [];
  const client = createVoiceStream({
    url: 'ws://t/api/voice/stream',
    socketFactory: (u) => { const s = new FakeWS(u); sockets.push(s); return s; },
    speechRecognitionFactory: () => { sr = new FakeSR(); return sr; },
    reconnectDelayMs: 0,
    onStatus: (s, d) => statuses.push({ s, d }),
  });
  client.start();
  sockets[0].open();
  await waitFor(() => client.getStatus() === STREAM_STATUS.OPEN);
  sockets[0].message({ type: 'error', code: VOICE_ERROR_CODES.ASR_UNAVAILABLE });
  await waitFor(() => client.getMode() === 'fallback');
  assert.ok(sr);
  sr.err('network');
  sr.end();
  await waitFor(() => client.getStatus() === STREAM_STATUS.FAILED);
  assert.equal(last(statuses).d?.hint, '语音暂时不可用，打字也行');
});

test('WS 两连败且浏览器无 SpeechRecognition → failed + 打字提示', async () => {
  const { client, sockets, statuses } = makeClient({ speechRecognitionFactory: () => null });
  client.start();
  sockets[0].failBeforeOpen();
  await waitFor(() => sockets.length === 2);
  sockets[1].failBeforeOpen();
  await waitFor(() => client.getStatus() === STREAM_STATUS.FAILED);
  assert.equal(last(statuses).d?.hint, '语音暂时不可用，打字也行');
});
