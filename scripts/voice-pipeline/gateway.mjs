// 语音管线 v3 网关（WS /api/voice/v3）：把 ASR 引擎、规则顺滑、即时整理、结构化串成一次说话的会话。
// 协议见 design/voice-pipeline/SPEC.md §2.1。鉴权与 Origin 复用 collaboration（默认拒绝）。
import { WebSocketServer } from 'ws';
import { ruleClean } from './clean.mjs';
import { cleanSegment, structureUtterance } from './llm.mjs';

export const VOICE_V3_PATH = '/api/voice/v3';
const MAX_SESSION_MS = 30 * 60_000; // ponytail: 只防忘关话筒；一口气说几分钟不受限
const VOCAB_MAX = 60;
const IDLE_MS = 2 * 60_000; // 开了不说话也不发包：收掉，别占并发名额
// 思考型模型处理整段原文：字越多给越长的时间（1000 字约 +20s，最多 2 分钟）
const structTimeout = text => Math.min(120_000, 30_000 + text.length * 20);
// 客户端带来的用户常用词（近期事项标题），给意图解析纠正专有名词；只收短字符串
const cleanVocab = v => (Array.isArray(v) ? [...new Set(v.filter(x => typeof x === 'string').map(x => x.replace(/[\u0000-\u001f\u007f、"「」]/g, ' ').trim().slice(0, 30)).filter(Boolean))].slice(0, VOCAB_MAX) : []);

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
    let asr = null, started = false, stopped = false, closed = false, vocab = [];
    let structuring = null, dirty = false, lastItems = [], doneKey = null, lastResult = null, finalizing = false;
    const t0 = Date.now();

    const textOf = key => segs.map(s => (s ? (s.edited ?? s[key] ?? '') : '')).filter(Boolean).join('');
    const runStructure = async final => {
      if (structuring) { dirty = true; return structuring; }
      structuring = (async () => {
        do {
          dirty = false;
          const input = { a: textOf('a'), b: textOf('b') };
          const key = input.a + '\u0000' + input.b;
          if (key === doneKey && lastResult?.source === 'cloud') continue; // 输入没变：不重复调用
          const r = await structure(input, { now: now(), vocab, timeoutMs: structTimeout(input.a + input.b), hedgeMs: final ? 8000 : 120_000 }); // 只在最终一轮对冲（思考型模型正常 4–10s），免得说话中的中间轮挤占并发
          if (closed || finalizing) return; // 已进入最终轮：中间轮结果作废
          lastItems = r.items;
          if (r.source === 'cloud') { doneKey = key; lastResult = r; }
          send({ type: 'items', clean: r.clean, items: r.items, source: r.source, upto: segs.length, final: !!final && !dirty });
        } while (dirty && !closed);
      })().finally(() => { structuring = null; });
      return structuring;
    };

    // 后台任务（中间轮结构化、单句整理）出错只记日志，绝不能变成未处理的拒绝把进程带走
    const bgError = error => log({ event: 'voice-v3-error', message: String(error?.message || error) });
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
      }).catch(bgError));
      runStructure(false).catch(bgError); // 结构化直接用两路原文，不等即时整理（省 ~0.8s）
    };

    async function stop() {
      if (stopped || !asr) return;
      stopped = true;
      let r = { clean: '', items: lastItems, source: 'error' };
      try {
        await asr.finish();
        // 说完：立刻发最终一轮（对冲），不等说话中还在飞的中间轮；中间轮的迟到结果丢弃。
        // 不发规则即时卡片——10-26 实测质量差（「十分@15:00」），界面先出整理文字 + 「正在整理成日程」占位。
        finalizing = true;
        const input = { a: textOf('a'), b: textOf('b') };
        const key = input.a + '\u0000' + input.b;
        r = key === doneKey && lastResult ? lastResult : await structure(input, { now: now(), vocab, timeoutMs: structTimeout(input.a + input.b), hedgeMs: 8000 });
        lastItems = r.items;
        send({ type: 'items', clean: r.clean, items: r.items, source: r.source, upto: segs.length, final: true });
        await Promise.allSettled(cleaning); // 各句整理文字发完再结束
      } finally { // 出错也要收口，客户端不能一直停在「整理中」
        send({ type: 'end', segments: segs.length, ms: Date.now() - t0 });
        log({ event: 'voice-v3', segments: segs.length, ms: Date.now() - t0, items: lastItems.length, source: r.source });
        ws.close(1000);
      }
    }

    // 墙钟上限与空闲回收：音频计时只在收包时检查，挂着不发包的连接要靠这两个定时器收掉
    const hardStop = setTimeout(() => { send({ type: 'error', code: 'session-too-long' }); stop().catch(bgError); }, MAX_SESSION_MS + 60_000);
    let idle = null;
    const touch = () => { clearTimeout(idle); idle = setTimeout(() => (asr && !stopped ? stop().catch(bgError) : ws.close(1000)), IDLE_MS); };
    touch();

    ws.on('message', async (data, isBinary) => {
      touch();
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
          vocab = cleanVocab(msg.vocab);
          const e = await engine;
          asr = e.createSession({ onPartial, onFinal, onAlt });
          send({ type: 'ready' });
        } else if (msg.type === 'edit' && Number.isInteger(msg.seg) && typeof msg.text === 'string' && segs[msg.seg]) {
          segs[msg.seg].edited = msg.text.slice(0, 400);
          runStructure(false).catch(bgError);
        } else if (msg.type === 'stop') {
          await stop();
        }
      } catch (error) {
        send({ type: 'error', code: 'pipeline-failed' });
        log({ event: 'voice-v3-error', message: String(error?.message || error) });
      }
    });
    ws.on('close', () => { closed = true; active -= 1; clearTimeout(hardStop); clearTimeout(idle); });
  }

  return { handleUpgrade, path: VOICE_V3_PATH, close: () => wss.close() };
}
