import assert from 'node:assert/strict';
import { test } from 'node:test';
// VI·V1采集 — web/voice/capture.js 纯函数单测（先 RED 后 GREEN，实现后置）。
// 唯一标准 design/voice-intent/SPEC.md：
//   §2   16kHz/16bit/mono PCM、每 60ms 一帧
//   §3   capture.js：重采样到 16k、音量电平（驱动波形）、静音 2 秒检测、
//        60 秒上限、麦克风权限被拒时给出清楚的提示
//   §4   波形 15 根柱，高度由实时音量驱动；静音时回落到 8px
//   §2.2 单次 ≤ 60 秒（session-too-long 在客户端先行自动停止）
import {
  PCM_WORKLET_NAME,
  PCM_FRAME_MS,
  SILENCE_TIMEOUT_MS,
  MAX_SESSION_MS,
  SPEECH_RMS_THRESHOLD,
  WAVEFORM_BARS,
  WAVE_MIN_PX,
  WAVE_MAX_PX,
  createCaptureState,
  nextCaptureState,
  rmsLevel,
  waveformBarHeights,
  classifyMicError,
  formatClock,
} from '../../web/voice/capture.js';
import { VOICE_SAMPLE_RATE } from '../../web/voice/contracts.js';

// —— SPEC 常量 ——
test('采集常量与 SPEC 一致（16k / 60ms 帧 / 静音 2s / 上限 60s / 15 柱 8–40px）', () => {
  assert.equal(VOICE_SAMPLE_RATE, 16000);
  assert.equal(PCM_FRAME_MS, 60);
  assert.equal(SILENCE_TIMEOUT_MS, 2000);
  assert.equal(MAX_SESSION_MS, 60000);
  assert.equal(WAVEFORM_BARS, 15);
  assert.equal(WAVE_MIN_PX, 8);
  assert.equal(WAVE_MAX_PX, 40);
  assert.ok(typeof PCM_WORKLET_NAME === 'string' && PCM_WORKLET_NAME.length > 0);
});

// —— 电平（合成 PCM 缓冲）——
test('rmsLevel：正弦 A=0.5 → ≈0.354；全零 → 0；满幅 → ≈1', () => {
  const n = 16000;
  const sine = new Float32Array(n);
  for (let i = 0; i < n; i++) sine[i] = 0.5 * Math.sin((2 * Math.PI * 220 * i) / 16000);
  assert.ok(Math.abs(rmsLevel(sine) - 0.5 / Math.sqrt(2)) < 0.005);
  assert.equal(rmsLevel(new Float32Array(1000)), 0);
  const loud = new Float32Array(1000).fill(1);
  assert.ok(Math.abs(rmsLevel(loud) - 1) < 1e-9);
  // 超过 ±1 的输入按 clamp 后电平计，不超 1
  const over = new Float32Array(1000).fill(2);
  assert.ok(rmsLevel(over) <= 1.0001);
});

// —— 静音 2 秒断句 / 60 秒上限状态机（纯函数，帧驱动 60ms 一帧）——
const FRAME_MS = 60;

function runFrames(frames) {
  // frames: [{level, atMs}]，逐帧推进状态机，收集事件
  let st = createCaptureState(frames.length ? frames[0].atMs : 0);
  const events = [];
  for (const f of frames) {
    const r = nextCaptureState(st, f.level, f.atMs);
    st = r.state;
    if (r.event) events.push({ ...r.event, atMs: f.atMs });
  }
  return { state: st, events };
}

function tone(fromMs, toMs, level = 0.2) {
  const out = [];
  for (let t = fromMs; t < toMs; t += FRAME_MS) out.push({ level, atMs: t });
  return out;
}

test('未开口前一直静音：不触发静音断句（不能用户还没说就结束）', () => {
  const { events } = runFrames(tone(0, 5000, 0.001));
  assert.equal(events.length, 0);
});

test('开口后静音满 2000ms 触发 silence-end；1980ms 不触发（SPEC §3 静音 2 秒）', () => {
  // 有声最后帧 atMs=960；静音帧 1000..2920，2920-960=1960ms → 不触发
  const { events } = runFrames([...tone(0, 1000), ...tone(1000, 2921, 0.001)]);
  assert.equal(events.length, 0);
  // 静音帧 1000..2980，2980-960=2020ms ≥ 2000 → 触发
  const r2 = runFrames([...tone(0, 1000), ...tone(1000, 2981, 0.001)]);
  assert.equal(r2.events.length, 1);
  assert.equal(r2.events[0].type, 'silence-end');
  assert.equal(r2.events[0].atMs, 2980);
});

test('说话会刷新静音计时：说 1s → 停 1.5s → 再说 → 停 2s 才断句', () => {
  const frames = [
    ...tone(0, 1000),
    ...tone(1000, 2500, 0.001),
    ...tone(2500, 4000), // 重新说话
    ...tone(4000, 5999, 0.001),
    ...tone(5999, 6000, 0.001), // 5999 时距 4000 前最后一帧 3999 过去 2000ms
  ];
  const { events } = runFrames(frames);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'silence-end');
});

test('持续说话到 60 秒触发 max-duration（SPEC 单次 ≤ 60 秒）', () => {
  const { events } = runFrames([...tone(0, 60000 - FRAME_MS), { level: 0.2, atMs: 60000 }]);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'max-duration');
  assert.ok(events[0].atMs >= 60000 - FRAME_MS);
});

test('上限优先于静音：两条件同帧满足时给 max-duration', () => {
  // 0–1000 说话；静音到 58000（>2s，早该断）；但若状态机没停（被继续喂帧），60s 时刻给 max-duration。
  // 构造：先触发 silence-end 后状态机已 stopped；这里验证的是「不停机持续喂帧」的顺序保证——
  // 直接构造 stopped=false 且两条件同时成立的帧：从 58000 开始说话 1 帧，再静音 2000+ms 到 60000+。
  let st = createCaptureState(0);
  const seen = [];
  const push = (level, atMs) => {
    const r = nextCaptureState(st, level, atMs);
    st = r.state;
    if (r.event) seen.push(r.event);
  };
  push(0.2, 0);
  // 快进到 59_940：先经过多帧静音但用大 level 保持有声，避免 silence 先触发
  for (let t = FRAME_MS; t <= 59940; t += 1000) push(0.2, t);
  // 59_940 有声，随后静音；60_000 帧同时满足 now-start>=60000 与 now-lastVoice>=2000? lastVoice=59940，2000ms 后是 61940。
  // 构造真正同帧：lastVoiceAt=58000、startedAt=0，now=60000 → 静音 2000 且到上限。
  let s2 = { startedAt: 0, lastVoiceAt: 58000, spokenOnce: true, stopped: false };
  const r = nextCaptureState(s2, 0.001, 60000);
  assert.equal(r.event.type, 'max-duration');
  assert.ok(seen.length === 0);
});

test('状态机停止后幂等：继续喂帧不再产生事件', () => {
  const frames = [...tone(0, 1000), ...tone(1000, 3001, 0.001), ...tone(3001, 8000, 0.001)];
  const { events, state } = runFrames(frames);
  assert.equal(events.length, 1);
  assert.equal(state.stopped, true);
});

test('低于话音阈值的电平不算说话（环境噪声不重置静音计时）', () => {
  assert.ok(0.005 < SPEECH_RMS_THRESHOLD);
  const { events } = runFrames([...tone(0, 1000), ...tone(1000, 2500, 0.005), ...tone(2500, 3200, 0.001)]);
  // 1000ms 后全是低于阈值的"噪声"：2500-1000=1500ms 未到 2s，3200 处 2200ms → silence-end
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'silence-end');
});

test('纯函数：nextCaptureState 不修改入参状态', () => {
  const st = createCaptureState(0);
  const frozen = JSON.parse(JSON.stringify(st));
  nextCaptureState(st, 0.2, 100);
  assert.deepEqual(st, frozen);
});

// —— 波形柱高（SPEC §4：15 根柱、实时音量驱动、静音回落 8px）——
test('waveformBarHeights：15 根；level=0 全 8px；level=1 中心柱 40px；值域 [8,40]', () => {
  const silent = waveformBarHeights(0);
  assert.equal(silent.length, WAVEFORM_BARS);
  for (const h of silent) assert.equal(h, WAVE_MIN_PX);
  const loud = waveformBarHeights(1);
  const maxH = Math.max(...loud);
  assert.equal(maxH, WAVE_MAX_PX);
  for (const h of loud) assert.ok(h >= WAVE_MIN_PX && h <= WAVE_MAX_PX);
  // 音量越大柱越高（单调）
  const low = waveformBarHeights(0.2);
  const mid = waveformBarHeights(0.6);
  for (let i = 0; i < WAVEFORM_BARS; i++) assert.ok(mid[i] >= low[i]);
  // 越界输入 clamp 不炸
  for (const h of waveformBarHeights(-3)) assert.equal(h, WAVE_MIN_PX);
  for (const h of waveformBarHeights(9)) assert.ok(h >= WAVE_MIN_PX && h <= WAVE_MAX_PX);
});

// —— 麦克风错误分类与友好提示（SPEC §3 权限被拒给出清楚提示）——
test('classifyMicError：权限被拒（Chrome/Safari 命名）→ mic-denied + 提到如何重新允许', () => {
  for (const name of ['NotAllowedError', 'PermissionDeniedError', 'SecurityError']) {
    const r = classifyMicError({ name, message: 'denied' });
    assert.equal(r.kind, 'mic-denied');
    assert.ok(r.message.length >= 8);
    assert.ok(r.message.includes('麦克风'));
    assert.ok(/允许|权限/.test(r.message));
  }
});

test('classifyMicError：无设备 / 被占用 / 不支持 / 兜底 各有明确 kind 与非空文案', () => {
  assert.equal(classifyMicError({ name: 'NotFoundError' }).kind, 'mic-not-found');
  assert.equal(classifyMicError({ name: 'DevicesNotFoundError' }).kind, 'mic-not-found');
  assert.equal(classifyMicError({ name: 'NotReadableError' }).kind, 'mic-busy');
  const unsup = classifyMicError(null, { hasMediaDevices: false });
  assert.equal(unsup.kind, 'mic-unsupported');
  const fallback = classifyMicError({ name: 'WeirdError', message: 'boom' });
  assert.equal(fallback.kind, 'mic-error');
  assert.ok(fallback.message.includes('boom'));
  for (const r of [
    classifyMicError({ name: 'NotFoundError' }),
    classifyMicError({ name: 'NotReadableError' }),
    unsup,
    fallback,
  ]) {
    assert.ok(typeof r.message === 'string' && r.message.length >= 8, `文案过于含糊: ${r.message}`);
  }
});

// —— 计时格式（原型第一屏 0:07 样式）——
test('formatClock：m:ss，进位正确', () => {
  assert.equal(formatClock(0), '0:00');
  assert.equal(formatClock(7000), '0:07');
  assert.equal(formatClock(59999), '0:59');
  assert.equal(formatClock(60000), '1:00');
  assert.equal(formatClock(125000), '2:05');
});

// —— 与 worklet 的命名契约（跨文件一致性由本测试钉住）——
test('PCM_WORKLET_NAME 与 pcm-worklet.js registerProcessor 的名字一致', async () => {
  const { readFileSync } = await import('node:fs');
  const { dirname, join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const src = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '../../web/voice/pcm-worklet.js'),
    'utf8',
  );
  assert.ok(
    src.includes(`registerProcessor('${PCM_WORKLET_NAME}'`) ||
      src.includes(`registerProcessor("${PCM_WORKLET_NAME}"`),
    'pcm-worklet.js 必须以 capture.js 约定的处理器名注册',
  );
});
