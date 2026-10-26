// 语音管线 v3 网关（WS /api/voice/v3）：把 ASR 引擎、规则顺滑、即时整理、结构化串成一次说话的会话。
// 协议见 design/voice-pipeline/SPEC.md §2.1。鉴权与 Origin 复用 collaboration（默认拒绝）。
import { WebSocketServer } from 'ws';
import { ruleClean } from './clean.mjs';
import { cleanSegment, structureUtterance, ruleItems } from './llm.mjs';

export const VOICE_V3_PATH = '/api/voice/v3';
const MAX_SESSION_MS = 60_000;

/** 当前时刻的 ISO（带 +08:00），供时间解析。 */
export function shanghaiNow(date = new Date()) {
  const t = new Date(date.getTime() + 8 * 3600_000);
  return t.toISOString().slice(0, 19) + '+08:00';
}

export function createVoiceV3Gateway({
  engine, // Promise<{createSession}> 或对象；ASR 引擎
  authenticate = () => { throw new Error('AUTH_REQUIRED'); },
  requestAllowed = () => false,
  clean = cleanSegment,
  structure = structureUtterance,
  now = () => shanghaiNow(),
  maxConcurrent = 3,
  log = () => {},
} = {}) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 });
  let active = 0;

  function handleUpgrade(req, socket, head) {
    const reject = (code, status) => { try { socket.end(`HTTP/1.1 ${status} ${code}\r\nConnection: close\r\n\r\n`); } catch {} };
    if (!requestAllowed(req)) return reject('ORIGIN_REJECTED', 403);
    try { authenticate(req); } catch { return reject('AUTH_REQUIRED', 401); }
    if (active >= maxConcurrent) return reject('BUSY', 503);
    wss.handleUpgrade(req, socket, head, ws => session(ws));
  }

  async function session(ws) {
    active += 1;
    const send = msg => { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); };
    const segs = []; // { a, b, clean, edited }
    const cleaning = [];
    let asr = null, started = false, stopped = false, closed = false;
    let structuring = null, dirty = false, lastItems = [];
    const t0 = Date.now();

    const textOf = key => segs.map(s => (s ? (s.edited ?? s[key] ?? '') : '')).filter(Boolean).join('');
    const runStructure = async final => {
      if (structuring) { dirty = true; return structuring; }
      structuring = (async () => {
        do {
          dirty = false;
          const r = await structure({ a: textOf('a'), b: textOf('b') }, { now: now() });
          if (closed) return;
          lastItems = r.items;
          send({ type: 'items', clean: r.clean, items: r.items, source: r.source, upto: segs.length, final: !!final && !dirty });
        } while (dirty && !closed);
      })().finally(() => { structuring = null; });
      return structuring;
    };

    const onPartial = (seg, text) => send({ type: 'partial', seg, text });
    const onFinal = (seg, { a, msA }) => {
      segs[seg] = { ...(segs[seg] || {}), a };
      send({ type: 'final', seg, text: ruleClean(a) || a, a, ms: msA });
    };
    const onAlt = (seg, { b }) => {
      segs[seg] = { ...(segs[seg] || {}), b };
      const s = segs[seg];
      cleaning.push(clean({ a: s.a || '', b }).then(r => {
        if (closed || s.edited != null) return; // 用户改过的句子不再覆盖
        s.clean = r.text;
        send({ type: 'clean', seg, text: r.text, source: r.source });
        runStructure(false);
      }));
    };

    async function stop() {
      if (stopped || !asr) return;
      stopped = true;
      await asr.finish();
      await Promise.all(cleaning);
      // 先给规则卡片（说完瞬间），云端结果到了再无感替换
      const quick = segs.map(s => s?.edited ?? s?.clean ?? ruleClean(s?.a || '')).join('');
      send({ type: 'items', clean: quick, items: ruleItems(quick, now()), source: 'rule', upto: segs.length, final: false, quick: true });
      if (structuring) await structuring;
      await runStructure(true);
      send({ type: 'end', segments: segs.length, ms: Date.now() - t0 });
      log({ event: 'voice-v3', segments: segs.length, ms: Date.now() - t0, items: lastItems.length });
      ws.close(1000);
    }

    ws.on('message', async (data, isBinary) => {
      try {
        if (isBinary) {
          if (!started || stopped) return;
          if (asr.receivedMs > MAX_SESSION_MS) { send({ type: 'error', code: 'session-too-long' }); return stop(); }
          return asr.accept(Buffer.from(data));
        }
        const msg = JSON.parse(String(data));
        if (msg.type === 'start' && !started) {
          if (msg.sampleRate !== 16000) { send({ type: 'error', code: 'bad-sample-rate' }); return ws.close(1008); }
          started = true;
          const e = await engine;
          asr = e.createSession({ onPartial, onFinal, onAlt });
          send({ type: 'ready' });
        } else if (msg.type === 'edit' && Number.isInteger(msg.seg) && typeof msg.text === 'string' && segs[msg.seg]) {
          segs[msg.seg].edited = msg.text.slice(0, 400);
          runStructure(false);
        } else if (msg.type === 'stop') {
          await stop();
        }
      } catch (error) {
        send({ type: 'error', code: 'pipeline-failed' });
        log({ event: 'voice-v3-error', message: String(error?.message || error) });
      }
    });
    ws.on('close', () => { closed = true; active -= 1; });
  }

  return { handleUpgrade, path: VOICE_V3_PATH, close: () => wss.close() };
}
