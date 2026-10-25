import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer, request } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import {
  VOICE_STREAM_PATH,
  DEFAULT_VOICE_LIMITS,
  LEADING_PUNCT,
  stripLeadingPunct,
  createAsrTranslator,
  createVoiceGateway,
} from "../../scripts/voice-gateway.mjs";
import { VOICE_ERROR_CODES, VOICE_SAMPLE_RATE } from "../../web/voice/contracts.js";

// VI·V5语音网关 — scripts/voice-gateway.mjs 单测（先 RED 后实现）。
// 唯一标准 design/voice-intent/SPEC.md §2.2：
//   鉴权与 Origin 校验、限额（单次 60s / 每用户每日 15min / 全局并发 3）、
//   FunASR 2pass 客户端协议装配、音频只在内存流转、错误码齐全。
// 上游协议语义以 Salon9 生产实现为 ground truth（services/asr-agent/agent.py
// 「FunASR 2pass protocol」注释 + test_agent.py TestTwoPassProtocolTranslation）：
//   首帧 config JSON → 二进制 PCM16 增量 → {is_speaking:false} 结束；
//   2pass-online 文本是增量、累积成快照；2pass-offline 定稿该句（剥行首标点，
//   空文本回退累积）；is_final 只在流结束时出现。

const CODES = VOICE_ERROR_CODES;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const pcm = bytes => Buffer.alloc(bytes, 1); // 合成 PCM 帧（不使用真人音频）

// —— 浏览器侧客户端（ws 包客户端便于带 Origin/cookie 头）——
function dial(url, { headers = {} } = {}) {
  const ws = new WebSocket(url, { headers });
  const frames = [];
  const waiters = [];
  let closed = null;
  const closedWaiters = [];
  ws.on("message", data => {
    let frame; try { frame = JSON.parse(data.toString("utf8")); } catch { frame = { type: "raw", text: data.toString("utf8") }; }
    frames.push(frame);
    for (let i = waiters.length - 1; i >= 0; i--) if (waiters[i](frame)) waiters.splice(i, 1);
  });
  ws.on("close", (code, reason) => {
    closed = { code, reason: reason.toString("utf8") };
    for (const w of closedWaiters) w(closed);
  });
  let openPromise = null;
  const ready = () => {
    if (!openPromise) openPromise = new Promise(resolve => { if (ws.readyState === 1) resolve(); else ws.once("open", resolve); });
    return openPromise;
  };
  return {
    ws, frames, closed: () => closed, ready,
    send: value => { ready().then(() => { try { ws.send(value); } catch {} }).catch(() => {}); },
    json: value => { ready().then(() => { try { ws.send(JSON.stringify(value)); } catch {} }).catch(() => {}); },
    // 等到出现满足条件的帧（默认任意一帧）
    async next(match = () => true, timeoutMs = 4000) {
      const found = frames.find(match);
      if (found) return found;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("timeout waiting frame; got " + JSON.stringify(frames))), timeoutMs);
        waiters.push(frame => { if (match(frame)) { clearTimeout(timer); resolve(frame); return true; } return false; });
      });
    },
    async waitClosed(timeoutMs = 4000) {
      if (closed) return closed;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("timeout waiting close")), timeoutMs);
        closedWaiters.push(value => { clearTimeout(timer); resolve(value); });
      });
    },
    close() { try { ws.close(); } catch {} },
  };
}

// —— 假 FunASR 上游（本地 ws 服务器，按 2pass 协议回话）——
async function startFakeUpstream(t) {
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise((resolve, reject) => { wss.once("listening", resolve); wss.once("error", reject); });
  const peers = [];
  wss.on("connection", ws => {
    const peer = { ws, texts: [], binaries: [], closed: false };
    peers.push(peer);
    ws.on("message", (data, isBinary) => {
      if (isBinary) peer.binaries.push(Buffer.from(data));
      else {
        let msg; try { msg = JSON.parse(data.toString("utf8")); } catch { msg = { raw: data.toString("utf8") }; }
        peer.texts.push(msg);
      }
    });
    ws.on("close", () => { peer.closed = true; });
  });
  const url = "ws://127.0.0.1:" + wss.address().port;
  t.after(() => { for (const p of peers) p.ws.close(); wss.close(); });
  return {
    url, peers,
    last: () => peers[peers.length - 1],
    async waitPeer(timeoutMs = 4000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline && peers.length === 0) await sleep(20);
      assert.ok(peers.length > 0, "fake upstream got no connection");
      const deadline2 = Date.now() + timeoutMs;
      while (Date.now() < deadline2 && this.last().texts.length === 0) await sleep(20);
      return this.last();
    },
  };
}

// —— 网关 + 裸 http server（upgrade 挂载）——
function startGateway(t, upstream, options = {}) {
  const gateway = createVoiceGateway({
    authenticate: () => ({ id: "user-1" }),
    requestAllowed: () => true,
    asrUrl: upstream.url,
    log: () => {},
    ...options,
  });
  const server = createServer(() => {});
  gateway.attach(server);
  return new Promise(resolve => {
    server.listen(0, "127.0.0.1", () => resolve({
      gateway, server,
      url: "ws://127.0.0.1:" + server.address().port + (gateway.path || VOICE_STREAM_PATH),
    }));
  }).then(handle => {
    t.after(() => {
      gateway.close();
      server.close();
      if (server.closeAllConnections) server.closeAllConnections(); // 失败用例的残余连接兜底
    });
    return handle;
  });
}

test("默认限额与 SPEC §2.2 一致（60s / 15min / 并发 3）", () => {
  assert.equal(DEFAULT_VOICE_LIMITS.sessionMaxMs, 60_000);
  assert.equal(DEFAULT_VOICE_LIMITS.dailyBudgetMs, 15 * 60_000);
  assert.equal(DEFAULT_VOICE_LIMITS.maxConcurrent, 3);
  assert.equal(VOICE_SAMPLE_RATE, 16_000);
});

test("stripLeadingPunct 只剥行首标点（Salon9 同一字符集）", () => {
  assert.equal(stripLeadingPunct("，我说让我测试一下。"), "我说让我测试一下。");
  assert.equal(stripLeadingPunct("。？！plain"), "plain");
  assert.equal(stripLeadingPunct("无标点"), "无标点");
  assert.ok(LEADING_PUNCT.includes("，") && LEADING_PUNCT.includes("."));
});

test("translator：online 增量累积成快照，offline 定稿并剥行首标点", () => {
  // 复刻 Salon9 test_agent.py「real 12:58 live sequence」回放
  const tr = createAsrTranslator();
  assert.deepEqual(tr.push({ mode: "2pass-online", text: "我说" }), [{ type: "partial", seg: 0, text: "我说" }]);
  assert.deepEqual(tr.push({ mode: "2pass-online", text: "让我" }), [{ type: "partial", seg: 0, text: "我说让我" }]);
  assert.deepEqual(tr.push({ mode: "2pass-online", text: "测" }), [{ type: "partial", seg: 0, text: "我说让我测" }]);
  assert.deepEqual(tr.push({ mode: "2pass-online", text: "试一" }), [{ type: "partial", seg: 0, text: "我说让我测试一" }]);
  assert.deepEqual(tr.push({ mode: "2pass-offline", text: "，我说让我测试一下。" }), [{ type: "final", seg: 0, text: "我说让我测试一下。" }]);
  // 下一句从 seg 1 开始
  assert.deepEqual(tr.push({ mode: "2pass-online", text: "新的" }), [{ type: "partial", seg: 1, text: "新的" }]);
});

test("translator：offline 空文本回退累积；无文本控制帧忽略", () => {
  const tr = createAsrTranslator();
  tr.push({ mode: "2pass-online", text: "你好" });
  assert.deepEqual(tr.push({ mode: "2pass-offline", text: "，" }), [{ type: "final", seg: 0, text: "你好" }]);
  assert.deepEqual(tr.push({ mode: "2pass-offline", text: "" }), []);
  assert.deepEqual(tr.push({ some: "silence-echo" }), []);
});

test("translator：is_final=true 也是定稿边界（raw 全句优先）", () => {
  const tr = createAsrTranslator();
  tr.push({ mode: "2pass-online", text: "收尾" });
  assert.deepEqual(tr.push({ mode: "2pass-offline", text: "收尾句。", is_final: true }), [{ type: "final", seg: 0, text: "收尾句。" }]);
});

// ———— 鉴权与 Origin（gate 完成握手后用 error 帧回码，前端可读）————

test("鉴权失败 → error unauthorized + 关闭", async t => {
  const upstream = await startFakeUpstream(t);
  const { url } = await startGateway(t, upstream, { authenticate: () => { throw new Error("AUTH_REQUIRED"); } });
  const client = dial(url);
  const frame = await client.next(f => f.type === "error");
  assert.equal(frame.code, CODES.UNAUTHORIZED);
  assert.equal((await client.waitClosed()).code, 1008);
  client.close();
});

test("Origin 校验失败 → error unauthorized（与鉴权同码，不泄露差异）", async t => {
  const upstream = await startFakeUpstream(t);
  const { url } = await startGateway(t, upstream, { requestAllowed: () => false });
  const client = dial(url);
  assert.equal((await client.next(f => f.type === "error")).code, CODES.UNAUTHORIZED);
  client.close();
});

test("未注入鉴权时默认拒绝（fail closed）", async t => {
  const upstream = await startFakeUpstream(t);
  const { url } = await startGateway(t, upstream, { authenticate: undefined, requestAllowed: undefined });
  const client = dial(url);
  assert.equal((await client.next(f => f.type === "error")).code, CODES.UNAUTHORIZED);
  client.close();
});

// ———— 协议装配：start → config → PCM 透传 → partial/final → stop → end ——

test("start 触发 FunASR config 帧装配（2pass/[0,5,5]/chunk_interval 10/is_speaking）", async t => {
  const upstream = await startFakeUpstream(t);
  const { url } = await startGateway(t, upstream);
  const client = dial(url);
  client.json({ type: "start", sampleRate: VOICE_SAMPLE_RATE });
  const peer = await upstream.waitPeer();
  const config = peer.texts[0];
  assert.equal(config.mode, "2pass");
  assert.deepEqual(config.chunk_size, [0, 5, 5]);
  assert.equal(config.chunk_interval, 10);
  assert.equal(config.is_speaking, true);
  assert.equal(typeof config.wav_name, "string");
  assert.ok(config.wav_name.length > 0);
  assert.ok(!config.wav_name.includes("user"), "wav_name 不得携带用户信息");
  client.close();
});

test("二进制 PCM 帧原样透传上游（字节一致）", async t => {
  const upstream = await startFakeUpstream(t);
  const { url } = await startGateway(t, upstream);
  const client = dial(url);
  client.json({ type: "start", sampleRate: VOICE_SAMPLE_RATE });
  const peer = await upstream.waitPeer();
  const frame = pcm(1920); // 60ms @16k/16bit/mono
  client.send(frame);
  for (let i = 0; i < 200 && peer.binaries.length === 0; i++) await sleep(10);
  assert.equal(peer.binaries.length, 1);
  assert.deepEqual(peer.binaries[0], frame);
  client.close();
});

test("上游 partial/final 翻译下发（增量→累积、offline 定稿换 seg）", async t => {
  const upstream = await startFakeUpstream(t);
  const { url } = await startGateway(t, upstream);
  const client = dial(url);
  client.json({ type: "start", sampleRate: VOICE_SAMPLE_RATE });
  const peer = await upstream.waitPeer();
  peer.ws.send(JSON.stringify({ mode: "2pass-online", text: "明天" }));
  assert.deepEqual(await client.next(f => f.type === "partial"), { type: "partial", seg: 0, text: "明天" });
  peer.ws.send(JSON.stringify({ mode: "2pass-online", text: "下午" }));
  assert.deepEqual(await client.next(f => f.type === "partial" && f.text === "明天下午"), { type: "partial", seg: 0, text: "明天下午" });
  peer.ws.send(JSON.stringify({ mode: "2pass-offline", text: "，明天下午。" }));
  assert.deepEqual(await client.next(f => f.type === "final"), { type: "final", seg: 0, text: "明天下午。" });
  peer.ws.send(JSON.stringify({ mode: "2pass-online", text: "三点" }));
  assert.deepEqual(await client.next(f => f.type === "partial" && f.text === "三点"), { type: "partial", seg: 1, text: "三点" });
  client.close();
});

test("stop → 上游收 {is_speaking:false}，尾句 final 后下发 end 并正常关闭（1000）", async t => {
  const upstream = await startFakeUpstream(t);
  const { url } = await startGateway(t, upstream, { finalDrainMs: 250 });
  const client = dial(url);
  client.json({ type: "start", sampleRate: VOICE_SAMPLE_RATE });
  const peer = await upstream.waitPeer();
  peer.ws.send(JSON.stringify({ mode: "2pass-online", text: "收尾" }));
  await client.next(f => f.type === "partial");
  client.json({ type: "stop" });
  for (let i = 0; i < 200 && !peer.texts.some(m => m.is_speaking === false); i++) await sleep(10);
  assert.ok(peer.texts.some(m => m.is_speaking === false), "上游应收到 is_speaking:false");
  peer.ws.send(JSON.stringify({ mode: "2pass-offline", text: "收尾。" }));
  assert.deepEqual(await client.next(f => f.type === "final"), { type: "final", seg: 0, text: "收尾。" });
  assert.deepEqual(await client.next(f => f.type === "end"), { type: "end" });
  assert.equal((await client.waitClosed()).code, 1000);
});

test("stop 后晚到/连发的 offline final 不丢：is_final 帧到达即收尾 end（不等满兜底窗）", async t => {
  const upstream = await startFakeUpstream(t);
  const { url } = await startGateway(t, upstream); // 默认 finalDrainMs=5000（实测还会按音频时长伸缩）
  const client = dial(url);
  client.json({ type: "start", sampleRate: VOICE_SAMPLE_RATE });
  const peer = await upstream.waitPeer();
  peer.ws.send(JSON.stringify({ mode: "2pass-online", text: "第一句" }));
  await client.next(f => f.type === "partial");
  client.json({ type: "stop" });
  for (let i = 0; i < 200 && !peer.texts.some(m => m.is_speaking === false); i++) await sleep(10);
  // 尾句 final 在 stop 后 +300ms 才到（旧实现固定 2500ms 计时器与贴线 final 竞态 3/3 全丢），
  // +800ms 再到带 is_final 的收尾帧（真实 FunASR 即此形态：尾句 final 与 is_final 同帧）
  setTimeout(() => { try { peer.ws.send(JSON.stringify({ mode: "2pass-offline", text: "，第一句定稿。" })); } catch {} }, 300);
  setTimeout(() => { try { peer.ws.send(JSON.stringify({ mode: "2pass-offline", text: "第二句定稿。", is_final: true })); } catch {} }, 800);
  assert.deepEqual(await client.next(f => f.type === "final" && f.text === "第一句定稿。"), { type: "final", seg: 0, text: "第一句定稿。" });
  assert.deepEqual(await client.next(f => f.type === "final" && f.text === "第二句定稿。"), { type: "final", seg: 1, text: "第二句定稿。" });
  const afterIsFinal = Date.now();
  await client.next(f => f.type === "end");
  const settleMs = Date.now() - afterIsFinal;
  assert.ok(settleMs <= 1500, `is_final 到达后应立即收尾（实测 ${settleMs}ms），而非等满兜底窗`);
  assert.equal((await client.waitClosed()).code, 1000);
  client.close();
});

test("stop 在 start 之前 → 直接 end 关闭（不连上游）", async t => {
  const upstream = await startFakeUpstream(t);
  const { url } = await startGateway(t, upstream);
  const client = dial(url);
  client.json({ type: "stop" });
  assert.deepEqual(await client.next(f => f.type === "end"), { type: "end" });
  await client.waitClosed();
  assert.equal(upstream.peers.length, 0, "不应连接上游");
});

// ———— 客户端协议违规 → bad-message ——

test("start 前/非 JSON/未知类型/双 start/非 16k 采样率 → bad-message", async t => {
  const upstream = await startFakeUpstream(t);
  const { url } = await startGateway(t, upstream);
  const bad = async send => {
    const client = dial(url);
    send(client);
    const frame = await client.next(f => f.type === "error");
    assert.equal(frame.code, CODES.BAD_MESSAGE);
    await client.waitClosed();
  };
  await bad(c => c.send(pcm(64)));                                        // start 前发二进制
  await bad(c => c.send("not-json{"));                                    // 非 JSON
  await bad(c => c.json({ type: "pause" }));                              // 未知类型
  await bad(c => { c.json({ type: "start", sampleRate: 48000 }); });      // 非 16k
  const upstream2 = await startFakeUpstream(t); // 双 start 需要独立网关会话
  const g2 = await startGateway(t, upstream2);
  const c2 = dial(g2.url);
  c2.json({ type: "start", sampleRate: VOICE_SAMPLE_RATE });
  await upstream2.waitPeer();
  c2.json({ type: "start", sampleRate: VOICE_SAMPLE_RATE });
  assert.equal((await c2.next(f => f.type === "error")).code, CODES.BAD_MESSAGE);
  c2.close();
});

// ———— 上游故障 → asr-unavailable ——

test("上游连不上 → start 后 error asr-unavailable", async t => {
  const upstream = { url: "ws://127.0.0.1:9", peers: [] }; // 端口 9：连接拒绝
  const { url } = await startGateway(t, upstream, { asrConnectTimeoutMs: 1500 });
  const client = dial(url);
  client.json({ type: "start", sampleRate: VOICE_SAMPLE_RATE });
  assert.equal((await client.next(f => f.type === "error", 6000)).code, CODES.ASR_UNAVAILABLE);
  client.close();
});

test("上游中途断开 → error asr-unavailable", async t => {
  const upstream = await startFakeUpstream(t);
  const { url } = await startGateway(t, upstream);
  const client = dial(url);
  client.json({ type: "start", sampleRate: VOICE_SAMPLE_RATE });
  const peer = await upstream.waitPeer();
  peer.ws.close();
  assert.equal((await client.next(f => f.type === "error")).code, CODES.ASR_UNAVAILABLE);
  client.close();
});

// ———— 限额 ——

test("并发第 4 路 → error busy", async t => {
  const upstream = await startFakeUpstream(t);
  const { url } = await startGateway(t, upstream);
  const hold = [];
  for (let i = 0; i < 3; i++) {
    const c = dial(url);
    await new Promise(resolve => c.ws.once("open", resolve));
    hold.push(c);
  }
  await sleep(150); // 等 3 路握手完成占用并发额度
  const fourth = dial(url);
  assert.equal((await fourth.next(f => f.type === "error")).code, CODES.BUSY);
  for (const c of hold) c.close();
  fourth.close();
});

test("单次超时 → error session-too-long（上限可注入缩短）", async t => {
  const upstream = await startFakeUpstream(t);
  const { url } = await startGateway(t, upstream, { limits: { sessionMaxMs: 150, dailyBudgetMs: 60_000, maxConcurrent: 3 } });
  const client = dial(url);
  client.json({ type: "start", sampleRate: VOICE_SAMPLE_RATE });
  await upstream.waitPeer();
  const started = Date.now();
  assert.equal((await client.next(f => f.type === "error", 5000)).code, CODES.SESSION_TOO_LONG);
  assert.ok(Date.now() - started < 3000, "应在毫秒级上限处触发，而非 60s");
  await client.waitClosed();
});

test("每日预算耗尽 → error daily-limit；剩余预算收窄单次上限", async t => {
  const upstream = await startFakeUpstream(t);
  const { url } = await startGateway(t, upstream, { finalDrainMs: 200, limits: { sessionMaxMs: 60_000, dailyBudgetMs: 1600, maxConcurrent: 3 } });
  const first = dial(url);
  first.json({ type: "start", sampleRate: VOICE_SAMPLE_RATE });
  await upstream.waitPeer();
  await sleep(450); // 消耗 ~450ms + drain 200ms
  first.json({ type: "stop" });
  await first.next(f => f.type === "end");
  first.close();
  // 第二次：剩余 ~250ms < 60s → 会话上限收窄为剩余值，应得 session-too-long
  const second = dial(url);
  second.json({ type: "start", sampleRate: VOICE_SAMPLE_RATE });
  await upstream.waitPeer();
  const frame = await second.next(f => f.type === "error", 5000);
  assert.ok([CODES.SESSION_TOO_LONG, CODES.DAILY_LIMIT].includes(frame.code), "剩余预算耗尽应触发会话上限或每日上限，got " + frame.code);
  second.close();
  // 第三次：预算已尽 → daily-limit
  const third = dial(url);
  third.json({ type: "start", sampleRate: VOICE_SAMPLE_RATE });
  const frame3 = await third.next(f => f.type === "error", 5000);
  assert.equal(frame3.code, CODES.DAILY_LIMIT);
  third.close();
});

test("音频字节数超过会话时长上限（突发发送）→ session-too-long", async t => {
  const upstream = await startFakeUpstream(t);
  const { url } = await startGateway(t, upstream, { limits: { sessionMaxMs: 500, dailyBudgetMs: 60_000, maxConcurrent: 3 } });
  const client = dial(url);
  client.json({ type: "start", sampleRate: VOICE_SAMPLE_RATE });
  await upstream.waitPeer();
  client.send(pcm(32000 * 2)); // 2 秒音频一次性突发（>500ms 上限）
  assert.equal((await client.next(f => f.type === "error", 5000)).code, CODES.SESSION_TOO_LONG);
  client.close();
});

// ———— 挂载与路由 ——

test("attach：非语音路径的 upgrade 被销毁（唯一 upgrade 监听者时）", async t => {
  const upstream = await startFakeUpstream(t);
  const { server } = await startGateway(t, upstream);
  // WS key 运行期构造：源码不留 base64 字面量（gitleaks generic-api-key 会误报）
  const wsKey = Buffer.from("voice-gateway-path-test").toString("base64");
  const result = await new Promise(resolve => {
    const req = request({
      host: "127.0.0.1", port: server.address().port, path: "/api/other",
      headers: { Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Key": wsKey, "Sec-WebSocket-Version": "13" },
    });
    req.on("upgrade", () => resolve("upgraded"));
    req.on("error", () => resolve("destroyed"));
    req.end();
  });
  assert.equal(result, "destroyed");
});

test("usage() 只含计数不含转写内容（隐私：仅时长与码）", async t => {
  const upstream = await startFakeUpstream(t);
  const { url, gateway } = await startGateway(t, upstream);
  const client = dial(url);
  client.json({ type: "start", sampleRate: VOICE_SAMPLE_RATE });
  const peer = await upstream.waitPeer();
  peer.ws.send(JSON.stringify({ mode: "2pass-online", text: "绝密内容不应出现在台账" }));
  await client.next(f => f.type === "partial");
  const dump = JSON.stringify(gateway.usage());
  assert.ok(!dump.includes("绝密"), "usage 台账不得包含转写文本");
  assert.equal(gateway.usage().active >= 1, true);
  client.close();
});
