// VI·V5语音网关 — scripts/voice-gateway.mjs
// 唯一标准：design/voice-intent/SPEC.md §2/§2.1/§2.2
//   浏览器 ↔ 网关 WS 协议（start/PCM/stop ↔ partial/final/end/error）走
//   web/voice/contracts.js（commit 77a59d5），消息与错误码一律复用契约枚举。
//   网关 ↔ FunASR 用 Node 自带 WebSocket 客户端（SPEC §2.2 原文），对端默认
//   ws://127.0.0.1:10195（donego-funasr 容器，SPEC §2.1）。
//
// FunASR 2pass 上游协议的 ground truth 是 Salon9 生产实现（只读参考）：
//   /home/jc/projects/Salon9/services/asr-agent/agent.py
//     · 首帧文本 config JSON：{mode:"2pass", chunk_size:[0,5,5], chunk_interval:10,
//       encoder_chunk_look_back:4, decoder_chunk_look_back:1, wav_name, is_speaking:true}
//     · 之后二进制 PCM16/16k/mono 增量透传
//     · 结束发 {"is_speaking":false}
//     · 2pass-online 文本是【增量】，需累积成快照（test_agent.py「real 12:58
//       live sequence」回放）；2pass-offline 定稿该句（剥行首标点，空文本回退
//       累积）；is_final 只在流结束时出现，与 offline 同为定稿边界
//
// 隐私（SPEC §2.2）：音频只在内存流转、绝不落盘；不记录转写文本；日志只记
// 时长与错误码。wav_name 用随机 hex，不含任何用户数据。
// 会话与 FunASR 连接一比一：会话结束立即关闭上游连接（SPEC §2.1，防长连接
// 内存泄漏），不复用。

import { randomBytes } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { VOICE_SAMPLE_RATE, VOICE_ERROR_CODES, validateClientMessage } from '../web/voice/contracts.js';

export const VOICE_STREAM_PATH = '/api/voice/stream';

// SPEC §2.2：单次 ≤60s；每访客每日 ≤15min；全局并发 ≤3（thinkpad CPU 上限）。
export const DEFAULT_VOICE_LIMITS = Object.freeze({
  sessionMaxMs: 60_000,
  dailyBudgetMs: 15 * 60_000,
  maxConcurrent: 3,
});

// FunASR config 帧默认值。[5,10,5]=600ms 粒度（FunASR 推荐值）：10-25 thinkpad 实测，[0,5,5] 的实时字
// 几乎每个音节成双（"九个底底之前…论论"），[5,10,5] 不再重复、可读得多，首字只慢约 0.2s（0.94→1.13s）。
export const FUNASR_CONFIG_DEFAULTS = Object.freeze({
  mode: '2pass',
  chunkSize: [5, 10, 5],
  chunkInterval: 10,
  encoderChunkLookBack: 4,
  decoderChunkLookBack: 1,
});

// 与 Salon9 agent.py LEADING_PUNCT 同一字符集：offline 定稿常以「，」开头。
export const LEADING_PUNCT = '，。！？、；：,.!?;:…—“”‘’ ()';

export function stripLeadingPunct(text) {
  let i = 0;
  while (i < text.length && LEADING_PUNCT.includes(text[i])) i += 1;
  return i === 0 ? text : text.slice(i);
}

// —— FunASR 帧 → 客户端帧 的纯翻译器（无 IO，可单测）——
// 输入上游 JSON 对象，输出 [{type:'partial'|'final', seg, text}]：
//   online 增量累积为该句快照；offline/is_final 定稿该句并推进 seg。
export function createAsrTranslator() {
  let seg = 0;
  let onlineBuf = '';
  return {
    push(msg) {
      if (msg === null || typeof msg !== 'object') return [];
      const mode = String(msg.mode ?? '');
      const boundary = msg.is_final === true || mode.endsWith('offline');
      const raw = typeof msg.text === 'string' ? msg.text.trim() : '';
      if (boundary) {
        // 定稿：raw 全句优先（剥行首标点），空文本回退累积；都不空则丢累积
        //（Salon9 语义：offline 文本就是整句）。
        const finalText = stripLeadingPunct(raw) || onlineBuf;
        onlineBuf = '';
        if (!finalText) return [];
        const frame = { type: 'final', seg, text: finalText };
        seg += 1;
        return [frame];
      }
      if (mode.endsWith('online') && raw) {
        onlineBuf += raw;
        return [{ type: 'partial', seg, text: onlineBuf }];
      }
      return []; // 无文本控制帧（silence echo 等）忽略
    },
  };
}

const BYTES_PER_MS = (VOICE_SAMPLE_RATE * 2) / 1000; // 16k/16bit/mono = 32 B/ms
const FRAME_SLACK_BYTES = 1920; // 容忍一个 60ms 帧
const DAY_ENTRY_CAP = 4096;
const LOCAL_LOOPBACKS = ['127.0.0.1', '::1', '::ffff:127.0.0.1'];

// 访客键：优先 actor.id（demo/登录会话），匿名回退 IP（与 serve-tango
// createAIGuard 的 visitorKey 同一策略：回环地址时取 x-forwarded-for 末端）。
function ipKey(req) {
  const remote = req.socket?.remoteAddress || 'unknown';
  if (LOCAL_LOOPBACKS.includes(remote)) {
    const forwarded = String(req.headers['x-forwarded-for'] || '').split(',').map(p => p.trim()).filter(Boolean).pop();
    if (forwarded) return forwarded.slice(0, 64);
  }
  return remote;
}
function userKey(req, actor) {
  if (actor && actor.id != null) return 'user:' + String(actor.id).slice(0, 80);
  return 'ip:' + ipKey(req);
}

function dayStamp(time) {
  const date = new Date(time);
  return date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0');
}

const noLog = () => {};

// —— 语音网关 ——
// options：
//   path               路由（默认 /api/voice/stream）
//   authenticate(req)  会话鉴权（复用 collaboration.authenticate：返回 actor
//                      或抛错；demo 会话与登录会话一视同仁）
//   requestAllowed(req) Origin/Host 校验（复用 collaboration.requestAllowed）
//   asrUrl             FunASR 端点（默认 env TANGO_VOICE_ASR_URL｜FUNASR_URL｜
//                      ws://127.0.0.1:10195）
//   asrConfig          config 帧覆盖（默认 FUNASR_CONFIG_DEFAULTS）
//   asrConnectTimeoutMs 上游连接超时（默认 3000）
//   finalDrainMs       stop 后等待尾句 final 的兜底窗口（默认 6000；收到 is_final 立即结束）
//   limits             {sessionMaxMs, dailyBudgetMs, maxConcurrent} 覆盖
//   now / log          注入时钟与日志（测试用）
// 鉴权与 Origin 默认 fail closed：不注入就一律 unauthorized。
export function createVoiceGateway(options = {}) {
  const env = options.env || process.env;
  const path = typeof options.path === 'string' && options.path.startsWith('/') ? options.path : VOICE_STREAM_PATH;
  const limits = { ...DEFAULT_VOICE_LIMITS, ...(options.limits || {}) };
  const asrUrl = options.asrUrl || env.TANGO_VOICE_ASR_URL || env.FUNASR_URL || 'ws://127.0.0.1:10195';
  const asrConfig = { ...FUNASR_CONFIG_DEFAULTS, ...(options.asrConfig || {}) };
  const asrConnectTimeoutMs = options.asrConnectTimeoutMs ?? 3000;
  const finalDrainMs = options.finalDrainMs ?? 20000; // 兜底：收不到 is_final 时最多等 20s（thinkpad 上 14s 语音定稿实测 11.6s）
  const now = options.now || Date.now;
  const log = options.log || noLog;
  const authenticate = typeof options.authenticate === 'function' ? options.authenticate : () => { throw new Error('VOICE_AUTH_NOT_CONFIGURED'); };
  const requestAllowed = typeof options.requestAllowed === 'function' ? options.requestAllowed : () => false;

  const wss = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 });
  let active = 0;
  const daily = new Map(); // key -> {day, ms}

  const pruneDaily = day => {
    if (daily.size > DAY_ENTRY_CAP) for (const [key, value] of daily) if (value.day !== day) daily.delete(key);
  };
  function usedMs(key, day) {
    const slot = daily.get(key);
    return slot && slot.day === day ? slot.ms : 0;
  }
  function chargeMs(key, day, ms) {
    const slot = daily.get(key);
    if (!slot || slot.day !== day) daily.set(key, { day, ms });
    else slot.ms += ms;
    pruneDaily(day);
  }

  // 拒绝：完成握手后发 error 帧再关（浏览器读不到 HTTP 状态，码必须走帧）
  const reject = (req, socket, head, code) => {
    wss.handleUpgrade(req, socket, head, ws => {
      try {
        ws.send(JSON.stringify({ type: 'error', code }));
        ws.close(1008);
      } catch {
        try { ws.terminate(); } catch {}
      }
    });
  };

  function handleUpgrade(req, socket, head) {
    socket.on('error', () => {}); // 防 ECONNRESET 冒泡
    try {
      if (!requestAllowed(req)) return reject(req, socket, head, VOICE_ERROR_CODES.UNAUTHORIZED);
    } catch {
      return reject(req, socket, head, VOICE_ERROR_CODES.UNAUTHORIZED);
    }
    let actor;
    try {
      actor = authenticate(req);
    } catch {
      return reject(req, socket, head, VOICE_ERROR_CODES.UNAUTHORIZED);
    }
    if (active >= limits.maxConcurrent) return reject(req, socket, head, VOICE_ERROR_CODES.BUSY);
    const key = userKey(req, actor);
    const day = dayStamp(now());
    const remaining = limits.dailyBudgetMs - usedMs(key, day);
    if (remaining <= 0) return reject(req, socket, head, VOICE_ERROR_CODES.DAILY_LIMIT);
    wss.handleUpgrade(req, socket, head, ws => startSession(ws, req, key, day, remaining));
  }

  function startSession(ws, req, key, day, remainingMs) {
    active += 1;
    const capMs = Math.max(1, Math.min(limits.sessionMaxMs, remainingMs));
    const allowedBytes = capMs * BYTES_PER_MS + FRAME_SLACK_BYTES;
    const translator = createAsrTranslator();
    let phase = 'awaiting-start'; // awaiting-start → connecting → streaming → draining → ended
    let upstream = null;
    let upstreamOpen = false;
    let startedAt = null;
    let bytesReceived = 0;
    let accounted = false;
    let pendingStop = false;
    const queue = []; // connecting 期间的音频排队（上限由 allowedBytes 兜底）
    let sessionTimer = null;
    let drainTimer = null;
    let connectTimer = null;

    const isOpen = () => ws.readyState === 1; // WebSocket.OPEN
    const send = frame => {
      if (isOpen()) ws.send(JSON.stringify(frame));
    };
    const closeUpstream = () => {
      if (!upstream) return;
      const socket = upstream;
      upstream = null;
      upstreamOpen = false;
      try { socket.close(); } catch {} // CONNECTING 态 close 可能抛错，忽略
      try { if (socket.terminate) socket.terminate(); } catch {}
    };

    function finish(closeCode, errorCode) {
      if (phase === 'ended') return;
      const previous = phase;
      phase = 'ended';
      if (sessionTimer) { clearTimeout(sessionTimer); sessionTimer = null; }
      if (drainTimer) { clearTimeout(drainTimer); drainTimer = null; }
      if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; }
      if (startedAt != null && !accounted) {
        accounted = true;
        const duration = Math.min(Math.max(now() - startedAt, 0), capMs);
        chargeMs(key, day, duration);
        log({ event: 'voice-session', durationMs: duration, code: errorCode || null }); // 只记时长与码
      }
      active -= 1;
      closeUpstream();
      if (errorCode) send({ type: 'error', code: errorCode });
      if (isOpen()) ws.close(closeCode);
      else if (previous !== 'ended') try { ws.terminate(); } catch {}
    }
    const fail = code => finish(1008, code);

    function enterDrain() {
      phase = 'draining';
      drainTimer = setTimeout(() => {
        send({ type: 'end' });
        finish(1000);
      }, finalDrainMs);
    }

    function onUpstreamMessage(event) {
      if (phase === 'ended') return;
      if (typeof event.data !== 'string') return; // 只认 JSON 文本帧
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      for (const frame of translator.push(msg)) send(frame);
      // 收尾期拿到 FunASR 的 is_final（离线定稿）就立刻结束，不再靠计时窗口碰运气（thinkpad 定稿解码 ~2s）
      if (phase === 'draining' && msg.is_final === true) {
        if (drainTimer) { clearTimeout(drainTimer); drainTimer = null; }
        send({ type: 'end' });
        finish(1000);
      }
    }
    function onUpstreamGone() {
      if (phase === 'ended') return;
      fail(VOICE_ERROR_CODES.ASR_UNAVAILABLE);
    }
    function onUpstreamOpen() {
      if (phase !== 'connecting') return;
      if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; }
      upstreamOpen = true;
      const config = {
        mode: asrConfig.mode,
        chunk_size: [...asrConfig.chunkSize],
        chunk_interval: asrConfig.chunkInterval,
        encoder_chunk_look_back: asrConfig.encoderChunkLookBack,
        decoder_chunk_look_back: asrConfig.decoderChunkLookBack,
        wav_name: 'donego-' + randomBytes(8).toString('hex'), // 随机名，不携带用户数据
        is_speaking: true,
      };
      try { upstream.send(JSON.stringify(config)); } catch { return onUpstreamGone(); }
      phase = 'streaming';
      for (const buffer of queue) { try { upstream.send(buffer); } catch { queue.length = 0; return onUpstreamGone(); } }
      queue.length = 0;
      if (pendingStop) {
        pendingStop = false;
        try { upstream.send(JSON.stringify({ is_speaking: false })); } catch { return onUpstreamGone(); }
        return enterDrain();
      }
    }
    function connectUpstream() {
      let socket;
      try { socket = new WebSocket(asrUrl); } catch { return fail(VOICE_ERROR_CODES.ASR_UNAVAILABLE); }
      upstream = socket;
      socket.addEventListener('open', onUpstreamOpen);
      socket.addEventListener('message', onUpstreamMessage);
      socket.addEventListener('close', onUpstreamGone);
      socket.addEventListener('error', onUpstreamGone);
      connectTimer = setTimeout(() => {
        if (phase === 'connecting') {
          closeUpstream();
          fail(VOICE_ERROR_CODES.ASR_UNAVAILABLE);
        }
      }, asrConnectTimeoutMs);
    }

    function onStart(message) {
      if (phase !== 'awaiting-start') return fail(VOICE_ERROR_CODES.BAD_MESSAGE);
      if (message.sampleRate !== VOICE_SAMPLE_RATE) return fail(VOICE_ERROR_CODES.BAD_MESSAGE); // SPEC 固定 16k
      startedAt = now();
      sessionTimer = setTimeout(() => fail(VOICE_ERROR_CODES.SESSION_TOO_LONG), capMs);
      phase = 'connecting';
      connectUpstream();
    }
    function onAudio(buffer) {
      if (phase === 'ended' || phase === 'draining') return;
      if (phase === 'awaiting-start') return fail(VOICE_ERROR_CODES.BAD_MESSAGE);
      bytesReceived += buffer.length;
      if (bytesReceived > allowedBytes) return fail(VOICE_ERROR_CODES.SESSION_TOO_LONG); // 突发超长按会话超时处理
      if (phase === 'connecting') { queue.push(buffer); return; }
      if (upstream && upstreamOpen) { try { upstream.send(buffer); } catch { onUpstreamGone(); } }
    }
    function onStop() {
      if (phase === 'awaiting-start') {
        send({ type: 'end' });
        return finish(1000);
      }
      if (phase === 'connecting') { pendingStop = true; return; }
      if (phase === 'streaming') {
        try { upstream.send(JSON.stringify({ is_speaking: false })); } catch { return onUpstreamGone(); }
        return enterDrain();
      }
      // draining / ended：幂等忽略
    }

    ws.on('message', (data, isBinary) => {
      if (isBinary) return onAudio(Buffer.from(data));
      let msg;
      try { msg = JSON.parse(data.toString('utf8')); } catch { return fail(VOICE_ERROR_CODES.BAD_MESSAGE); }
      const checked = validateClientMessage(msg);
      if (!checked.ok) return fail(VOICE_ERROR_CODES.BAD_MESSAGE);
      if (checked.value.type === 'start') return onStart(checked.value);
      return onStop();
    });
    ws.on('close', () => finish(1000));
    ws.on('error', () => finish(1011));
  }

  return {
    path,
    limits: { ...limits },
    handleUpgrade,
    attach(server) {
      const handler = (req, socket, head) => {
        let pathname = '';
        try { pathname = new URL(req.url, 'http://127.0.0.1').pathname; } catch { socket.destroy(); return; }
        if (pathname !== path) {
          // 只在自己不是唯一 upgrade 监听者时让路（多 WS 路由共存）
          if (server.listenerCount('upgrade') > 1) return;
          socket.destroy();
          return;
        }
        handleUpgrade(req, socket, head);
      };
      server.on('upgrade', handler);
      return () => server.off('upgrade', handler);
    },
    close() {
      wss.close();
    },
    usage() {
      return {
        active,
        path,
        limits: { ...limits },
        daily: [...daily].map(([key, value]) => ({ key, day: value.day, ms: value.ms })),
      };
    },
  };
}
