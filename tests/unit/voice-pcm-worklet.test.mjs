import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { PCM_WORKLET_NAME } from '../../web/voice/capture.js';
import { VOICE_SAMPLE_RATE } from '../../web/voice/contracts.js';

// VI·V1采集 — web/voice/pcm-worklet.js 单测（先 RED 后 GREEN，实现后置）。
// 唯一标准 design/voice-intent/SPEC.md：
//   §2 浏览器麦克风 ─AudioWorklet→ 16kHz/16bit/mono PCM（每 60ms 一帧）
//   §3 capture.js 条目：AudioWorklet 重采样到 16k PCM、音量电平
// 用 node:vm 模拟 AudioWorkletGlobalScope + 构造 PCM 缓冲（合成正弦），
// 不需要浏览器、不落盘任何音频。

const WORKLET_PATH = join(dirname(fileURLToPath(import.meta.url)), '../../web/voice/pcm-worklet.js');

// —— vm 沙箱：AudioWorkletGlobalScope 最小面 ——
function loadWorklet({ sampleRate = 48000, messages = [] } = {}) {
  const registered = new Map();
  class AudioWorkletProcessor {
    constructor(options) {
      this.__options = options;
      this.__port = { postMessage: (msg, transfer) => messages.push({ msg, transfer }), onmessage: null };
    }
    get port() {
      return this.__port;
    }
  }
  const sandbox = {
    sampleRate,
    currentFrame: 0,
    currentTime: 0,
    // 真实浏览器中 worklet postMessage 的数据经结构化克隆落在主 realm；
    // vm 测试注入主 realm 的 typed array 构造器，使 instanceof 语义一致。
    Int16Array,
    Float32Array,
    AudioWorkletProcessor,
    registerProcessor: (name, ctor) => registered.set(name, ctor),
  };
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(WORKLET_PATH, 'utf8'), sandbox, { filename: WORKLET_PATH });
  return { registered, messages, AudioWorkletProcessor };
}

function makeProcessor(messages, { sampleRate = 48000, targetRate = VOICE_SAMPLE_RATE, frameMs = 60 } = {}) {
  const { registered } = loadWorklet({ sampleRate, messages });
  const Ctor = registered.get(PCM_WORKLET_NAME);
  assert.ok(Ctor, `worklet 未注册 ${PCM_WORKLET_NAME}`);
  const proc = new Ctor({ processorOptions: { targetRate, frameMs } });
  return proc;
}

// 合成正弦（公开数学信号，非真人音频）
function sine(freq, seconds, rate, amp = 0.5, phase = 0) {
  const n = Math.round(seconds * rate);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / rate + phase);
  return out;
}

// 按 AudioWorklet 的 128 样本渲染量子分块喂入
function feed(proc, samples, srcRate, chunk = 128) {
  for (let off = 0; off < samples.length; off += chunk) {
    const block = samples.subarray(off, Math.min(off + chunk, samples.length));
    const keep = proc.process([[block]], [[]], {});
    assert.equal(keep, true, 'process 必须返回 true 维持处理器存活');
  }
}

const framesOf = (messages) => messages.filter((m) => m.msg.type === 'frame');
const int16ToFloat = (i16) => Float32Array.from(i16, (v) => v / 32767);

// 在 ±maxLag 样本内找最佳对齐，返回最小最大误差
function bestAlignedMaxError(a, b, maxLag = 12, compareLen = 600) {
  let best = Infinity;
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    let worst = 0;
    let count = 0;
    for (let i = 0; i < compareLen; i++) {
      const j = i + lag;
      if (j < 0 || j >= b.length || i >= a.length) continue;
      const e = Math.abs(a[i] - b[j]);
      if (e > worst) worst = e;
      count++;
    }
    if (count < 100) continue; // 有效重叠太少的偏移不参与
    if (worst < best) best = worst;
  }
  return best;
}

// —— 1. 注册与构造 ——
test('在 AudioWorkletGlobalScope 中以约定名注册处理器；构造不抛异常', () => {
  const { registered } = loadWorklet();
  assert.equal(registered.size, 1);
  assert.ok(registered.has(PCM_WORKLET_NAME));
  const Ctor = registered.get(PCM_WORKLET_NAME);
  assert.equal(typeof Ctor, 'function');
  // 构造（含默认 options 兜底）
  new Ctor({ processorOptions: {} });
  new Ctor({});
});

// —— 2. 48k → 16k 重采样保真（合成 200Hz 正弦）——
test('48kHz→16k：1 秒 200Hz 正弦，flush 后输出 ≈16000 样本，波形与 16k 参考正弦对齐后误差 < 0.02', () => {
  const messages = [];
  const proc = makeProcessor(messages, { sampleRate: 48000 });
  const src = sine(200, 1, 48000, 0.5);
  feed(proc, src, 48000);
  proc.port.onmessage({ data: { type: 'flush' } }); // 取回尾帧（<60ms 尾巴）
  const frames = framesOf(messages);
  assert.ok(frames.length >= 15, `1 秒应产出约 16 帧，实际 ${frames.length}`);
  let total = 0;
  const out = [];
  for (const f of frames) {
    assert.ok(f.msg.samples instanceof Int16Array, '帧负载必须是 Int16Array（16bit PCM）');
    total += f.msg.samples.length;
    out.push(...int16ToFloat(f.msg.samples));
  }
  // flush 后总长 = ceil(有效样本/960)×960（尾帧补零）：不丢样本、尾巴不足一帧
  assert.ok(total >= 16000 && total < 16000 + 960, `输出样本数 ${total} 应在 [16000, 16960)`);
  const ref = sine(200, 1, 16000, 0.5);
  const err = bestAlignedMaxError(Float32Array.from(out), ref);
  assert.ok(err < 0.02, `重采样波形最大误差 ${err} 超阈`);
});

// —— 3. 帧尺寸与消息形状（SPEC §2：每 60ms 一帧）——
test('每帧恰好 960 样本（16k × 60ms）；消息带 rms/peak 电平；buffer 随 transfer 转移', () => {
  const messages = [];
  const proc = makeProcessor(messages, { sampleRate: 48000 });
  feed(proc, sine(200, 0.5, 48000, 0.5), 48000);
  const frames = framesOf(messages);
  assert.ok(frames.length >= 7);
  for (const f of frames) {
    assert.equal(f.msg.samples.length, 960);
    assert.ok(typeof f.msg.rms === 'number' && f.msg.rms >= 0 && f.msg.rms <= 1);
    assert.ok(typeof f.msg.peak === 'number' && f.msg.peak >= 0 && f.msg.peak <= 1);
    assert.ok(Array.isArray(f.transfer) && f.transfer.includes(f.msg.samples.buffer), 'Int16Array buffer 必须 transfer，避免拷贝');
  }
});

// —— 4. 电平正确性：正弦 A=0.5 → rms ≈ 0.354、peak ≈ 0.5 ——
test('帧 rms ≈ A/√2、peak ≈ A（A=0.5，±0.03）', () => {
  const messages = [];
  const proc = makeProcessor(messages, { sampleRate: 48000 });
  feed(proc, sine(220, 0.6, 48000, 0.5), 48000);
  const frames = framesOf(messages);
  const mid = frames.slice(2, 6); // 避开边界帧
  for (const f of mid) {
    assert.ok(Math.abs(f.msg.rms - 0.5 / Math.sqrt(2)) < 0.03, `rms=${f.msg.rms}`);
    assert.ok(Math.abs(f.msg.peak - 0.5) < 0.03, `peak=${f.msg.peak}`);
  }
});

// —— 5. 量化与 clamp：超量程输入不溢出 Int16 ——
test('输入超过 ±1：clamp 后量化，Int16 值域 [-32767, 32767]，不回绕', () => {
  const messages = [];
  const proc = makeProcessor(messages, { sampleRate: 48000 });
  const over = new Float32Array(48000);
  for (let i = 0; i < over.length; i++) over[i] = 2.5 * Math.sin((2 * Math.PI * 100 * i) / 48000);
  feed(proc, over, 48000);
  const frames = framesOf(messages);
  assert.ok(frames.length > 0);
  for (const f of frames) {
    for (const v of f.msg.samples) assert.ok(v >= -32767 && v <= 32767, `Int16 溢出: ${v}`);
    assert.ok(f.msg.rms <= 1.0001);
  }
});

// —— 6. 非整数倍采样率 44.1k → 16k ——
test('44.1kHz→16k：1 秒 flush 后输出样本数 ≈16000，正弦保真同 0.02 阈', () => {
  const messages = [];
  const proc = makeProcessor(messages, { sampleRate: 44100 });
  feed(proc, sine(180, 1, 44100, 0.4), 44100);
  proc.port.onmessage({ data: { type: 'flush' } });
  const frames = framesOf(messages);
  let total = 0;
  const out = [];
  for (const f of frames) {
    total += f.msg.samples.length;
    out.push(...int16ToFloat(f.msg.samples));
  }
  assert.ok(total >= 16000 && total < 16000 + 960, `44.1k 输出样本数 ${total} 应在 [16000, 16960)`);
  const ref = sine(180, 1, 16000, 0.4);
  assert.ok(bestAlignedMaxError(Float32Array.from(out), ref) < 0.02);
});

// —— 7. 恒等采样率 16k → 16k ——
test('16k→16k（采样率一致）：无损透传（flush 后 ≈8000 样本，对齐后误差 < 1e-4）', () => {
  const messages = [];
  const proc = makeProcessor(messages, { sampleRate: 16000 });
  feed(proc, sine(200, 0.5, 16000, 0.5), 16000);
  proc.port.onmessage({ data: { type: 'flush' } });
  const frames = framesOf(messages);
  const out = [];
  let total = 0;
  for (const f of frames) {
    total += f.msg.samples.length;
    out.push(...int16ToFloat(f.msg.samples));
  }
  assert.ok(total >= 8000 && total < 8000 + 960, `恒等输出样本数 ${total} 应在 [8000, 8960)`);
  const ref = sine(200, 0.5, 16000, 0.5);
  // 尾帧 = 320 信号 + 640 补零，比较窗口避开补零区
  assert.ok(bestAlignedMaxError(Float32Array.from(out), ref, 12, 250) < 1e-4);
});

// —— 8. 跨块相位连续：分块喂入 vs 一次性喂入结果一致 ——
test('分块（128）与整块喂入的重采样结果逐样本一致（跨块相位连续）', () => {
  const a = [];
  const b = [];
  const src = sine(333, 0.4, 48000, 0.5);
  feed(makeProcessor(a, { sampleRate: 48000 }), src, 48000, 128);
  feed(makeProcessor(b, { sampleRate: 48000 }), src, 48000, src.length); // 整块一次喂
  const fa = framesOf(a).flatMap((m) => [...m.msg.samples]);
  const fb = framesOf(b).flatMap((m) => [...m.msg.samples]);
  assert.equal(fa.length, fb.length);
  for (let i = 0; i < fa.length; i++) assert.equal(fa[i], fb[i]);
});

// —— 9. 空输入（麦克风轨道暂无数据）——
test('process 收到空输入：返回 true、不抛异常、不产帧', () => {
  const messages = [];
  const proc = makeProcessor(messages, { sampleRate: 48000 });
  assert.equal(proc.process([[undefined]], [[]], {}), true);
  assert.equal(proc.process([[]], [[]], {}), true);
  assert.equal(framesOf(messages).length, 0);
});

// —— 10. flush 尾帧协议（capture.js stop 前取回不足一帧的尾巴）——
test('flush：不足 960 的尾部补零出最后一帧，并回 flushed 消息；重复 flush 幂等', () => {
  const messages = [];
  const proc = makeProcessor(messages, { sampleRate: 48000 });
  feed(proc, sine(200, 0.5, 48000, 0.5), 48000); // 0.5s → 8000 个 16k 样本 = 8 帧整 + 尾 320
  const before = framesOf(messages).length;
  assert.ok(before >= 8);
  proc.port.onmessage({ data: { type: 'flush' } });
  const frames = framesOf(messages);
  assert.equal(frames.length, before + 1, 'flush 应补出 1 个尾帧');
  const tail = frames[frames.length - 1];
  assert.equal(tail.msg.samples.length, 960);
  // 尾帧前 320 样本有信号、其余补零
  let nonzero = 0;
  for (let i = 0; i < 320; i++) if (tail.msg.samples[i] !== 0) nonzero++;
  assert.ok(nonzero > 100, `尾帧前段应有信号，非零样本 ${nonzero}`);
  for (let i = 320; i < 960; i++) assert.equal(tail.msg.samples[i], 0);
  assert.ok(messages.some((m) => m.msg.type === 'flushed'), 'flush 后应回 flushed 消息');
  // 幂等：再次 flush 不再多出帧
  proc.port.onmessage({ data: { type: 'flush' } });
  assert.equal(framesOf(messages).length, before + 1);
});
