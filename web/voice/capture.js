// web/voice/capture.js — 语音采集编排与采集纯函数（VI·V1采集）。
// 唯一标准 design/voice-intent/SPEC.md：
//   §2    浏览器麦克风 ─AudioWorklet→ 16kHz/16bit/mono PCM（每 60ms 一帧）
//   §2.2  单次 ≤ 60 秒（客户端到点自动收口，避免网关 session-too-long）
//   §3    capture.js：getUserMedia、AudioWorklet 重采样到 16k PCM、音量电平
//         （驱动波形）、静音 2 秒检测、60 秒上限；麦克风权限被拒时给出清楚的提示
//   §4    波形 15 根柱，高度由实时音量驱动；静音时回落到 8px
//
// 分层：
//   * 纯函数 / 常量（Node 可测：tests/unit/voice-capture.test.mjs）
//   * createVoiceCapture（浏览器编排，加载 ./pcm-worklet.js，采集数据只在
//     内存中经 onFrame 交给上层 stream-client，绝不落盘）

import { VOICE_SAMPLE_RATE } from './contracts.js';

// —— SPEC 常量 ——
export const PCM_WORKLET_NAME = 'pcm-capture-16k'; // 与 pcm-worklet.js registerProcessor 同名（有单测钉住）
export const PCM_FRAME_MS = 60; // SPEC §2：每 60ms 一帧（16k 下 960 样本）
export const SILENCE_TIMEOUT_MS = 2000; // SPEC §3：静音 2 秒自动断句
export const MAX_SESSION_MS = 60000; // SPEC §2.2：单次 ≤ 60 秒
export const SPEECH_RMS_THRESHOLD = 0.02; // ≥ 视为「正在说话」（AGC 麦克风环境底噪上界，低于此不算开口）
export const WAVEFORM_BARS = 15; // SPEC §4
export const WAVE_MIN_PX = 8; // SPEC §4：静音时回落到 8px
export const WAVE_MAX_PX = 40;

// —— 静音 / 上限状态机（纯函数，返回新状态，绝不修改入参）——
export function createCaptureState(nowMs = 0) {
  return { startedAt: nowMs, lastVoiceAt: null, spokenOnce: false, stopped: false };
}

// 帧驱动推进：level = 本帧 RMS 电平（0..1），nowMs = 当前时刻（performance.now() 域）。
// 事件：
//   {type:'max-duration'}  会话到达 60 秒上限（优先判定，同帧两条件同时成立以它收口）
//   {type:'silence-end'}   开口说过话之后，静音持续满 2 秒
// 未开口（spokenOnce=false）的静音不触发断句——用户还没开始说，不能替他结束。
export function nextCaptureState(
  state,
  level,
  nowMs,
  { silenceTimeoutMs = SILENCE_TIMEOUT_MS, maxSessionMs = MAX_SESSION_MS } = {},
) {
  if (state.stopped) return { state, event: null };
  const speaking = typeof level === 'number' && Number.isFinite(level) && level >= SPEECH_RMS_THRESHOLD;
  const next = {
    ...state,
    lastVoiceAt: speaking ? nowMs : state.lastVoiceAt,
    spokenOnce: state.spokenOnce || speaking,
  };
  if (nowMs - next.startedAt >= maxSessionMs) {
    return { state: { ...next, stopped: true }, event: { type: 'max-duration' } };
  }
  if (next.spokenOnce && next.lastVoiceAt != null && nowMs - next.lastVoiceAt >= silenceTimeoutMs) {
    return { state: { ...next, stopped: true }, event: { type: 'silence-end' } };
  }
  return { state: next, event: null };
}

// —— 电平（RMS，0..1；输入 clamp ±1，与 worklet 帧电平同公式）——
export function rmsLevel(samples) {
  if (!samples || samples.length === 0) return 0;
  let sumSq = 0;
  for (let i = 0; i < samples.length; i++) {
    let v = samples[i];
    if (v > 1) v = 1;
    else if (v < -1) v = -1;
    sumSq += v * v;
  }
  return Math.sqrt(sumSq / samples.length);
}

// —— 波形柱高（SPEC §4：15 根柱，高度由实时音量驱动；静音精确回落 8px）——
// 确定性形状（中心高、两侧低），无时间维随机——不是假动画，高度只随电平变化。
export function waveformBarHeights(level, bars = WAVEFORM_BARS) {
  const l = Number.isFinite(level) ? Math.max(0, Math.min(1, level)) : 0;
  const gain = Math.pow(l, 0.7); // 小音量也可见；pow(0,0.7)=0 保证静音全 8px
  const out = new Array(bars);
  for (let i = 0; i < bars; i++) {
    const shape = Math.sin((Math.PI * (i + 0.5)) / bars); // 中心 1，两端 ~0.2
    out[i] = WAVE_MIN_PX + (WAVE_MAX_PX - WAVE_MIN_PX) * gain * shape;
  }
  return out;
}

// —— 麦克风错误分类与友好提示（SPEC §3：权限被拒要给出清楚的提示）——
const MIC_ERROR_MESSAGES = {
  'mic-denied':
    '麦克风权限被拒绝了。请点浏览器地址栏里的 🔒 或 🎤 图标，把麦克风设为「允许」，然后再试一次；iPhone 可在「设置 → Safari → 麦克风」里打开。',
  'mic-not-found': '没有找到麦克风。请确认麦克风已连接、系统麦克风权限已打开，然后再试一次。',
  'mic-busy': '麦克风正被其他应用占用。请关闭其他录音或会议应用后重试。',
  'mic-unsupported': '当前浏览器不支持语音采集。请使用最新版 Chrome、Edge 或 Safari，或直接打字。',
};

export function classifyMicError(err, { hasMediaDevices = true } = {}) {
  if (!hasMediaDevices) return { kind: 'mic-unsupported', message: MIC_ERROR_MESSAGES['mic-unsupported'] };
  const name = err && err.name ? String(err.name) : '';
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError') {
    return { kind: 'mic-denied', message: MIC_ERROR_MESSAGES['mic-denied'] };
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
    return { kind: 'mic-not-found', message: MIC_ERROR_MESSAGES['mic-not-found'] };
  }
  if (name === 'NotReadableError' || name === 'TrackStartError') {
    return { kind: 'mic-busy', message: MIC_ERROR_MESSAGES['mic-busy'] };
  }
  const detail = err && err.message ? String(err.message) : '未知错误';
  return { kind: 'mic-error', message: `麦克风启动失败（${detail}）。可以重试，或直接打字。` };
}

export class VoiceCaptureError extends Error {
  constructor({ kind, message }) {
    super(message);
    this.name = 'VoiceCaptureError';
    this.kind = kind;
  }
}

// —— 计时显示（原型第一屏 0:07 样式，tabular 数字）——
export function formatClock(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

// —— 浏览器编排 ——
// 用法：
//   const cap = createVoiceCapture({
//     workletURL: new URL('./pcm-worklet.js', import.meta.url),
//     onFrame: (pcmInt16) => ws.send(pcmInt16),   // 16k/16bit/mono，60ms 一帧
//     onLevel: (l) => renderWave(waveformBarHeights(l)),
//     onAutoStop: (reason) => sendStop(),
//     onTimer: (elapsedMs) => updateClock(formatClock(elapsedMs)),
//   });
//   try { await cap.start(); } catch (e) { show(e.kind, e.message); }
//   cap.stop(); // 手动「说完了」/ 取消
export function createVoiceCapture({
  workletURL,
  getUserMedia,
  AudioContextCtor,
  targetRate = VOICE_SAMPLE_RATE,
  frameMs = PCM_FRAME_MS,
  silenceTimeoutMs = SILENCE_TIMEOUT_MS,
  maxSessionMs = MAX_SESSION_MS,
  onFrame,
  onLevel,
  onAutoStop,
  onTimer,
} = {}) {
  let state = null;
  let ctx = null;
  let workletNode = null;
  let source = null;
  let sink = null;
  let stream = null;
  let timerId = null;
  let stopped = true;

  const now = () =>
    typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();

  function releaseTracks() {
    if (stream) {
      for (const t of stream.getTracks()) t.stop(); // 立即熄掉系统麦克风指示灯
      stream = null;
    }
  }

  function teardown() {
    if (timerId != null) {
      clearInterval(timerId);
      timerId = null;
    }
    try {
      workletNode && workletNode.port.postMessage({ type: 'flush' }); // 尽力取回 <60ms 尾帧
    } catch {
      /* 关闭中的端口可能已不可写，无妨 */
    }
    for (const node of [source, workletNode, sink]) {
      try {
        node && node.disconnect();
      } catch {
        /* 已断开 */
      }
    }
    source = workletNode = sink = null;
    try {
      ctx && ctx.close();
    } catch {
      /* 已关闭 */
    }
    ctx = null;
    releaseTracks();
  }

  function finish(reason) {
    if (stopped) return;
    stopped = true;
    teardown();
    if (reason !== 'manual' && onAutoStop) onAutoStop(reason);
  }

  function advance(level) {
    if (stopped || !state) return;
    const r = nextCaptureState(state, level, now(), { silenceTimeoutMs, maxSessionMs });
    state = r.state;
    if (r.event) finish(r.event.type === 'max-duration' ? 'max-duration' : 'silence');
  }

  async function start() {
    if (!stopped) return;
    const gum =
      getUserMedia ||
      (globalThis.navigator &&
      globalThis.navigator.mediaDevices &&
      typeof globalThis.navigator.mediaDevices.getUserMedia === 'function'
        ? globalThis.navigator.mediaDevices.getUserMedia.bind(globalThis.navigator.mediaDevices)
        : null);
    const AC = AudioContextCtor || globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!gum || !AC || !workletURL) {
      throw new VoiceCaptureError(classifyMicError(null, { hasMediaDevices: Boolean(gum) }));
    }
    let media;
    try {
      media = await gum({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (err) {
      throw new VoiceCaptureError(classifyMicError(err, { hasMediaDevices: true }));
    }
    stream = media;
    try {
      const NodeCtor = globalThis.AudioWorkletNode;
      if (!NodeCtor) throw new Error('AudioWorkletNode unsupported');
      ctx = new AC();
      await ctx.audioWorklet.addModule(workletURL);
      workletNode = new NodeCtor(ctx, PCM_WORKLET_NAME, {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        processorOptions: { targetRate, frameMs },
      });
      workletNode.port.onmessage = (ev) => {
        const msg = ev && ev.data;
        if (!msg || msg.type !== 'frame') return; // flushed 只用于收尾确认
        if (onFrame) onFrame(msg.samples, { rms: msg.rms, peak: msg.peak });
        if (onLevel) onLevel(msg.rms);
        advance(msg.rms);
      };
      source = ctx.createMediaStreamSource(stream);
      sink = ctx.createGain();
      sink.gain.value = 0; // 静音输出：仅为了让 graph 保持调度（AudioWorklet 需连到 destination）
      source.connect(workletNode);
      workletNode.connect(sink);
      sink.connect(ctx.destination);
      state = createCaptureState(now());
      stopped = false;
      timerId = setInterval(() => {
        if (!stopped && state && onTimer) onTimer(now() - state.startedAt);
      }, 250);
    } catch (err) {
      teardown(); // 释放已拿到的麦克风与半建成的音频图
      throw new VoiceCaptureError(
        err instanceof VoiceCaptureError ? err : classifyMicError(err, { hasMediaDevices: true }),
      );
    }
  }

  function stop() {
    finish('manual');
  }

  return {
    start,
    stop,
    get state() {
      return state;
    },
    get stopped() {
      return stopped;
    },
  };
}
