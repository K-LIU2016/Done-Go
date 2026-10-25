// web/voice/voice-home.js — 首页语音接入编排。
//
// 只组合 voice/ 下已有的采集、流客户端、增量转写、意图卡与 voice-sheet；
// 不落盘音频/转写。首页只接收用户在「全部加入」后确认的 items，由调用方写入
// 既有 tango-donego.web.v1 账本。

import { createVoiceCapture } from './capture.js';
import { createVoiceStream, voiceStreamUrl, STREAM_STATUS } from './stream-client.js';
import { createTranscriptView } from './transcript-view.js';
import { createIntentView } from './intent-view.js';
import { createVoiceSheet } from './voice-sheet.js';

function ensureVoiceHomeStyles(doc) {
  if (!doc || doc.getElementById('voice-home-styles')) return;
  const link = doc.createElement('link');
  link.id = 'voice-home-styles';
  link.rel = 'stylesheet';
  link.href = '/voice/voice-home.css';
  doc.head?.appendChild(link);
}

export function voiceHomeAvailable(root = globalThis) {
  const media = root?.navigator?.mediaDevices;
  return !!(
    media && typeof media.getUserMedia === 'function'
    && (typeof root.AudioContext === 'function' || typeof root.webkitAudioContext === 'function')
    && root.location && root.location.host
    && (typeof root.WebSocket === 'function' || typeof globalThis.WebSocket === 'function')
  );
}

function nowWithOffset(date = new Date()) {
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const abs = Math.abs(offset);
  return date.toISOString().slice(0, 19)
    + sign + String(Math.floor(abs / 60)).padStart(2, '0')
    + ':' + String(abs % 60).padStart(2, '0');
}

function timezone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai'; }
  catch { return 'Asia/Shanghai'; }
}

function appendWaveBars(doc, wave) {
  for (let i = 0; i < 15; i += 1) {
    const bar = doc.createElement('i');
    bar.className = 'relay-voice-bar';
    wave.appendChild(bar);
  }
}

function requestIntent(fetchImpl, transcript, edit, onDone) {
  if (typeof fetchImpl !== 'function') {
    onDone(new Error('intent-fetch-unavailable'));
    return;
  }
  const body = { transcript, now: nowWithOffset(), tz: timezone() };
  if (edit) body.edit = edit;
  fetchImpl('/api/voice/intent', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).then((response) => response.json().then((data) => {
    if (!response.ok) throw new Error(data?.error || 'intent-failed');
    return data;
  })).then((data) => onDone(null, data)).catch((error) => onDone(error));
}

/**
 * Open the production voice sheet.
 *
 * opts: { root, fetchImpl, onComplete(items), onDismiss(reason), onStatus(status) }
 * The returned controller exposes close() and isOpen(). All audio/WebSocket
 * resources are stopped on close, route teardown, error, or confirmation.
 */
export function createVoiceHomeSession(options = {}) {
  const root = options.root || globalThis;
  const doc = options.doc || root.document;
  if (!doc || typeof doc.createElement !== 'function') throw new TypeError('createVoiceHomeSession requires a DOM document');
  ensureVoiceHomeStyles(doc);
  const fetchImpl = options.fetchImpl || (typeof root.fetch === 'function' ? root.fetch.bind(root) : null);
  let sheet = null;
  let capture = null;
  let stream = null;
  let transcript = null;
  let intent = null;
  let clock = null;
  let closed = false;
  let transcriptText = '';

  const cleanup = () => {
    if (clock != null) { clearInterval(clock); clock = null; }
    try { capture?.stop(); } catch { /* best effort */ }
    try { stream?.close(); } catch { /* best effort */ }
    capture = null;
    stream = null;
    transcript = null;
    intent = null;
  };

  const close = (reason = 'programmatic') => {
    if (closed) return;
    closed = true;
    cleanup();
    try { sheet?.close(reason); } catch { /* best effort */ }
    sheet = null;
    options.onDismiss?.(reason);
  };

  const listenContent = doc.createElement('div');
  listenContent.className = 'relay-voice-content';
  listenContent.innerHTML = '<div class="relay-voice-top"><strong>正在听</strong><span data-voice-clock>0:00</span></div>'
    + '<div data-voice-transcript></div><div class="relay-voice-wave" data-voice-wave aria-hidden="true"></div>'
    + '<p class="relay-voice-hint">停顿 2 秒自动结束 · 可以一次说好几件事</p>'
    + '<button type="button" class="btn dark wide" data-voice-stop>说完了</button>'
    + '<p class="relay-voice-error" data-voice-error role="status"></p>';
  const transcriptHost = listenContent.querySelector('[data-voice-transcript]');
  const clockHost = listenContent.querySelector('[data-voice-clock]');
  const wave = listenContent.querySelector('[data-voice-wave]');
  const stopButton = listenContent.querySelector('[data-voice-stop]');
  const errorHost = listenContent.querySelector('[data-voice-error]');
  appendWaveBars(doc, wave);
  transcript = createTranscriptView({ doc });
  transcriptHost.appendChild(transcript.el);

  const startUnderstanding = () => {
    const text = transcript?.text().trim() || transcriptText.trim();
    if (!text) {
      errorHost.textContent = '没听到声音，再点一次说';
      return;
    }
    transcriptText = text;
    cleanup();
    try { sheet?.close('voice-understanding'); } catch { /* best effort */ }
    const review = doc.createElement('div');
    intent = createIntentView({
      now: nowWithOffset(),
      tz: timezone(),
      onReask: () => createVoiceHomeSession(options),
      onCorrectVoice: () => createVoiceHomeSession(options),
      onConfirmAll: (items) => {
        options.onComplete?.(items);
        close('voice-finished');
      },
    });
    review.appendChild(intent.element);
    sheet = createVoiceSheet({ label: '语音识别结果' });
    sheet.open(review);
    const started = intent.setUnderstanding({ transcript: text, now: nowWithOffset(), tz: timezone() });
    if (!started.ok) {
      intent.showError('bad-message');
      return;
    }
    requestIntent(fetchImpl, text, null, (error, data) => {
      if (error) intent.showError('bad-message');
      else intent.showDraft(data);
    });
  };

  stopButton.addEventListener('click', () => {
    try { stream?.stop(); } catch { /* best effort */ }
    try { capture?.stop(); } catch { /* best effort */ }
    startUnderstanding();
  });

  sheet = createVoiceSheet({
    label: '语音输入',
    onDismiss: (reason) => {
      if (reason !== 'voice-understanding' && reason !== 'voice-finished') {
        cleanup();
        if (!closed) {
          closed = true;
          options.onDismiss?.(reason);
        }
      }
    },
  });
  sheet.open(listenContent);
  const startedAt = Date.now();
  clock = setInterval(() => {
    const elapsed = Math.floor((Date.now() - startedAt) / 1000);
    clockHost.textContent = Math.floor(elapsed / 60) + ':' + String(elapsed % 60).padStart(2, '0');
  }, 250);

  try {
    stream = createVoiceStream({
      url: voiceStreamUrl(root.location),
      onUpdate: (view) => transcript?.update(view),
      onStatus: (status, detail) => {
        options.onStatus?.(status, detail);
        if (status === STREAM_STATUS.FAILED && detail?.hint) errorHost.textContent = detail.hint;
      },
    });
    stream.start();
    capture = createVoiceCapture({
      workletURL: new URL('./pcm-worklet.js', import.meta.url),
      onFrame: (pcm) => stream?.sendAudio(pcm),
      onLevel: (level) => {
        const amount = Math.max(0, Math.min(1, Number(level) || 0));
        Array.from(wave.children).forEach((bar, index) => {
          const shape = Math.sin(Math.PI * (index + 0.5) / 15);
          bar.style.height = `${8 + Math.round(amount * 32 * shape)}px`;
        });
      },
      onAutoStop: startUnderstanding,
      onTimer: (elapsed) => {
        clockHost.textContent = Math.floor(elapsed / 60000) + ':' + String(Math.floor(elapsed / 1000) % 60).padStart(2, '0');
      },
    });
    capture.start().catch((error) => {
      errorHost.textContent = error?.message || '无法使用话筒 · 检查设备后重试';
      options.onStatus?.(STREAM_STATUS.FAILED, { code: error?.kind || 'mic-error' });
    });
  } catch (error) {
    errorHost.textContent = '语音转写暂不可用 · 可以直接打字';
    options.onStatus?.(STREAM_STATUS.FAILED, { code: error?.message || 'voice-init-failed' });
  }

  return { close, get isOpen() { return !closed && !!sheet?.isOpen; } };
}
