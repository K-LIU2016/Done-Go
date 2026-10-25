// web/voice/stream-client.js — Done-Go 语音 → 意图 → 日程 第一期 · V2流客户端。
// 唯一标准：design/voice-intent/SPEC.md
//   §2.2 客户端 ↔ 网关 WS 协议：先发 {"type":"start","sampleRate":16000}，随后二进制
//        PCM 帧，最后 {"type":"stop"}；网关回 partial/final/end/error。
//        FunASR 不可达（asr-unavailable）→ 前端降级 webkitSpeechRecognition，
//        再不可用 → 提示「语音暂时不可用，打字也行」。
//   §3   stream-client 职责：WebSocket 协议、重连一次、按 seg 合并 partial 和 final。
// 合并语义不在本文件重复实现——统一走 web/voice/contracts.js 的
// applyServerMessage / transcriptView（VI·契约 commit 77a59d5 定稿）。
// 环境约束：浏览器 ES module 与 Node 单测共用；不在 import 时触碰 DOM/window，
// WebSocket 与 SpeechRecognition 均可注入（测试用内存假实现，零网络）。
import {
  VOICE_SAMPLE_RATE,
  VOICE_ERROR_CODES,
  initTranscriptState,
  applyServerMessage,
  transcriptView,
  validateServerMessage,
} from './contracts.js';

export const VOICE_STREAM_PATH = '/api/voice/stream';

// 生命周期：idle → connecting → open →（异常断开）reconnecting → open → ended
//           ↘ error 帧（非 asr-unavailable）→ failed
//           ↘ asr-unavailable 或 WS 路径两连败 → fallback（webkitSpeechRecognition）→ ended | failed
//           任意时刻 close() → closed（取消挂起重连，不再降级）
export const STREAM_STATUS = Object.freeze({
  IDLE: 'idle',
  CONNECTING: 'connecting',
  OPEN: 'open',
  RECONNECTING: 'reconnecting',
  ENDED: 'ended',
  FALLBACK: 'fallback',
  FAILED: 'failed',
  CLOSED: 'closed',
});

export const FALLBACK_HINT = '语音暂时不可用，打字也行'; // SPEC §2.2 原文提示

// 同源 WS URL：页面 https → wss，http → ws（SPEC §2：wss://<host>/api/voice/stream）。
export function voiceStreamUrl(loc) {
  const l = loc ?? globalThis.location;
  if (!l || !l.host) throw new Error('voiceStreamUrl: location unavailable（非浏览器环境需显式传入）');
  const proto = l.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${l.host}${VOICE_STREAM_PATH}`;
}

// 降级探测：优先标准名，回退 webkit 前缀（iOS Safari）；无 → null。
export function getSpeechRecognitionCtor(env) {
  const e = env ?? globalThis;
  return (e && e.SpeechRecognition) || (e && e.webkitSpeechRecognition) || null;
}

// webkitSpeechRecognition 结果 → 本协议消息（纯函数）：
// 结果下标即 seg，interim → partial、final → final，喂给同一部 seg 合并机，
// 降级路径与 WS 路径产出完全一致的 {finalText, partialText} 视图。
// 定序冻结：一旦下标 i 为 final，更小下标的 interim 一并冻结为 final——
// SR 定稿按序发生，后句定稿后前句文本不再修订；这样「黑字前缀 + 灰字尾巴」
// 的不变量（SPEC §3 已确认前缀保持稳定）在降级路径同样成立。
export function speechResultsToMessages(event) {
  const out = [];
  const results = event && event.results;
  if (!results) return out;
  let maxFinal = -1;
  for (let i = 0; i < results.length; i++) {
    if (results[i] && results[i].isFinal) maxFinal = i;
  }
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const alt0 = r && r[0];
    if (!alt0 || typeof alt0.transcript !== 'string') continue;
    out.push({ type: i <= maxFinal ? 'final' : 'partial', seg: i, text: alt0.transcript });
  }
  return out;
}

const defaultSocketFactory = (url) => new globalThis.WebSocket(url);
const defaultSpeechRecognitionFactory = () => {
  const Ctor = getSpeechRecognitionCtor();
  return Ctor ? new Ctor() : null;
};

// createVoiceStream({url, socketFactory?, speechRecognitionFactory?, sampleRate?,
//   reconnectDelayMs?=300, reconnectAttempts?=1, bufferedAmountLimit?=4MiB,
//   onUpdate?(view), onStatus?(status, detail), onMessage?(validatedServerMsg)})
// 返回 client：start() / sendAudio(bytes) / stop() / close() / getStatus() /
// getMode()('ws'|'fallback'|'none') / getError() / getView() / getReconnectCount()。
export function createVoiceStream(options = {}) {
  const url = options.url;
  if (typeof url !== 'string' || url.length === 0) throw new Error('createVoiceStream: url 必须是 ws(s):// 地址');
  const socketFactory = options.socketFactory ?? defaultSocketFactory;
  const speechRecognitionFactory = options.speechRecognitionFactory ?? defaultSpeechRecognitionFactory;
  const sampleRate = options.sampleRate ?? VOICE_SAMPLE_RATE;
  const reconnectDelayMs = options.reconnectDelayMs ?? 300;
  const reconnectAttempts = options.reconnectAttempts ?? 1; // SPEC §3：重连一次
  const bufferedAmountLimit = options.bufferedAmountLimit ?? 1 << 22; // 4MiB 背压保护
  const { onUpdate, onStatus, onMessage } = options;

  let state = initTranscriptState();
  let status = STREAM_STATUS.IDLE;
  let mode = 'ws'; // 'ws' | 'fallback' | 'none'
  let error = null;
  let socket = null;
  let sr = null;
  let attempt = 0; // 已建立的 WS 连接数（含首连）
  let stopRequested = false;
  let terminal = false; // ended / failed：不再重连
  let manualClosed = false;
  let srFailed = false;
  let reconnectTimer = null;

  const setStatus = (s, detail) => {
    status = s;
    if (typeof onStatus === 'function') onStatus(s, detail);
  };
  const emitView = () => {
    if (typeof onUpdate === 'function') onUpdate(transcriptView(state));
  };
  // 应用一条已校验的 partial/final（WS 帧与降级 SR 结果共用；迟到 partial 不回退定稿）。
  const applyTranscriptMessage = (msg) => {
    const next = applyServerMessage(state, msg);
    if (next === state) return; // 无变化（如迟到 partial）不重渲染
    state = next;
    emitView();
  };
  const clearTimer = () => {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  };
  const closeSocketQuiet = () => {
    const s = socket;
    socket = null;
    if (s && s.readyState < 2) {
      try { s.close(1000); } catch { /* 已在关闭 */ }
    }
  };

  // —— error 帧策略（SPEC §2.2）：asr-unavailable 立即降级；其余限额/鉴权错误终态失败 ——
  const handleErrorFrame = (code) => {
    error = code;
    if (code === VOICE_ERROR_CODES.ASR_UNAVAILABLE) {
      engageFallback('asr-unavailable');
      return;
    }
    terminal = true;
    setStatus(STREAM_STATUS.FAILED, { code });
    closeSocketQuiet();
  };

  const handleFrame = (data) => {
    let parsed;
    try { parsed = JSON.parse(data); } catch { return; } // 非 JSON 帧忽略，连接继续
    const r = validateServerMessage(parsed);
    if (!r.ok) return; // 不合协议的帧忽略（网关侧自有 bad-message 治理）
    const msg = r.value;
    onMessage?.(msg);
    if (msg.type === 'partial' || msg.type === 'final') {
      applyTranscriptMessage(msg);
    } else if (msg.type === 'end') {
      terminal = true;
      setStatus(STREAM_STATUS.ENDED);
      closeSocketQuiet(); // 正常收尾：干净关连接，绝不去重连
    } else if (msg.type === 'error') {
      applyServerMessage(state, msg); // error 只进 state.error，segments 不变
      handleErrorFrame(msg.code);
    }
  };

  const doConnect = () => {
    attempt++;
    setStatus(STREAM_STATUS.CONNECTING);
    const s = socketFactory(url);
    socket = s;
    s.onopen = () => {
      s.send(JSON.stringify({ type: 'start', sampleRate })); // SPEC §2.2 握手
      if (stopRequested) s.send(JSON.stringify({ type: 'stop' })); // 断线期间说过「说完了」→ 补发收尾
      setStatus(STREAM_STATUS.OPEN);
    };
    s.onmessage = (ev) => handleFrame(ev.data);
    s.onclose = () => {
      if (s !== socket) return; // 旧连接的迟到事件
      if (mode !== 'ws' || terminal || manualClosed) return; // 已收尾/已降级/手动关 → 不重连
      if (attempt < 1 + reconnectAttempts) { // SPEC §3：只重连一次
        setStatus(STREAM_STATUS.RECONNECTING);
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          doConnect();
        }, reconnectDelayMs);
      } else {
        engageFallback('ws-failed'); // WS 路径失败 → 降级
      }
    };
  };

  // —— 降级 webkitSpeechRecognition（SPEC §2.2）：结果映射进同一 seg 合并机 ——
  const engageFallback = (reason) => {
    clearTimer();
    let recognition = null;
    try { recognition = speechRecognitionFactory(); } catch { recognition = null; }
    if (!recognition) { // 浏览器也不支持 → 回到文字输入的提示
      terminal = true;
      setStatus(STREAM_STATUS.FAILED, { reason, hint: FALLBACK_HINT });
      closeSocketQuiet();
      return;
    }
    mode = 'fallback'; // 先切 mode，旧连接 onclose 由此忽略
    closeSocketQuiet();
    srFailed = false;
    recognition.lang = 'zh-CN';
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.onresult = (ev) => {
      for (const m of speechResultsToMessages(ev)) applyTranscriptMessage(m);
    };
    recognition.onerror = () => { srFailed = true; };
    recognition.onend = () => {
      if (manualClosed) return;
      if (srFailed) setStatus(STREAM_STATUS.FAILED, { reason: 'fallback-error', hint: FALLBACK_HINT });
      else setStatus(STREAM_STATUS.ENDED);
    };
    try {
      recognition.start();
    } catch {
      setStatus(STREAM_STATUS.FAILED, { reason: 'fallback-error', hint: FALLBACK_HINT });
      return;
    }
    sr = recognition;
    setStatus(STREAM_STATUS.FALLBACK, { reason });
  };

  return {
    start() {
      if (status !== STREAM_STATUS.IDLE) return;
      doConnect();
    },
    // 二进制 PCM 帧（16kHz/16bit/mono，由 capture.js 产出）。仅 WS open 时发送；
    // 未连接 / 降级模式 / 已收尾：静默丢弃；bufferedAmount 超限跳帧防内存堆积。
    sendAudio(bytes) {
      if (mode !== 'ws' || status !== STREAM_STATUS.OPEN) return;
      const s = socket;
      if (!s || s.readyState !== 1) return;
      if ((s.bufferedAmount | 0) > bufferedAmountLimit) return;
      s.send(bytes);
    },
    // 说完了（手动 / 静音 2s / 60s 上限由 capture 层触发）。幂等；断线挂起时由重连握手补发。
    stop() {
      if (stopRequested) return;
      stopRequested = true;
      if (mode === 'fallback') {
        if (sr && typeof sr.stop === 'function') sr.stop();
        return;
      }
      if (socket && socket.readyState === 1) socket.send(JSON.stringify({ type: 'stop' }));
    },
    // 手动关闭：取消挂起重连、不触发降级、停掉降级 SR。
    close() {
      clearTimer();
      manualClosed = true;
      if (sr) {
        try { if (typeof sr.stop === 'function') sr.stop(); } catch { /* 忽略 */ }
        sr = null;
      }
      closeSocketQuiet();
      mode = 'none';
      setStatus(STREAM_STATUS.CLOSED);
    },
    getStatus: () => status,
    getMode: () => mode,
    getError: () => error,
    getView: () => transcriptView(state),
    getReconnectCount: () => Math.max(0, attempt - 1),
  };
}
